# ApparelFlow ERP – Cutting Operations & Gatekeeper Verification Terminal

Full-stack implementation of the Webtezza practical challenge: a **server-enforced hard stop** that stops any
unverified, mismatched or short cutting batch from reaching the Sewing Queue.

**Live URL:** https://apparelflow-erp-three.vercel.app/  
**Repo:** https://github.com/anthush2003/apparelflow-erp  
**Hosting:** Vercel (client + serverless API) · **Database:** Neon PostgreSQL (persistent)

## Demo credentials (password for all: `Demo@1234`)
| Role | Email | Can | Cannot |
|---|---|---|---|
| `cutting_supervisor` | supervisor@apparelflow.demo | Create orders, log fabric, submit / resubmit | Verify, see Sewing Queue |
| `cutting_verifier` | verifier@apparelflow.demo | Count parts, approve / reject | Create orders, see Sewing Queue |
| `sewing_supervisor` | sewing@apparelflow.demo | See VERIFIED batches, start sewing | See pending / rejected orders |

The login page has a Demo Credential Panel. Once signed in, the header **Role Switcher** re-authenticates as another persona through the real login API (a new JWT is issued; the role is never switched on the client only).

## Stack
React 18 + Vite (client) · Node/Express API running as a Vercel serverless function (`api/index.js`) · Neon PostgreSQL ·
JWT auth · bcrypt · Vitest + Supertest.
For local development and tests, when `DATABASE_URL` is empty, an embedded in-memory PostgreSQL (PGlite) is used so `npm test` needs no setup. In production the server **refuses to start without `DATABASE_URL`**, so data can never silently live in memory.

## Architecture
```
api/index.js      Vercel serverless entry: creates the Express app once and reuses it
server/rules.js   pure domain rules: state machine, traffic light, wastage, strict validators
server/auth.js    JWT verification (identity only from token) + requireRole()
server/app.js     routes grouped per role; every route = authenticate -> requireRole -> validate -> state check -> rule check
server/db.js      Neon (pg Pool) in production, PGlite locally; auto-creates schema and seeds data on first request
server/schema.sql relational schema + DB triggers (defence in depth)
src/              React UI (role-specific views)
tests/            API-level integration tests (14)
vercel.json       builds the client, routes /api/* to api/index.js
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

Fabric wastage % = (actual − expected) ÷ expected × 100, where expected = `std_fabric_yards × target_qty`.

### Seeded recipes
- **REC-BL01 Casual Blouse** – 1.8 yds/piece, wastage cap 5% – Front Body 1, Back Body 1, Sleeves 2, Collar & Stand 1, Cuffs 2
- **REC-CT02 Crop Top** – 1.1 yds/piece, wastage cap 8% – Front Chest 1, Back Support 1, Neck Binding 1, Hem Elastic Casing 1, Side Strap Accents 2

## Input limits (client and server agree)
Quantity 1–100000 whole numbers · fabric yards >0, ≤1,000,000, max 2 decimals · counts 0–1,000,000 whole numbers · roll ID 3–40 chars `[A-Za-z0-9-]` · rejection reason 5–500 chars.

## Run locally
```bash
npm install
npm test                      # 14 tests, no setup needed (uses embedded PGlite)
npm run build && npm start    # http://localhost:4000  (API + UI in one process)
# or dev mode: npm run dev:server (terminal 1) + npm run dev:client (terminal 2, http://localhost:5173)
```
To run locally against Neon, copy `.env.example` to `.env`, set `DATABASE_URL` and `JWT_SECRET`.

## Deployment (Vercel + Neon)
1. Create a free PostgreSQL project at [neon.tech](https://neon.tech) and copy the connection string.
2. Import this GitHub repo into Vercel (build command `npm run build`, output `dist`, already set in `vercel.json`).
3. In Vercel → Project Settings → Environment Variables (Production) add:
   - `DATABASE_URL` – the Neon connection string
   - `JWT_SECRET` – a long random string
4. Deploy. The schema and seed data (users and both recipes) are created automatically on the first request.

## cURL checks (as evaluators will do)
```bash
URL=https://apparelflow-erp-three.vercel.app
TOKEN=$(curl -s -X POST $URL/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"supervisor@apparelflow.demo","password":"Demo@1234"}' | jq -r .token)

# Supervisor tries to approve -> 403 Forbidden
curl -i -X POST $URL/api/verification/orders/1/approve -H "Authorization: Bearer $TOKEN"

# No token -> 401
curl -i $URL/api/sewing/queue

# Supervisor cannot read the Sewing Queue -> 403
curl -i $URL/api/sewing/queue -H "Authorization: Bearer $TOKEN"
```

## Automated tests
`npm test` runs 14 Vitest + Supertest tests covering the five required rules (all-GREEN approval, RED blocks approval with 422, reject without reason, 403 for non-verifier roles, unapproved orders never in the Sewing Queue) plus invalid-input rejection, illegal state transitions, re-cut/resubmit, YELLOW approval, wastage calculation and the database triggers.

## AI usage
See [AI_OPTIMIZATION_REPORT.md](./AI_OPTIMIZATION_REPORT.md).
