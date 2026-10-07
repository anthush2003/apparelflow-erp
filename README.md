# ApparelFlow ERP – Cutting Operations & Gatekeeper Verification Terminal

Full-stack implementation of the Webtezza practical challenge: a **server-enforced hard stop** that stops any
unverified, mismatched or short cutting batch from reaching the Sewing Queue.

**Live URL:** https://apparelflow-erp-three.vercel.app/  |  **Repo:** `<paste your GitHub URL here>`

## Demo credentials (password for all: `Demo@1234`)
| Role | Email | Can | Cannot |
|---|---|---|---|
| `cutting_supervisor` | supervisor@apparelflow.demo | Create orders, log fabric, submit / resubmit | Verify, see Sewing Queue |
| `cutting_verifier` | verifier@apparelflow.demo | Count parts, approve / reject | Create orders, see Sewing Queue |
| `sewing_supervisor` | sewing@apparelflow.demo | See VERIFIED batches, start sewing | See pending / rejected orders |

The login page has a Demo Credential Panel; once signed in, the header Role Switcher re-authenticates as another persona through the real login API (a new JWT is issued; nothing is switched client-side only).

## Stack
React 18 + Vite (client) · Node/Express (API, also serves the built client) · PostgreSQL (Neon / Supabase / Render) ·
JWT auth · bcrypt · Vitest + Supertest. Locally with no `DATABASE_URL`, an embedded in-memory PostgreSQL (PGlite) is used so
`npm test` needs no setup.

## Architecture
```
server/rules.js   pure domain rules: state machine, traffic light, wastage, strict validators
server/auth.js    JWT verification (identity only from token) + requireRole()
server/app.js     routes grouped per role; every route = authenticate -> requireRole -> validate -> state check -> rule check
server/schema.sql relational schema + DB triggers (defence in depth)
src/              React UI (role-specific views)
tests/            API-level integration tests
```
### State machine
`CUTTING_IN_PROGRESS → PENDING_VERIFICATION → (VERIFIED | REJECTED)`, `REJECTED → PENDING_VERIFICATION` (re-cut, forces full recount),
`VERIFIED → SEWING_IN_PROGRESS`. Anything else returns **409**. Updates are conditional (`WHERE status = ...`) so races cannot skip a state.

### Security contract (what the server enforces)
| Rule | Response |
|---|---|
| No / bad token | 401 |
| Wrong role (e.g. supervisor POSTs approve) | **403** |
| Approve with any RED, missing or uncounted component | **422** (counts are re-read from the DB; client-sent statuses are never accepted) |
| Reject without reason (≥5 chars) / invalid numbers | 400 |
| Illegal state transition | 409 |
| Sewing Queue | SQL hard-codes `WHERE status = 'VERIFIED'`; query params are ignored |
| Verifier id & timestamp | From JWT + DB `now()`; body fields are ignored |

**DB triggers (second line of defence):** the database itself refuses `status='VERIFIED'` if any item is RED/uncounted,
freezes `verified_by / verified_at / wastage_pct` once written, and makes `verification_logs` append-only.

### Schema
`users` · `recipes` · `recipe_components` · `cutting_orders` · `verification_items` (expected/actual/status per component) ·
`verification_logs` (decision, note, wastage %, JSON snapshot of counts/variances, timestamp). See `server/schema.sql`.
Fabric wastage % = (actual − expected) ÷ expected × 100, expected = `std_fabric_yards × target_qty`.

## Run locally
```bash
npm install
npm test                 # 14 tests
npm run build && npm start   # http://localhost:4000  (single process: API + UI)
# or dev mode: npm run dev:server  (terminal 1)  +  npm run dev:client (terminal 2, http://localhost:5173)
```
## Deploy (Vercel or Render + Neon/Supabase Postgres)
**Vercel:** import the repo; Project Settings → Environment Variables → `DATABASE_URL`, `JWT_SECRET` (Production). `vercel.json` already routes `/api/*` to `api/index.js`.
The server refuses to boot in production without `DATABASE_URL` (an in-memory DB would silently lose data).

### Render alternative
1. Create a free Postgres at neon.tech (or Supabase) and copy the connection string.
2. Push to GitHub. Render → New Web Service → select repo.
   Build: `npm install && npm run build` · Start: `npm start`
3. Env vars: `DATABASE_URL`, `JWT_SECRET` (long random string), `NODE_ENV=production`.
4. Schema and seed data are created automatically on first boot.

## Input limits (client and server agree)
Quantity 1–100000 whole numbers · fabric yards >0, ≤1,000,000, max 2 decimals · counts 0–1,000,000 whole numbers · roll ID 3–40 chars `[A-Za-z0-9-]` · rejection reason 5–500 chars.

## cURL checks (as evaluators will do)
```bash
TOKEN=$(curl -s -X POST $URL/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"supervisor@apparelflow.demo","password":"Demo@1234"}' | jq -r .token)
curl -i -X POST $URL/api/verification/orders/1/approve -H "Authorization: Bearer $TOKEN"   # -> 403
```
