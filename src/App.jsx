import { useEffect, useState, useCallback } from 'react';
import { api, getToken, setToken } from './api.js';

const PASSWORD = 'Demo@1234';
const PERSONAS = [
  { role: 'cutting_supervisor', label: 'Cutting Supervisor', email: 'supervisor@apparelflow.demo' },
  { role: 'cutting_verifier', label: 'Cutting Verifier', email: 'verifier@apparelflow.demo' },
  { role: 'sewing_supervisor', label: 'Sewing Supervisor', email: 'sewing@apparelflow.demo' }
];
const LIGHTS = { GREEN: ['●', 'MATCH'], YELLOW: ['▲', 'EXCESS'], RED: ['■', 'SHORTAGE'] };
const light = (e, a) => (a === null || a === undefined ? null : a === e ? 'GREEN' : a > e ? 'YELLOW' : 'RED');
const fmt = (d) => (d ? new Date(d).toLocaleString() : '—');
const isYardsStr = (s) => /^\d{1,7}(\.\d{1,2})?$/.test(s) && Number(s) > 0;
const isQtyStr = (s) => /^[1-9]\d{0,5}$/.test(s);

function Light({ s }) {
  if (!s) return <span className="badge b-none">UNCOUNTED</span>;
  return <span className={`badge b-${s}`}>{LIGHTS[s][0]} {s} · {LIGHTS[s][1]}</span>;
}
const Status = ({ s }) => <span className={`badge st-${s}`}>{s.replaceAll('_', ' ')}</span>;
const Alert = ({ kind = 'error', children }) => (children ? <div className={`alert a-${kind}`} role="alert">{children}</div> : null);

function Field({ label, id, error, hint, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && <div className="ferr" role="alert">⚠ {error}</div>}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!getToken()) { setReady(true); return; }
    api('/auth/me').then((r) => setUser(r.user)).catch(() => setToken(null)).finally(() => setReady(true));
  }, []);
  async function login(email, password) {
    const r = await api('/auth/login', { method: 'POST', body: { email, password } });
    setToken(r.token);
    setUser(r.user);
  }
  const logout = () => { setToken(null); setUser(null); };
  if (!ready) return <p className="center">Loading…</p>;
  if (!user) return <Login onLogin={login} />;
  const View = { cutting_supervisor: SupervisorView, cutting_verifier: VerifierView, sewing_supervisor: SewingView }[user.role];
  return (
    <div className="app">
      <header className="top">
        <div><strong>ApparelFlow ERP</strong> <span className="sub">Cutting Gatekeeper Terminal</span></div>
        <div className="who">
          <span className="persona-label">Switch role:</span>
          {PERSONAS.map((p) => (
            <button key={p.role} className={`chip ${user.role === p.role ? 'on' : ''}`} onClick={() => login(p.email, PASSWORD)} aria-pressed={user.role === p.role}>{p.label}</button>
          ))}
          <button className="btn ghost" onClick={logout}>Log out</button>
        </div>
      </header>
      <div className="userbar">Signed in as <strong>{user.full_name}</strong> · role <code>{user.role}</code></div>
      <main><View key={user.id} /></main>
    </div>
  );
}

