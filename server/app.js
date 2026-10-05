import express from 'express';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, query, tx } from './db.js';
import { signToken, authenticate, requireRole } from './auth.js';
import { ROLES, STATUS, canTransition, trafficLight, wastagePct, round2, isInt, isYards, isRollId } from './rules.js';

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const parseId = (v) => {
  if (!/^\d{1,9}$/.test(String(v))) throw new HttpError(400, 'Invalid id');
  return Number(v);
};

const ORDER_SQL = `
  SELECT o.id, o.order_no, o.recipe_id, r.recipe_code, r.name AS recipe_name, r.std_fabric_yards, r.wastage_cap,
         o.target_qty, o.fabric_roll_id, o.actual_fabric_yds, o.expected_fabric_yds, o.status,
         o.created_by, cu.full_name AS created_by_name, o.created_at, o.updated_at,
         o.verified_by, vu.full_name AS verified_by_name, o.verified_at, o.wastage_pct,
         o.latest_rejection_note, o.sewing_started_at, su.full_name AS sewing_started_by_name
  FROM cutting_orders o
  JOIN recipes r ON r.id = o.recipe_id
  JOIN users cu ON cu.id = o.created_by
  LEFT JOIN users vu ON vu.id = o.verified_by
  LEFT JOIN users su ON su.id = o.sewing_started_by`;

const ITEMS_SQL = `
  SELECT i.component_id, c.component_name, c.pieces_per_garment, i.expected_qty, i.actual_qty, i.status,
         CASE WHEN i.actual_qty IS NULL THEN NULL ELSE i.actual_qty - i.expected_qty END AS variance
  FROM verification_items i JOIN recipe_components c ON c.id = i.component_id
  WHERE i.order_id = $1 ORDER BY c.id`;

async function getItems(orderId, q = query) { return (await q(ITEMS_SQL, [orderId])).rows; }
async function getOrder(id, q = query) { return (await q(`${ORDER_SQL} WHERE o.id = $1`, [id])).rows[0] || null; }
async function withItems(o) { return o && { ...o, items: await getItems(o.id) }; }

