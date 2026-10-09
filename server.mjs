import http from 'node:http';
import { randomBytes, createHash, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCb);
const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const isProduction = process.env.NODE_ENV === 'production';
const dbPath = resolve(root, process.env.DATABASE_PATH || './data/taskflow.sqlite');
const dummyPasswordSalt = randomBytes(16).toString('hex');
const dummyPasswordDigest = Buffer.from(await scrypt('invalid-password-check', dummyPasswordSalt, 64));
await mkdir(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Personal', priority TEXT NOT NULL DEFAULT 'medium', due_date TEXT, completed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_user_created ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);`);
const getUser = db.prepare('SELECT id, email FROM users WHERE id = ?');
const getSession = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?');
const taskList = db.prepare('SELECT id, title, notes, category, priority, due_date AS dueDate, completed, created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE user_id = ? ORDER BY completed ASC, CASE priority WHEN \'high\' THEN 0 WHEN \'medium\' THEN 1 ELSE 2 END, due_date IS NULL, due_date ASC, created_at DESC');
const taskById = db.prepare('SELECT id, title, notes, category, priority, due_date AS dueDate, completed, created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE id = ? AND user_id = ?');
const insertTask = db.prepare('INSERT INTO tasks (id,user_id,title,notes,category,priority,due_date,completed,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
const updateTask = db.prepare('UPDATE tasks SET title=?, notes=?, category=?, priority=?, due_date=?, updated_at=? WHERE id=? AND user_id=?');
const removeTask = db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers }); res.end(JSON.stringify(data)); };
const parseCookie = (header = '') => Object.fromEntries(header.split(';').map(part => { const i = part.indexOf('='); return i < 0 ? ['', ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())]; }));
const hashToken = token => createHash('sha256').update(token).digest('hex');
async function currentUser(req) {
  const token = parseCookie(req.headers.cookie).taskflow_session;
  if (!token) return null;
  const userId = getSession.get(await hashToken(token), Date.now())?.user_id;
  return userId ? getUser.get(userId) : null;
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 20_000) throw new HttpError(413, 'Request body is too large.'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Request must contain valid JSON.'); }
}
function validateTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Provide task details.');
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const notes = typeof value.notes === 'string' ? value.notes.trim() : '';
  const category = typeof value.category === 'string' ? value.category.trim() : 'Personal';
  const priority = value.priority ?? 'medium';
  const dueDate = value.dueDate || null;
  if (!title || title.length > 180) throw new HttpError(400, 'Task title must be between 1 and 180 characters.');
  if (notes.length > 2000) throw new HttpError(400, 'Notes must be 2,000 characters or fewer.');
  if (!category || category.length > 40) throw new HttpError(400, 'Category must be between 1 and 40 characters.');
  if (!['low', 'medium', 'high'].includes(priority)) throw new HttpError(400, 'Choose a valid priority.');
  if (dueDate !== null && (typeof dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`)) || new Date(`${dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== dueDate)) throw new HttpError(400, 'Choose a valid due date.');
  return { title, notes, category, priority, dueDate };
}
function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    const hostHeader = req.headers.host;
    if (!hostHeader || new URL(origin).host !== hostHeader) throw new HttpError(403, 'Request origin is not allowed.');
  }
}
const cookie = token => `taskflow_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${isProduction ? '; Secure' : ''}`;
const clearCookie = `taskflow_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isProduction ? '; Secure' : ''}`;
const authThrottle = new Map();
function throttleAuth(req) {
  const key = req.socket.remoteAddress || 'unknown'; const now = Date.now();
  const state = authThrottle.get(key) || { count: 0, started: now };
  if (now - state.started > 15 * 60_000) { state.count = 0; state.started = now; }
  state.count++; authThrottle.set(key, state);
  if (state.count > 30) throw new HttpError(429, 'Too many account attempts. Please try again in a few minutes.');
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
  if (url.pathname.startsWith('/api/')) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) requireSameOrigin(req);
    if (req.method === 'OPTIONS') { res.writeHead(204, { Allow: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' }); return res.end(); }
    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      throttleAuth(req);
      const input = await body(req); const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const password = typeof input.password === 'string' ? input.password : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
      if (password.length < 10 || password.length > 128) throw new HttpError(400, 'Password must be 10 to 128 characters.');
      if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw new HttpError(409, 'An account with this email already exists.');
      const id = randomBytes(16).toString('hex'); const salt = randomBytes(16).toString('hex');
      const digest = await scrypt(password, salt, 64); const now = new Date().toISOString();
      db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, email, `${salt}:${Buffer.from(digest).toString('hex')}`, now);
      const token = randomBytes(32).toString('base64url'); const expires = Date.now() + 30 * 86400_000;
      db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(await hashToken(token), id, expires);
      return json(res, 201, { user: { id, email } }, { 'Set-Cookie': cookie(token) });
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      throttleAuth(req);
      const input = await body(req); const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const password = typeof input.password === 'string' ? input.password : '';
      const record = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      const [salt, expectedHex] = record ? record.password_hash.split(':') : [dummyPasswordSalt, null];
      const actual = Buffer.from(await scrypt(password, salt, 64)); const expected = expectedHex ? Buffer.from(expectedHex, 'hex') : dummyPasswordDigest;
      if (!record || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'Email or password is incorrect.');
      const token = randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(await hashToken(token), record.id, Date.now() + 30 * 86400_000);
      return json(res, 200, { user: { id: record.id, email: record.email } }, { 'Set-Cookie': cookie(token) });
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = parseCookie(req.headers.cookie).taskflow_session;
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(await hashToken(token));
      return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
    }
    if (url.pathname === '/api/auth/me' && req.method === 'GET') return json(res, 200, { user: await currentUser(req) });
    const user = await currentUser(req);
    if (!user) throw new HttpError(401, 'Sign in to access your tasks.');
    if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, { tasks: taskList.all(user.id) });
    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const task = validateTask(await body(req)); const id = randomBytes(16).toString('hex'); const now = new Date().toISOString();
      insertTask.run(id, user.id, task.title, task.notes, task.category, task.priority, task.dueDate, 0, now, now);
      return json(res, 201, { task: taskById.get(id, user.id) });
    }
    if (url.pathname === '/api/tasks/completed' && req.method === 'DELETE') {
      const result = db.prepare('DELETE FROM tasks WHERE user_id=? AND completed=1').run(user.id);
      return json(res, 200, { deleted: result.changes });
    }
    const match = url.pathname.match(/^\/api\/tasks\/([a-f\d]{32})$/);
    if (match && req.method === 'PATCH') {
      const prior = taskById.get(match[1], user.id); if (!prior) throw new HttpError(404, 'Task not found.');
      const input = await body(req);
      if (typeof input.completed === 'boolean' && Object.keys(input).length === 1) {
        db.prepare('UPDATE tasks SET completed=?,updated_at=? WHERE id=? AND user_id=?').run(Number(input.completed), new Date().toISOString(), match[1], user.id);
      } else {
        const task = validateTask(input); updateTask.run(task.title, task.notes, task.category, task.priority, task.dueDate, new Date().toISOString(), match[1], user.id);
      }
      return json(res, 200, { task: taskById.get(match[1], user.id) });
    }
    if (match && req.method === 'DELETE') {
      const result = removeTask.run(match[1], user.id); if (!result.changes) throw new HttpError(404, 'Task not found.');
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'API route not found.');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  const pathname = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!['index.html', 'app.js'].includes(pathname)) throw new HttpError(404, 'Page not found.');
  const page = await readFile(resolve(root, pathname));
  const script = pathname.endsWith('.js');
  res.writeHead(200, { 'Content-Type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': script ? 'public, max-age=300' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" });
  res.end(page);
}

const server = http.createServer(async (req, res) => {
  try { await handle(req, res); }
  catch (error) {
    if (res.headersSent) { res.destroy(error); return; }
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(JSON.stringify({ level: 'error', message: error.message, path: req.url, time: new Date().toISOString() }));
    json(res, status, { error: status === 500 && isProduction ? 'Something went wrong. Please try again.' : error.message });
  }
});
server.listen(port, host, () => console.log(`TaskFlow listening on http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => { db.close(); process.exit(0); }); });
