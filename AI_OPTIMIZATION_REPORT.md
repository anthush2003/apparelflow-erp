# AI Optimization Report

> DRAFT SCAFFOLD – rewrite every section in your own words and keep only what is TRUE for you.
> Evaluators score candour. Remove these notes and any claim you did not personally verify.

## 1. Tools & Prompting
- Tool(s) used: Claude (chat) — <add others you used>.
- Tasks: initial scaffolding of Express/React project, schema + trigger drafting, test generation, CSS contrast defaults.
- Prompting approach: <describe: what you pasted (assessment PDF), what you asked, how many iterations>.

## 2. Flawed / Broken AI Code  (document ≥2 REAL instances you personally observed)
Replace the examples below with what you actually hit. Suggestions of things worth checking in this codebase:
1. **Vacuous test (observed during generation):** the first generated "invalid input" test spread `{}` over a valid base payload, so the
   "invalid" case was actually valid and returned 201. The suite caught it; fixed by testing an empty body separately.
2. <Find your own: e.g. try pasting `-5`, `1e3`, `2.5` into every numeric box; try cURL with `{"status":"GREEN"}` or `{"verified_by":1}` in
   bodies; inspect dropdown/option colours in dark-mode OS settings; try double-clicking Approve. Record anything that misbehaved
   in an earlier iteration of YOUR version.>

## 3. Human Refactoring
- <What you changed and why. Examples you can truthfully claim only if you did them: moved validation to strict `typeof` checks,
  replaced `type="number"` inputs with text+regex, made UPDATEs conditional on current status, added DB triggers.>

## 4. Defensive Architecture
- Single state-machine table (`TRANSITIONS` in `server/rules.js`); every transition is a conditional `UPDATE ... WHERE status = <expected>`.
- Middleware order: authenticate (JWT) → requireRole → input validation → state check → business-rule check (re-read counts from DB).
- Traffic-light status is computed on the server from stored expected/actual counts; clients can never send a status.
- Verifier id comes from the JWT, timestamps from the DB clock.
- Sewing queue SQL hard-codes `status = 'VERIFIED'` and ignores request parameters.
- DB triggers block VERIFIED on RED/uncounted items, freeze attribution fields, and make the audit log append-only.