export async function createApp() {
  await initDb();
  const app = express();
  app.use(express.json({ limit: '20kb' }));

  // ---------- Auth ----------
  app.post('/api/auth/login', wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password)
      throw new HttpError(400, 'Email and password are required');
    const r = await query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const u = r.rows[0];
    if (!u || !bcrypt.compareSync(password, u.password_hash)) throw new HttpError(401, 'Invalid email or password');
    res.json({ token: signToken(u), user: { id: u.id, email: u.email, role: u.role, full_name: u.full_name } });
  }));
  app.get('/api/auth/me', authenticate, wrap(async (req, res) => {
    const u = (await query('SELECT id,email,role,full_name FROM users WHERE id=$1', [req.user.id])).rows[0];
    if (!u) throw new HttpError(401, 'User no longer exists');
    res.json({ user: u });
  }));

  // ---------- Recipes (read-only; nobody can edit via API) ----------
  app.get('/api/recipes', authenticate, requireRole(ROLES.SUPERVISOR, ROLES.VERIFIER), wrap(async (_req, res) => {
    const recipes = (await query('SELECT * FROM recipes ORDER BY id')).rows;
    const comps = (await query('SELECT * FROM recipe_components ORDER BY id')).rows;
    res.json({ recipes: recipes.map((r) => ({ ...r, components: comps.filter((c) => c.recipe_id === r.id) })) });
  }));

  // ---------- Cutting Supervisor ----------
  const sup = [authenticate, requireRole(ROLES.SUPERVISOR)];

  app.get('/api/orders', ...sup, wrap(async (_req, res) => {
    res.json({ orders: (await query(`${ORDER_SQL} ORDER BY o.id DESC`)).rows });
  }));
  app.get('/api/orders/:id', ...sup, wrap(async (req, res) => {
    const o = await withItems(await getOrder(parseId(req.params.id)));
    if (!o) throw new HttpError(404, 'Order not found');
    res.json({ order: o });
  }));

  app.post('/api/orders', ...sup, wrap(async (req, res) => {
    const b = req.body || {};
    const errors = {};
    if (!isInt(b.recipe_id, 1, 2_000_000_000)) errors.recipe_id = 'Select a recipe';
    if (!isInt(b.target_qty, 1, 100000)) errors.target_qty = 'Quantity must be a whole number between 1 and 100000';
    if (!isRollId(b.fabric_roll_id)) errors.fabric_roll_id = 'Roll ID must be 3-40 letters, digits or hyphens';
    if (!isYards(b.actual_fabric_yds)) errors.actual_fabric_yds = 'Fabric used must be a positive number (max 2 decimals)';
    if (Object.keys(errors).length) throw new HttpError(400, 'Validation failed', errors);

    const recipe = (await query('SELECT * FROM recipes WHERE id=$1', [b.recipe_id])).rows[0];
    if (!recipe) throw new HttpError(400, 'Validation failed', { recipe_id: 'Unknown recipe' });
    const comps = (await query('SELECT * FROM recipe_components WHERE recipe_id=$1 ORDER BY id', [recipe.id])).rows;
    const status = b.submit === true ? STATUS.PENDING : STATUS.IN_PROGRESS;
    const expectedFabric = round2(recipe.std_fabric_yards * b.target_qty);

    const id = await tx(async (q) => {
      const ins = await q(
        `INSERT INTO cutting_orders(recipe_id,target_qty,fabric_roll_id,actual_fabric_yds,expected_fabric_yds,status,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [recipe.id, b.target_qty, b.fabric_roll_id, b.actual_fabric_yds, expectedFabric, status, req.user.id]);
      for (const c of comps) {
        await q('INSERT INTO verification_items(order_id,component_id,expected_qty) VALUES($1,$2,$3)',
          [ins.rows[0].id, c.id, c.pieces_per_garment * b.target_qty]);
      }
      return ins.rows[0].id;
    });
    res.status(201).json({ order: await withItems(await getOrder(id)) });
  }));

  // CUTTING_IN_PROGRESS | REJECTED -> PENDING_VERIFICATION
  app.post('/api/orders/:id/submit', ...sup, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const o = await getOrder(id);
    if (!o) throw new HttpError(404, 'Order not found');
    if (!canTransition(o.status, STATUS.PENDING)) throw new HttpError(409, `Cannot submit an order in status ${o.status}`);
    let yds = o.actual_fabric_yds;
    if (req.body && req.body.actual_fabric_yds !== undefined) {
      if (!isYards(req.body.actual_fabric_yds)) throw new HttpError(400, 'Validation failed', { actual_fabric_yds: 'Fabric used must be a positive number (max 2 decimals)' });
      yds = req.body.actual_fabric_yds;
    }
    await tx(async (q) => {
      const r = await q(
        `UPDATE cutting_orders SET status='PENDING_VERIFICATION', actual_fabric_yds=$2, updated_at=now()
         WHERE id=$1 AND status IN ('CUTTING_IN_PROGRESS','REJECTED') RETURNING id`, [id, yds]);
      if (!r.rows.length) throw new HttpError(409, 'Order status changed; reload and retry');
      await q('UPDATE verification_items SET actual_qty=NULL, status=NULL WHERE order_id=$1', [id]); // forces a fresh recount
    });
    res.json({ order: await withItems(await getOrder(id)) });
  }));

  // ---------- Cutting Verifier ----------
  const ver = [authenticate, requireRole(ROLES.VERIFIER)];

  app.get('/api/verification/orders', ...ver, wrap(async (_req, res) => {
    res.json({ orders: (await query(`${ORDER_SQL} WHERE o.status = 'PENDING_VERIFICATION' ORDER BY o.id`)).rows });
  }));
  app.get('/api/verification/history', ...ver, wrap(async (req, res) => {
    const r = await query(
      `SELECT l.id, l.order_id, o.order_no, l.decision, l.rejection_note, l.approval_note, l.wastage_pct, l."timestamp"
       FROM verification_logs l JOIN cutting_orders o ON o.id = l.order_id
       WHERE l.verifier_id = $1 ORDER BY l.id DESC LIMIT 20`, [req.user.id]);
    res.json({ history: r.rows });
  }));
  app.get('/api/verification/orders/:id', ...ver, wrap(async (req, res) => {
    const o = await withItems(await getOrder(parseId(req.params.id)));
    if (!o) throw new HttpError(404, 'Order not found');
    res.json({ order: o });
  }));

  // Save physical counts. The server derives GREEN/YELLOW/RED – the client never supplies a status.
  app.post('/api/verification/orders/:id/counts', ...ver, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const counts = req.body && req.body.counts;
    if (!Array.isArray(counts) || counts.length === 0 || counts.length > 50)
      throw new HttpError(400, 'Validation failed', { counts: 'Provide at least one component count' });
    for (const c of counts) {
      if (!c || !isInt(c.component_id, 1, 2_000_000_000) || !isInt(c.actual_qty, 0, 1_000_000))
        throw new HttpError(400, 'Validation failed', { counts: 'Counts must be whole numbers >= 0' });
    }
    const o = await getOrder(id);
    if (!o) throw new HttpError(404, 'Order not found');
    if (o.status !== STATUS.PENDING) throw new HttpError(409, `Counts can only be recorded while PENDING_VERIFICATION (current: ${o.status})`);
    await tx(async (q) => {
      for (const c of counts) {
        const cur = (await q('SELECT expected_qty FROM verification_items WHERE order_id=$1 AND component_id=$2', [id, c.component_id])).rows[0];
        if (!cur) throw new HttpError(400, 'Validation failed', { counts: `Component ${c.component_id} does not belong to this order` });
        await q('UPDATE verification_items SET actual_qty=$3, status=$4 WHERE order_id=$1 AND component_id=$2',
          [id, c.component_id, c.actual_qty, trafficLight(cur.expected_qty, c.actual_qty)]);
      }
    });
    res.json({ order: await withItems(await getOrder(id)) });
  }));

  const snapshot = (items) => JSON.stringify(items.map((i) => ({
    component: i.component_name, expected: i.expected_qty, actual: i.actual_qty, variance: i.variance, status: i.status })));

  // HARD STOP: server re-reads persisted counts and refuses approval on any RED / uncounted component.
  app.post('/api/verification/orders/:id/approve', ...ver, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const note = req.body && req.body.note;
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) throw new HttpError(400, 'Note must be text up to 500 characters');
    const o = await getOrder(id);
    if (!o) throw new HttpError(404, 'Order not found');
    if (!canTransition(o.status, STATUS.VERIFIED)) throw new HttpError(409, `Cannot approve an order in status ${o.status}`);
    const items = await getItems(id);
    const blocking = items.filter((i) => i.status === null || i.status === 'RED');
    if (items.length === 0 || blocking.length) {
      throw new HttpError(422, 'Approval blocked: every component must be counted and none may be in SHORTAGE (RED)',
        blocking.map((i) => ({ component: i.component_name, expected: i.expected_qty, actual: i.actual_qty, status: i.status || 'UNCOUNTED' })));
    }
    const wp = wastagePct(o.actual_fabric_yds, o.expected_fabric_yds);
    try {
      await tx(async (q) => {
        // verifier id + timestamp come from JWT / server clock, never from the body
        const r = await q(
          `UPDATE cutting_orders SET status='VERIFIED', verified_by=$2, verified_at=now(), wastage_pct=$3, updated_at=now()
           WHERE id=$1 AND status='PENDING_VERIFICATION' RETURNING id`, [id, req.user.id, wp]);
        if (!r.rows.length) throw new HttpError(409, 'Order status changed; reload and retry');
        await q(`INSERT INTO verification_logs(order_id,verifier_id,decision,approval_note,wastage_pct,items_snapshot)
                 VALUES($1,$2,'APPROVED',$3,$4,$5::jsonb)`, [id, req.user.id, note ? note.trim() : null, wp, snapshot(items)]);
      });
    } catch (e) {
      if (String(e.message).includes('Cannot verify')) throw new HttpError(422, 'Approval blocked by database guard: shortage or uncounted components');
      throw e;
    }
    res.json({ order: await withItems(await getOrder(id)) });
  }));

  app.post('/api/verification/orders/:id/reject', ...ver, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const reason = req.body && req.body.reason;
    if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 500)
      throw new HttpError(400, 'Validation failed', { reason: 'A rejection reason of 5-500 characters is mandatory' });
    const o = await getOrder(id);
    if (!o) throw new HttpError(404, 'Order not found');
    if (!canTransition(o.status, STATUS.REJECTED)) throw new HttpError(409, `Cannot reject an order in status ${o.status}`);
    const items = await getItems(id);
    const wp = wastagePct(o.actual_fabric_yds, o.expected_fabric_yds);
    await tx(async (q) => {
      const r = await q(
        `UPDATE cutting_orders SET status='REJECTED', latest_rejection_note=$2, updated_at=now()
         WHERE id=$1 AND status='PENDING_VERIFICATION' RETURNING id`, [id, reason.trim()]);
      if (!r.rows.length) throw new HttpError(409, 'Order status changed; reload and retry');
      await q(`INSERT INTO verification_logs(order_id,verifier_id,decision,rejection_note,wastage_pct,items_snapshot)
               VALUES($1,$2,'REJECTED',$3,$4,$5::jsonb)`, [id, req.user.id, reason.trim(), wp, snapshot(items)]);
    });
    res.json({ order: await withItems(await getOrder(id)) });
  }));

  // ---------- Sewing Supervisor (strictly VERIFIED data; no query params are honoured) ----------
  const sew = [authenticate, requireRole(ROLES.SEWING)];

  app.get('/api/sewing/queue', ...sew, wrap(async (_req, res) => {
    res.json({ orders: (await query(`${ORDER_SQL} WHERE o.status = 'VERIFIED' ORDER BY o.verified_at`)).rows });
  }));
  app.get('/api/sewing/active', ...sew, wrap(async (_req, res) => {
    res.json({ orders: (await query(`${ORDER_SQL} WHERE o.status = 'SEWING_IN_PROGRESS' ORDER BY o.sewing_started_at DESC`)).rows });
  }));
  app.get('/api/sewing/queue/:id', ...sew, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const o = (await query(`${ORDER_SQL} WHERE o.id = $1 AND o.status IN ('VERIFIED','SEWING_IN_PROGRESS')`, [id])).rows[0];
    if (!o) throw new HttpError(404, 'Order not found in sewing queue');
    const log = (await query(`SELECT approval_note, "timestamp" FROM verification_logs WHERE order_id=$1 AND decision='APPROVED' ORDER BY id DESC LIMIT 1`, [id])).rows[0];
    res.json({ order: { ...o, items: await getItems(id), verifier_note: log ? log.approval_note : null } });
  }));
  app.post('/api/sewing/queue/:id/start', ...sew, wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const r = await query(
      `UPDATE cutting_orders SET status='SEWING_IN_PROGRESS', sewing_started_by=$2, sewing_started_at=now(), updated_at=now()
       WHERE id=$1 AND status='VERIFIED' RETURNING id`, [id, req.user.id]);
    if (!r.rows.length) throw new HttpError(404, 'Order not found in sewing queue');
    res.json({ order: await getOrder(id) });
  }));

  // ---------- Static client + error handling ----------
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
