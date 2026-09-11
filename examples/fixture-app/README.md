# @harness/fixture-app

A deliberately tiny "Projects" web application, used as the **target** of the agent-driven E2E
harness. It is server-rendered plain HTML plus one inline `<script>`; there is no client build step
and **zero runtime dependencies** (Node built-ins only).

The app exists so scenarios can be run against a known, reproducible reality: one healthy build and
three defect/shape variants that a browsing agent has to tell apart.

## Running it

```bash
pnpm --filter @harness/fixture-app build
node dist/main.js --port 3000 --variant healthy --seed
```

CLI flags: `--port N` (default 0 → ephemeral), `--variant <variant>`, `--persist-dir DIR`,
`--seed` (create a demo workspace/user/session at boot and print the credentials),
`--seed-email E` / `--seed-password P` (fixed demo credentials instead of random ones — what a
scenario that signs in through the UI needs, since it has to write them in its own text; they imply
`--seed`), `--no-seed-endpoints` (disable the test-only endpoints entirely).

The server **always binds 127.0.0.1 only** — never `0.0.0.0`.

## Programmatic API

```ts
import { startFixtureApp } from "@harness/fixture-app";

const app = await startFixtureApp({ variant: "false-success" }); // port defaults to 0
// app.url   -> "http://127.0.0.1:<real bound port>"
// app.port  -> the real port (safe for parallel tests)
// app.seedToken -> value for the `x-seed-token` header
const seed = await app.seedWorkspace({ workspaceName: "Acme" });
const probe = await app.probeProjects({ workspaceId: seed.workspaceId, name: "Roadmap" });
await app.close();
```

`FixtureAppOptions`: `port`, `variant`, `seed` (a workspace created before the first request),
`seedEnabled` (default `true`), `seedToken` (random hex when omitted), `persistDir`.

## Data model and persistence

```
Workspace { id, name, createdAt }
User      { id, email, workspaceId, passwordHash }
Session   { token, userId }
Project   { id, workspaceId, name, createdAt }
```

Projects are scoped to a workspace; a signed-in user only ever sees their own workspace's projects.
State lives **server-side** — in memory per process by default, so it survives a browser reload,
which is exactly what the persistence criterion checks. Pass `persistDir` to additionally mirror the
whole store to `<persistDir>/fixture-app-store.json` after every mutation (it is reloaded on start).

`User.passwordHash` is an addition to the model in the brief; it is needed for the login page to
work at all. Passwords are scrypt-hashed with a per-user salt.

## Auth

A session cookie named `sid`. Unauthenticated `GET /` renders a login page (email + password,
`POST /login`), so a scenario without a fixture can log in through the UI. `GET /logout` clears the
session. Fixtures normally skip the UI: seed a workspace, then set the `sid` cookie on the browser
context.

## Pages and routes

| Route | Notes |
| --- | --- |
| `GET /` | Login page when unauthenticated; workspace home when authenticated. |
| `POST /login` | Form-encoded `email` + `password`; sets `sid`; 401 + error alert on failure. |
| `GET /logout` | Clears the session. |
| `GET /api/projects` | `{ projects: [...] }` for the caller's workspace. 401 if signed out. |
| `POST /api/projects` | `{ name }` → `201` + the project. 400 on empty name, 401 if signed out. |

The home page's create form submits with `fetch` and appends the new project to the list
**client-side, without a full reload** — that is what makes the `false-success` variant meaningful.

Accessible markup is deliberate, because a model navigates by role + name: an `<h1>`, `<label for>`
on every input, real `<button>`s, the workspace name in `#workspace-name`, and a list with a stable
role.

## Variants

Selected per server instance by the `variant` option, or by the `FIXTURE_APP_VARIANT` environment
variable. **Precedence:** explicit option → env var → `"healthy"`. An unknown env value throws
instead of silently falling back.

| Variant | Behaviour |
| --- | --- |
| `healthy` | Everything works. Create persists, reload shows it, exactly one entry. |
| `create-500` | `POST /api/projects` always answers `500` with `{ error: { code, message } }`. Nothing is persisted; the page shows an error alert quoting the HTTP status. |
| `false-success` | `POST /api/projects` answers `201` with a plausible project object that is **never** written to the store. The UI appends it optimistically, so it is indistinguishable from `healthy` until the page is reloaded — after which the project is gone. |
| `alt-layout` | Functionally identical to `healthy`, different shape: the form lives behind a "New project" toggle that reveals a dialog, the list is a `<table>` instead of a `<ul>`, and the wording changes ("Name of the project" / "Add project"). No defect. |

## Test-only endpoints (guarded)

Both endpoints require the header `x-seed-token`, whose value is generated per server instance and
returned as `handle.seedToken` (and printed by the CLI). They are only mounted when the app was
started with `seedEnabled: true` (the default); with `seedEnabled: false` they answer `404`. A wrong
or missing token answers `403`. They are **not** an open door, and they are never linked from, or
mentioned in, any served HTML.

### `POST /__seed/workspace`

Creates an isolated workspace + user + session without going through the UI. Optional JSON body:
`{ workspaceName?, email?, password?, projects?: string[] }`. Returns:

```json
{ "workspaceId": "...", "workspaceName": "...", "userId": "...",
  "email": "...", "password": "...", "sessionToken": "..." }
```

### `GET /__probe/projects?workspaceId=...&name=...`

**Reserved for the optional TS check — the browser agent must never use it.** It reads the
authoritative server-side store and is the only way to prove "exactly one project persisted", which
a paginated or filtered UI list cannot establish. Returns `{ count, projects: [...] }`.
`name` is optional and matches exactly.
