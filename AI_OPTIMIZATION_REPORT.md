# AI Optimization Report

## 1. Tools & Prompting
- **Claude (chat)** – scaffolding the Express + React/Vite project, drafting `schema.sql` and the Postgres triggers, generating the first version of the Vitest/Supertest suite, and the initial CSS.
- **Prompting approach:** I pasted the full assessment brief and asked for a role-gated API first (state machine, validators, RBAC) and the UI second. I then iterated by reviewing each route against the security section of the brief (§9) and the 5-minute evaluator checklist (§16), asking for targeted fixes rather than rewrites.
- I used AI for speed on boilerplate; the security rules, state machine and acceptance checks were reviewed line by line by me.

## 2. Flawed / Broken AI Code
1. **Vacuous "invalid input" test.** The first generated test spread `{}` over a valid base payload, so the supposed invalid case was valid and returned 201 — the test would have passed for the wrong reason. The suite exposed it; I rewrote it to test an explicit empty body and a table of individually bad fields (`-5`, `2.5`, `'10'`, `0`, `'abc'`, `'<script>'`).
2. **Client/server validation drift.** The generated UI regexes allowed quantities up to 999,999 and yards/counts up to 7 digits, but the API caps them at 100,000 / 1,000,000. A value the form called "valid" came back as a 400. I aligned the client rules to the server (`isQtyStr`, `isCountStr`, `isYardsStr`) and documented the limits in the README. The server remains the source of truth.
3. **README claimed a feature the UI lacked.** The generated README described a header "Role Switcher", but the header only showed a name chip and Log out. I implemented a real switcher that re-logs in through `/api/auth/login`, so the JWT (not client state) decides the role.
4. **Unsafe production default.** With no `DATABASE_URL` the DB layer silently fell back to in-memory PGlite — fine locally, but on a serverless host every cold start would wipe all orders and logs, violating the persistence requirement. I made the server throw at boot in production without `DATABASE_URL`.

## 3. Human Refactoring
- Strict `typeof` validators in `server/rules.js` (`isInt`, `isYards`, `isRollId`) replace `Number()/parseInt` coercion, so `"10"`, `2.5`, `NaN` and `Infinity` are rejected.
- Number fields are text inputs with regex validation and inline error messages instead of `type="number"`, avoiding browser coercion (`1e3`, `-`).
- Every transition is a conditional `UPDATE ... WHERE status = <expected>` inside a transaction, so double-clicks and races return 409 instead of skipping states.
- Added DB triggers as a second line of defence (see §4).
- Fixed the client/server limit drift, added the Role Switcher and the production database guard (section 2).

## 4. Defensive Architecture
- **State machine:** one `TRANSITIONS` table in `server/rules.js`; `canTransition()` is checked before every change. Illegal moves return 409.
- **Middleware order per route:** `authenticate` (JWT → 401) → `requireRole` (→ 403) → input validation (→ 400) → state check (→ 409) → business rule check (→ 422).
- **Hard stop:** approve re-reads persisted counts from the database; any RED, uncounted or missing item returns 422. The client never sends a status — the server derives GREEN/YELLOW/RED from stored `expected_qty` (= target × pieces per garment) and `actual_qty`.
- **Trigger guard:** `guard_order_verification` makes the database itself refuse `status='VERIFIED'` with any RED/uncounted component, and freezes `verified_by`, `verified_at` and `wastage_pct` after they are written.
- **Audit trail:** `verification_logs` is append-only (UPDATE/DELETE trigger raises) and stores verifier id, decision, note, wastage % and a JSON snapshot of counts and variances.
- **Identity:** verifier id comes from the JWT; timestamps come from the DB `now()`. Body fields like `verified_by` are ignored (covered by Test 1).
- **Query isolation:** `/api/sewing/queue` hard-codes `WHERE status='VERIFIED'` and ignores query parameters; the detail endpoint only serves VERIFIED / SEWING_IN_PROGRESS rows.
