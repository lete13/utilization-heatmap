# AGENTS.md

## Cursor Cloud specific instructions

This repo is a **single Node.js/Express app** (`elysian-clearing`) — a property-management / "clearing" automation tool for Elysian Properties. There is one deployable unit at the repo root: an Express server (`server.js`) that also serves a large single-file SPA (`index.html`). See `README.md`, `DEPLOY.md`, and `env.example` for product/deploy context; only the non-obvious runtime notes are captured here.

### Services

| Service | Required | How to run | Notes |
| --- | --- | --- | --- |
| App server (Express) | Yes | `npm run dev` (alias of `npm start` → `node srv-boot.js`) | Listens on `PORT` (default `3000`). No separate build step; `dev` and `start` are identical. |
| PostgreSQL 16 | Yes for persistence | `sudo pg_ctlcluster 16 main start` | Not started automatically on VM boot — start it each session before running the app. Local dev DB/role: `elysian` / `elysian`. |

Optional third-party integrations (Hosthub, SMTP, Oxygen e-invoicing, Viva Wallet, Anthropic) are configured purely via env vars; when unset their `/api/*` endpoints return "not configured" and the rest of the app works.

### Running locally

The server reads config from real environment variables (there is **no** `dotenv` / `.env` auto-loading), so export them inline:

```bash
sudo pg_ctlcluster 16 main start
DATABASE_URL="postgresql://elysian:elysian@localhost:5432/elysian" \
APP_PASSWORD="elysian2025" PORT=3000 npm run dev
```

Tables (`app_data`, `proof_files`, `oxygen_documents`) are auto-created on first connect — no migration step.

When `APP_PASSWORD` is set the whole app is behind HTTP Basic Auth with an **empty username**. Easiest way to hit it from a browser or curl: `http://:elysian2025@localhost:3000/` (or `curl -u :elysian2025 ...`).

### Boot / patch mechanism (non-obvious)

`srv-boot.js` applies the ordered `srv/patches*.json` chain to `server.js` at boot, writing the result to `server.gen.js` (git-ignored) and running that. `feBootstrap()` in `server.js` similarly applies `fe/patches*.json` to `index.html`. Both are **all-or-nothing with SHA gating**: on any hash/anchor mismatch they log the reason and fall back to the unpatched file, so the app never crashes on a bad patch set. `GET /api/fe-info` reports what frontend is live.

- **Known pre-existing inconsistency:** the committed `index.html` does **not** match the base that `fe/patches.json` expects, so the frontend patches are skipped and the app serves the unpatched `index.html`. Because of this, `npm test` (`tests/monthly-close-patches.test.js`, which asserts the fe patch chain against `index.html`) currently **fails on a base-SHA mismatch**. This is a committed-repo authoring issue, not an environment problem — do not "fix" it by editing files unless that is the actual task. The server-side `srv/patches*.json` chain, by contrast, applies cleanly (15 patches).

### Testing UI → DB persistence (non-obvious)

The SPA only writes to Postgres after it has first *loaded* a row: `loadFromDb()` returns early when the `app_data` `main` row is absent, leaving `_dataInitialized=false`, which makes the debounced `saveToDb()` a no-op. In production the first row is created by a Hosthub sync. So editing data in the UI against an **empty** DB updates client state only and will not persist. To exercise the UI→DB round-trip locally, first seed a row, e.g.:

```bash
curl -u :elysian2025 -H 'Content-Type: application/json' -X POST \
  http://localhost:3000/api/db/data -d '{"bks":[],"exps":[],"apts":[]}'
```

The server DB layer itself is easy to verify directly via `POST`/`GET /api/db/data` and `GET /api/db/status`.
