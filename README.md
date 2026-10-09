# TaskFlow

A focused task manager built with a dependency-light Node.js server, SQLite persistence, and a responsive browser interface. Each account has a private workspace with searchable tasks, categories, priorities, due dates, notes, completion, editing, and deletion.

## Requirements

- Node.js 22.13 or newer (Node 24 recommended). The built-in `node:sqlite` module is used; no native add-on or database service is required.
- npm (included with Node.js).

## Run locally

```sh
npm start
```

Open [http://localhost:3000](http://localhost:3000). Use `npm run dev` to restart the server when server files change. `npm test` runs the API and persistence integration checks.

## Configuration

Copy `.env.example` to `.env` and set these variables in your process environment (Node does not automatically load `.env` files):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Listen address; use `0.0.0.0` in a container |
| `DATABASE_PATH` | `./data/taskflow.sqlite` | SQLite database path, relative to the project root unless absolute |
| `NODE_ENV` | `development` | Set to `production` to enable Secure cookies and generic internal error responses |

The database directory is created on first run. SQLite creates and applies the schema automatically; schema changes use additive `CREATE TABLE/INDEX IF NOT EXISTS` statements in `server.mjs`. Back up the database file together with its WAL files while the server is stopped, or use SQLite's online backup facilities.

## Deployment

Run behind a TLS terminating reverse proxy, set `NODE_ENV=production`, configure a persistent writable volume for `DATABASE_PATH`, and set `HOST=0.0.0.0` when required by the platform. Allow only same-origin browser requests; the app intentionally does not enable cross-origin credentialed access. Preserve the database volume during restarts and deployments. Use a process manager or platform health checks against `/api/health`. For multiple app instances, place them on a shared database service with concurrency guarantees before scaling horizontally; local SQLite is intended for a single instance.

## Security and product notes

Passwords are hashed with Node's scrypt and per-user random salts. Session identifiers are cryptographically random, stored as SHA-256 hashes, sent in HttpOnly, SameSite=Strict cookies, and expire after 30 days. Task queries are always scoped to the signed-in user. Mutating API requests validate their same-origin header; the server validates task fields and body sizes. Responses use a restrictive Content Security Policy and other browser security headers. Authentication attempts are rate limited in process memory, so use an edge or reverse-proxy rate limit for production deployments. Configure HTTPS at the proxy so production Secure cookies work.

Theme choice is stored locally in the browser. Account data, including tasks, persists in the SQLite database. The product currently has no password reset, email verification, team sharing, or distributed session store.
