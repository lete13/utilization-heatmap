# AGENTS.md

## Cursor Cloud specific instructions

This repository (`lete13/utilization-heatmap`) is a **sandbox mirror** of [`lete13/elysian-clearing`](https://github.com/lete13/elysian-clearing) `main`. Use it for experiments, Cloud Agent work, and PRs **without** changing production `elysian-clearing` until you intentionally promote changes.

### Workflow

- **Develop here** → commit/push to `utilization-heatmap` (use **feature branches** for experiments; `main` is auto-synced from upstream)
- **Promote to production** → cherry-pick or open a PR from heatmap into `elysian-clearing`, or manually port the diff

### Auto-sync from `elysian-clearing` main

Upstream changes arrive as a **reviewable pull request**, never as a force-push. `.github/workflows/sync-from-elysian-clearing.yml`:

- **Every 10 minutes** — if [`lete13/elysian-clearing`](https://github.com/lete13/elysian-clearing) `main` is not already contained in this repo's `main`, it force-updates the `sync/elysian-clearing` branch to upstream `main` and opens (or refreshes) a PR into `main`
- **Manual** — Actions → “Sync from elysian-clearing” → Run workflow
- **Instant (optional)** — add `docs/elysian-clearing-sync-trigger.yml.example` to `elysian-clearing` with a `HEATMAP_SYNC_TOKEN` secret

The job **never writes to `main`**, so sandbox-only work committed here is safe. Merge the sync PR when you want upstream changes; a file changed both upstream and here (e.g. `fe/daily-ops-beta.js`) surfaces as a normal merge conflict instead of being silently discarded.

Because of this, committing sandbox work to `main` is safe. `sync/elysian-clearing` is machine-managed — never commit to it.

### Running locally (single Node/Express app + PostgreSQL)

```bash
sudo pg_ctlcluster 16 main start
DATABASE_URL="postgresql://elysian:elysian@localhost:5432/elysian" \
APP_PASSWORD="elysian2025" \
HOSTHUB_API_KEY="local-dev" \
PORT=3000 npm run dev
```

- Listens on `http://localhost:3000` (view via **Desktop** pane, not your local machine browser).
- HTTP Basic Auth: **empty username**, password from `APP_PASSWORD`.
- Tables auto-create on first DB connect; no migrations.

### Boot / patches

- `npm start` / `npm run dev` → `node srv-boot.js` applies `srv/patches*.json` → `server.gen.js`, then serves `index.html` with `fe/patches*.json` applied at boot.
- `npm test` validates the full FE + server patch chains (should pass on a clean mirror).

### Deploy note

Upstream `elysian-clearing` deploys via **Docker** (`Dockerfile`, `scripts/docker-start.sh`). This sandbox can still be run with `npm run dev` for local/agent testing.
