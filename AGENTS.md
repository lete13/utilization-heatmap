# AGENTS.md

## Cursor Cloud specific instructions

This repository (`lete13/utilization-heatmap`) is a **sandbox mirror** of [`lete13/elysian-clearing`](https://github.com/lete13/elysian-clearing) `main`. Use it for experiments, Cloud Agent work, and PRs **without** changing production `elysian-clearing` until you intentionally promote changes.

### Workflow

**Never push to `lete13/elysian-clearing`.** That repo is production and is strictly read-only for agents: fetch from it, never write to it. Promoting work there is the owner's decision, done manually.

Within this sandbox repo, working on a feature branch (e.g. `cursor/my-change-5c94`) and **merging into `utilization-heatmap` `main` is allowed**.

- **Develop here** → feature branch → PR → merge into heatmap `main`
- **Promote to production** → the owner ports the diff to `elysian-clearing`; agents do not push there

### Sync from `elysian-clearing` main — SUSPENDED (manual only)

**No automation runs on its own in this repo.** The sync job used to run every 10 minutes (and on an upstream `repository_dispatch`), which meant continuous automated branch pushes and pull requests under the owner's account. Both automatic triggers were removed at the owner's request; do not restore them without being asked.

`.github/workflows/sync-from-elysian-clearing.yml` now runs **only** when started by hand: Actions → “Sync from elysian-clearing” → Run workflow. The file documents the exact triggers to restore if the owner ever wants the schedule back.

When it does run, upstream changes arrive as a **reviewable pull request**, never as a force-push: it force-updates the `sync/elysian-clearing` branch to upstream `main` and opens a PR into `main`.

The job **never writes to `main`**, so work already on `main` is not overwritten by a sync. Merge the sync PR when you want upstream changes; a file changed both upstream and here (e.g. `fe/daily-ops-beta.js`) surfaces as a normal merge conflict instead of being silently discarded.

`sync/elysian-clearing` is machine-managed and force-updated — never commit to it. Sync PRs are still the owner's to merge.

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