function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function go(e, p) {
    setBusy(true); setErr('');
    try { await onLogin(e, p); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  }
  return (
    <div className="login">
      <h1>ApparelFlow ERP</h1>
      <p className="sub">Cutting Operations &amp; Gatekeeper Verification Terminal</p>
      <div className="card">
        <h2>Sign in</h2>
        <Alert>{err}</Alert>
        <Field label="Email" id="email"><input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
        <Field label="Password" id="pw"><input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        <button className="btn primary" disabled={busy || !email || !password} onClick={() => go(email, password)}>Sign in</button>
      </div>
      <div className="card">
        <h2>Demo credential panel</h2>
        <p className="hint">All demo accounts use password <code>{PASSWORD}</code>. One click signs in through the real login API.</p>
        {PERSONAS.map((p) => (
          <div className="demo-row" key={p.role}>
            <div><strong>{p.label}</strong><br /><code>{p.email}</code></div>
            <button className="btn" disabled={busy} onClick={() => go(p.email, PASSWORD)}>Log in as</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Cutting Supervisor ---------------- */
function SupervisorView() {
  const [orders, setOrders] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [fab, setFab] = useState({});
  const [fabErr, setFabErr] = useState({});
  const load = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([api('/orders'), api('/recipes')]);
      setOrders(o.orders); setRecipes(r.recipes);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function submit(o) {
    const y = fab[o.id] ?? String(o.actual_fabric_yds);
    if (!isYardsStr(y)) { setFabErr({ ...fabErr, [o.id]: 'Enter a positive number, max 2 decimals' }); return; }
    setFabErr({ ...fabErr, [o.id]: '' });
    try {
      await api(`/orders/${o.id}/submit`, { method: 'POST', body: { actual_fabric_yds: Number(y) } });
      setMsg(`${o.order_no} submitted to the verification terminal.`); setErr(''); load();
    } catch (e) { setErr(e.message); }
  }
  return (
    <>
      <div className="row between">
        <h2>Cutting Orders</h2>
        <button className="btn primary" onClick={() => { setOpen(true); setMsg(''); }}>+ New Cutting Order</button>
      </div>
      <Alert>{err}</Alert><Alert kind="ok">{msg}</Alert>
      {orders.length === 0 && <p className="empty">No cutting orders yet.</p>}
      <div className="grid">
        {orders.map((o) => (
          <div className="card" key={o.id}>
            <div className="row between"><strong>{o.order_no}</strong><Status s={o.status} /></div>
            <p>{o.recipe_name} <code>{o.recipe_code}</code></p>
            <dl>
              <dt>Target qty</dt><dd>{o.target_qty}</dd>
              <dt>Fabric roll</dt><dd>{o.fabric_roll_id}</dd>
              <dt>Fabric used</dt><dd>{o.actual_fabric_yds} yds (expected {o.expected_fabric_yds})</dd>
              <dt>Created</dt><dd>{fmt(o.created_at)}</dd>
            </dl>
            {o.status === 'REJECTED' && <Alert>Rejected by verifier: {o.latest_rejection_note}</Alert>}
            {(o.status === 'CUTTING_IN_PROGRESS' || o.status === 'REJECTED') && (
              <>
                <Field label={o.status === 'REJECTED' ? 'Fabric used after re-cut (yds)' : 'Fabric used (yds)'} id={`f${o.id}`} error={fabErr[o.id]}>
                  <input id={`f${o.id}`} inputMode="decimal" value={fab[o.id] ?? String(o.actual_fabric_yds)} onChange={(e) => setFab({ ...fab, [o.id]: e.target.value })} />
                </Field>
                <button className="btn primary" onClick={() => submit(o)}>{o.status === 'REJECTED' ? 'Resubmit to QC' : 'Submit to Verification'}</button>
              </>
            )}
          </div>
        ))}
      </div>
      {open && <OrderModal recipes={recipes} onClose={() => setOpen(false)} onDone={(m) => { setOpen(false); setMsg(m); load(); }} />}
    </>
  );
}

function OrderModal({ recipes, onClose, onDone }) {
  const [f, setF] = useState({ recipe_id: '', target_qty: '', fabric_roll_id: '', actual_fabric_yds: '' });
  const [errs, setErrs] = useState({});
  const [srv, setSrv] = useState('');
  const recipe = recipes.find((r) => String(r.id) === f.recipe_id);
  const qty = isQtyStr(f.target_qty) ? Number(f.target_qty) : null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  function validate() {
    const e = {};
    if (!recipe) e.recipe_id = 'Select a recipe';
    if (!isQtyStr(f.target_qty)) e.target_qty = 'Whole number from 1 to 999999 (no decimals, negatives or text)';
    if (!/^[A-Za-z0-9-]{3,40}$/.test(f.fabric_roll_id)) e.fabric_roll_id = '3-40 letters, digits or hyphens, e.g. FAB-ROLL-882';
    if (!isYardsStr(f.actual_fabric_yds)) e.actual_fabric_yds = 'Positive number, max 2 decimals';
    setErrs(e);
    return Object.keys(e).length === 0;
  }
  async function save(submit) {
    if (!validate()) return;
    try {
      const r = await api('/orders', { method: 'POST', body: {
        recipe_id: Number(f.recipe_id), target_qty: Number(f.target_qty), fabric_roll_id: f.fabric_roll_id,
        actual_fabric_yds: Number(f.actual_fabric_yds), submit } });
      onDone(`${r.order.order_no} created${submit ? ' and sent to verification' : ' (in progress)'}.`);
    } catch (e) { setSrv(e.message + (e.details ? ': ' + Object.values(e.details).join('; ') : '')); }
  }
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="New cutting order">
      <div className="modal">
        <h2>New Cutting Order</h2>
        <Alert>{srv}</Alert>
        <Field label="Recipe" id="m-recipe" error={errs.recipe_id}>
          <select id="m-recipe" value={f.recipe_id} onChange={set('recipe_id')}>
            <option value="">Select a recipe…</option>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.recipe_code} – {r.name}</option>)}
          </select>
        </Field>
        <Field label="Target batch quantity (garments)" id="m-qty" error={errs.target_qty}>
          <input id="m-qty" inputMode="numeric" value={f.target_qty} onChange={set('target_qty')} placeholder="e.g. 50" />
        </Field>
        <Field label="Fabric roll ID" id="m-roll" error={errs.fabric_roll_id}>
          <input id="m-roll" value={f.fabric_roll_id} onChange={set('fabric_roll_id')} placeholder="FAB-ROLL-882" />
        </Field>
        <Field label="Actual fabric used (yards)" id="m-yds" error={errs.actual_fabric_yds}>
          <input id="m-yds" inputMode="decimal" value={f.actual_fabric_yds} onChange={set('actual_fabric_yds')} placeholder="e.g. 92.5" />
        </Field>
        {recipe && qty && (
          <div className="preview">
            <strong>Expected component counts</strong>
            <ul>{recipe.components.map((c) => <li key={c.id}>{c.component_name}: <b>{c.pieces_per_garment * qty}</b> pcs ({qty} × {c.pieces_per_garment})</li>)}</ul>
            <div>Expected fabric: <b>{(recipe.std_fabric_yards * qty).toFixed(2)} yds</b> · wastage cap {recipe.wastage_cap}%</div>
          </div>
        )}
        <div className="row end">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={() => save(false)}>Save as In-Progress</button>
          <button className="btn primary" onClick={() => save(true)}>Create &amp; Submit to QC</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Cutting Verifier ---------------- */
function VerifierView() {
  const [orders, setOrders] = useState([]);
  const [history, setHistory] = useState([]);
  const [sel, setSel] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try {
      const [o, h] = await Promise.all([api('/verification/orders'), api('/verification/history')]);
      setOrders(o.orders); setHistory(h.history);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (sel) return <Terminal id={sel} onBack={() => setSel(null)} onDone={(m) => { setSel(null); setMsg(m); load(); }} />;
  return (
    <>
      <h2>Verification Queue</h2>
      <Alert>{err}</Alert><Alert kind="ok">{msg}</Alert>
      {orders.length === 0 && <p className="empty">No batches are waiting at the QC station.</p>}
      <div className="grid">
        {orders.map((o) => (
          <div className="card" key={o.id}>
            <div className="row between"><strong>{o.order_no}</strong><Status s={o.status} /></div>
            <p>{o.recipe_name} · {o.target_qty} garments · roll {o.fabric_roll_id}</p>
            <button className="btn primary" onClick={() => { setSel(o.id); setMsg(''); }}>Open Verification Terminal</button>
          </div>
        ))}
      </div>
      <h3>My recent decisions</h3>
      {history.length === 0 ? <p className="empty">None yet.</p> : (
        <div className="scroll"><table><thead><tr><th>Order</th><th>Decision</th><th>Wastage %</th><th>When</th><th>Note</th></tr></thead>
          <tbody>{history.map((h) => <tr key={h.id}><td>{h.order_no}</td><td>{h.decision}</td><td>{h.wastage_pct}</td><td>{fmt(h.timestamp)}</td><td>{h.rejection_note || h.approval_note || '—'}</td></tr>)}</tbody></table></div>
      )}
    </>
  );
}

function Terminal({ id, onBack, onDone }) {
  const [o, setO] = useState(null);
  const [vals, setVals] = useState({});
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [rErr, setRErr] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/verification/orders/${id}`).then((r) => {
      setO(r.order);
      const v = {};
      r.order.items.forEach((i) => { v[i.component_id] = i.actual_qty === null ? '' : String(i.actual_qty); });
      setVals(v);
    }).catch((e) => setErr(e.message));
  }, [id]);
  if (!o) return <><button className="btn ghost" onClick={onBack}>← Back</button><Alert>{err}</Alert></>;

  const rows = o.items.map((i) => {
    const raw = vals[i.component_id] ?? '';
    const valid = raw === '' || /^\d{1,7}$/.test(raw);
    const n = raw !== '' && valid ? Number(raw) : null;
    return { ...i, raw, valid, n, light: light(i.expected_qty, n) };
  });
  const anyInvalid = rows.some((r) => !r.valid);
  const anyRed = rows.some((r) => r.light === 'RED');
  const uncounted = rows.some((r) => r.n === null);
  const canApprove = !anyInvalid && !anyRed && !uncounted && !busy;
  const wp = ((o.actual_fabric_yds - o.expected_fabric_yds) / o.expected_fabric_yds) * 100;
  const payload = () => ({ counts: rows.filter((r) => r.n !== null).map((r) => ({ component_id: r.component_id, actual_qty: r.n })) });
  const save = async () => { if (payload().counts.length) await api(`/verification/orders/${id}/counts`, { method: 'POST', body: payload() }); };

  async function run(fn) { setBusy(true); setErr(''); setOk(''); try { await fn(); } catch (e) { setErr(e.message + (e.details && Array.isArray(e.details) ? ' — ' + e.details.map((d) => d.component).join(', ') : '')); } finally { setBusy(false); } }
  const doSave = () => run(async () => { await save(); setOk('Counts saved.'); });
  const doApprove = () => run(async () => { await save(); await api(`/verification/orders/${id}/approve`, { method: 'POST', body: { note: note.trim() || undefined } }); onDone(`${o.order_no} verified and released to the Sewing Queue.`); });
  const doReject = () => {
    if (reason.trim().length < 5) { setRErr('A rejection reason (at least 5 characters) is mandatory.'); return; }
    setRErr('');
    run(async () => { try { await save(); } catch { /* counts optional on reject */ } await api(`/verification/orders/${id}/reject`, { method: 'POST', body: { reason: reason.trim() } }); onDone(`${o.order_no} rejected and returned to the Cutting Supervisor.`); });
  };

  return (
    <>
      <button className="btn ghost" onClick={onBack}>← Back to queue</button>
      <div className="card">
        <div className="row between"><h2>{o.order_no} · {o.recipe_name}</h2><Status s={o.status} /></div>
        <p>Batch of <b>{o.target_qty}</b> garments · roll <b>{o.fabric_roll_id}</b> · fabric used <b>{o.actual_fabric_yds} yds</b> (expected {o.expected_fabric_yds}) ·
          wastage <b>{wp.toFixed(2)}%</b> {wp > o.wastage_cap && <span className="badge b-RED">Over {o.wastage_cap}% cap</span>}</p>
        <Alert>{err}</Alert><Alert kind="ok">{ok}</Alert>
        <div className="scroll">
          <table>
            <thead><tr><th>Component</th><th>Per garment</th><th>Expected</th><th>Actual count</th><th>Variance</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.component_id}>
                  <td>{r.component_name}</td><td>{r.pieces_per_garment}</td><td><b>{r.expected_qty}</b></td>
                  <td>
                    <input aria-label={`Actual count for ${r.component_name}`} className={`num ${r.valid ? '' : 'bad'}`} inputMode="numeric" value={r.raw}
                      onChange={(e) => setVals({ ...vals, [r.component_id]: e.target.value })} />
                    {!r.valid && <div className="ferr">⚠ Whole number ≥ 0 only</div>}
                  </td>
                  <td>{r.n === null ? '—' : (r.n - r.expected_qty > 0 ? '+' : '') + (r.n - r.expected_qty)}</td>
                  <td><Light s={r.light} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {anyRed && <Alert>HARD STOP: at least one component is in SHORTAGE (RED). Approval is blocked — you may only reject the batch with a reason.</Alert>}
        {!anyRed && uncounted && <Alert kind="warn">Count every component to enable approval.</Alert>}
        <Field label="Approval note for the sewing floor (optional)" id="note"><input id="note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
        <Field label="Rejection reason (mandatory to reject)" id="reason" error={rErr}>
          <textarea id="reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Collar shortage of 4 pcs; fabric flaw on bundle 7" />
        </Field>
        <div className="row end">
          <button className="btn" onClick={doSave} disabled={busy}>Save counts</button>
          <button className="btn danger" onClick={doReject} disabled={busy}>Reject Batch</button>
          <button className="btn primary" onClick={doApprove} disabled={!canApprove} title={canApprove ? '' : 'Disabled: shortage, uncounted or invalid component'}>Approve Batch</button>
        </div>
      </div>
    </>
  );
}

/* ---------------- Sewing Supervisor ---------------- */
function SewingView() {
  const [queue, setQueue] = useState([]);
  const [active, setActive] = useState([]);
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    try {
      const [q, a] = await Promise.all([api('/sewing/queue'), api('/sewing/active')]);
      setQueue(q.orders); setActive(a.orders);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const open = async (id) => { try { setDetail((await api(`/sewing/queue/${id}`)).order); } catch (e) { setErr(e.message); } };
  async function start(o) {
    try { await api(`/sewing/queue/${o.id}/start`, { method: 'POST' }); setMsg(`${o.order_no} released to assembly.`); setDetail(null); load(); }
    catch (e) { setErr(e.message); }
  }
  return (
    <>
      <h2>Sewing Queue <span className="sub">(verified batches only)</span></h2>
      <Alert>{err}</Alert><Alert kind="ok">{msg}</Alert>
      {queue.length === 0 && <p className="empty">No verified batches waiting.</p>}
      <div className="grid">
        {queue.map((o) => (
          <div className="card" key={o.id}>
            <div className="row between"><strong>{o.order_no}</strong><Status s={o.status} /></div>
            <p>{o.recipe_name} · {o.target_qty} garments</p>
            <p className="hint">Verified by {o.verified_by_name} · {fmt(o.verified_at)}</p>
            <button className="btn primary" onClick={() => open(o.id)}>Inspect batch</button>
          </div>
        ))}
      </div>
      {detail && (
        <div className="card">
          <div className="row between"><h3>{detail.order_no} · {detail.recipe_name}</h3><Status s={detail.status} /></div>
          <dl>
            <dt>Verified by</dt><dd>{detail.verified_by_name}</dd>
            <dt>Verified at</dt><dd>{fmt(detail.verified_at)}</dd>
            <dt>Fabric wastage</dt><dd>{detail.wastage_pct}% (cap {detail.wastage_cap}%)</dd>
            <dt>Verifier note</dt><dd>{detail.verifier_note || '—'}</dd>
          </dl>
          <div className="scroll"><table><thead><tr><th>Component</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Status</th></tr></thead>
            <tbody>{detail.items.map((i) => <tr key={i.component_id}><td>{i.component_name}</td><td>{i.expected_qty}</td><td>{i.actual_qty}</td><td>{i.variance > 0 ? '+' : ''}{i.variance}</td><td><Light s={i.status} /></td></tr>)}</tbody></table></div>
          <div className="row end">
            <button className="btn ghost" onClick={() => setDetail(null)}>Close</button>
            {detail.status === 'VERIFIED' && <button className="btn primary" onClick={() => start(detail)}>Start Sewing Assembly</button>}
          </div>
        </div>
      )}
      <h3>In assembly</h3>
      {active.length === 0 ? <p className="empty">Nothing in assembly.</p> : (
        <div className="grid">{active.map((o) => (
          <div className="card" key={o.id}><div className="row between"><strong>{o.order_no}</strong><Status s={o.status} /></div>
            <p>{o.recipe_name} · {o.target_qty} garments</p><p className="hint">Started {fmt(o.sewing_started_at)} by {o.sewing_started_by_name}</p>
            <button className="btn" onClick={() => open(o.id)}>View audit</button></div>))}</div>
      )}
    </>
  );
}
