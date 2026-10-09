import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

let child, base, tempDir, bootLog = '';
async function availablePort() {
  const socket = createServer(); await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function request(path, { cookie, ...options } = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) } });
  const data = response.status === 204 ? {} : await response.json();
  const setCookie = response.headers.get('set-cookie');
  return { status: response.status, data, cookie: setCookie?.split(';')[0] };
}
const jsonBody = value => JSON.stringify(value);

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'taskflow-test-')); const port = await availablePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(tempDir, 'test.sqlite'), NODE_ENV: 'test', SESSION_SECRET: 'test-secret-with-at-least-32-characters' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { bootLog += chunk; }); child.stderr.on('data', chunk => { bootLog += chunk; });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before startup: ${bootLog}`);
    try { const response = await fetch(`${base}/api/health`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${bootLog}`);
});
after(async () => { if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } if (tempDir) await rm(tempDir, { recursive: true, force: true }); });

test('health and static app are served with security headers', async () => {
  assert.equal((await request('/api/health')).data.status, 'ok');
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200); assert.equal((await fetch(`${base}/secret.txt`)).status, 404);
});

test('accounts are isolated and task workflows persist through the API', async () => {
  const alice = await request('/api/auth/register', { method: 'POST', body: jsonBody({ email: 'ALICE@example.com', password: 'correct-horse-battery' }) });
  assert.equal(alice.status, 201); assert.match(alice.cookie, /^taskflow_session=/);
  assert.equal((await request('/api/tasks')).status, 401);
  const invalid = await request('/api/tasks', { method: 'POST', cookie: alice.cookie, body: jsonBody({ title: '  ', priority: 'urgent' }) }); assert.equal(invalid.status, 400);
  const invalidDate = await request('/api/tasks', { method: 'POST', cookie: alice.cookie, body: jsonBody({ title: 'Bad date', dueDate: '2026-02-30' }) }); assert.equal(invalidDate.status, 400);
  const created = await request('/api/tasks', { method: 'POST', cookie: alice.cookie, body: jsonBody({ title: 'Ship onboarding', notes: 'Review copy', category: 'Work', priority: 'high', dueDate: '2026-10-10' }) });
  assert.equal(created.status, 201); assert.equal(created.data.task.title, 'Ship onboarding');
  const id = created.data.task.id;
  const edited = await request(`/api/tasks/${id}`, { method: 'PATCH', cookie: alice.cookie, body: jsonBody({ title: 'Ship onboarding flow', notes: 'Final review', category: 'Work', priority: 'medium', dueDate: null }) });
  assert.equal(edited.data.task.title, 'Ship onboarding flow'); assert.equal(edited.data.task.priority, 'medium');
  const completed = await request(`/api/tasks/${id}`, { method: 'PATCH', cookie: alice.cookie, body: jsonBody({ completed: true }) }); assert.equal(completed.data.task.completed, 1);
  const bob = await request('/api/auth/register', { method: 'POST', body: jsonBody({ email: 'bob@example.com', password: 'correct-horse-battery' }) });
  assert.equal((await request('/api/tasks', { cookie: bob.cookie })).data.tasks.length, 0);
  assert.equal((await request(`/api/tasks/${id}`, { method: 'DELETE', cookie: bob.cookie })).status, 404);
  assert.deepEqual((await request('/api/tasks/completed', { method: 'DELETE', cookie: alice.cookie })).data, { deleted: 1 });
  const again = await request('/api/auth/login', { method: 'POST', body: jsonBody({ email: 'alice@example.com', password: 'correct-horse-battery' }) });
  assert.equal((await request('/api/tasks', { cookie: again.cookie })).data.tasks.length, 0);
  assert.equal((await request('/api/auth/logout', { method: 'POST', cookie: again.cookie, body: '{}' })).status, 200);
  assert.equal((await request('/api/tasks', { cookie: again.cookie })).status, 401);
});

test('rejects hostile origins and weak registration passwords', async () => {
  const weak = await request('/api/auth/register', { method: 'POST', body: jsonBody({ email: 'weak@example.com', password: 'short' }) }); assert.equal(weak.status, 400);
  const wrong = await request('/api/auth/login', { method: 'POST', body: jsonBody({ email: 'not-found@example.com', password: 'correct-horse-battery' }) }); assert.deepEqual(wrong.data, { error: 'Email or password is incorrect.' });
  const hostile = await request('/api/auth/register', { method: 'POST', headers: { Origin: 'https://attacker.invalid' }, body: jsonBody({ email: 'cross@example.com', password: 'correct-horse-battery' }) }); assert.equal(hostile.status, 403);
});
