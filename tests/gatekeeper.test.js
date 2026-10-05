import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { trafficLight, wastagePct, canTransition } from '../server/rules.js';

let app;
const tokens = {};
const PW = 'Demo@1234';
const auth = (r, role) => r.set('Authorization', `Bearer ${tokens[role]}`);
const login = async (role, email) => {
  const r = await request(app).post('/api/auth/login').send({ email, password: PW });
  tokens[role] = r.body.token;
  return r.body.user;
};

async function makeOrder({ recipeCode = 'REC-BL01', qty = 50, yds = 90, submit = true } = {}) {
  const recipes = (await auth(request(app).get('/api/recipes'), 'sup')).body.recipes;
  const recipe = recipes.find((r) => r.recipe_code === recipeCode);
  const r = await auth(request(app).post('/api/orders'), 'sup').send({
    recipe_id: recipe.id, target_qty: qty, fabric_roll_id: 'FAB-ROLL-882', actual_fabric_yds: yds, submit });
  expect(r.status).toBe(201);
  return r.body.order;
}
const countAll = (order, fn) => ({ counts: order.items.map((i) => ({ component_id: i.component_id, actual_qty: fn(i) })) });
const saveCounts = (order, fn) => auth(request(app).post(`/api/verification/orders/${order.id}/counts`), 'ver').send(countAll(order, fn));

beforeAll(async () => {
  app = await createApp();
  await login('sup', 'supervisor@apparelflow.demo');
  await login('ver', 'verifier@apparelflow.demo');
  await login('sew', 'sewing@apparelflow.demo');
});

describe('Required core rules', () => {
  it('Test 1: all-GREEN order can be approved by an authenticated verifier (audit written)', async () => {
    const o = await makeOrder();
    expect(o.items.find((i) => i.component_name === 'Sleeve Cuffs').expected_qty).toBe(100); // 50 x 2
    const c = await saveCounts(o, (i) => i.expected_qty);
    expect(c.body.order.items.every((i) => i.status === 'GREEN')).toBe(true);
    // client tries to spoof identity/timestamp – must be ignored
    const a = await auth(request(app).post(`/api/verification/orders/${o.id}/approve`), 'ver')
      .send({ note: 'All good', verified_by: 999, verified_at: '2000-01-01' });
    expect(a.status).toBe(200);
    expect(a.body.order.status).toBe('VERIFIED');
    expect(a.body.order.verified_by).not.toBe(999);
    expect(a.body.order.verified_by_name).toContain('Verifier');
    expect(new Date(a.body.order.verified_at).getFullYear()).toBeGreaterThan(2020);
    expect(a.body.order.wastage_pct).toBe(0); // 90 used vs 1.8*50 expected
  });

  it('Test 2: a RED (shortage) component blocks approval with 422', async () => {
    const o = await makeOrder();
    await saveCounts(o, (i) => (i.component_name === 'Collar & Stand' ? i.expected_qty - 1 : i.expected_qty + 2));
    const a = await auth(request(app).post(`/api/verification/orders/${o.id}/approve`), 'ver').send({});
    expect(a.status).toBe(422);
    expect(a.body.details[0].component).toBe('Collar & Stand');
    const check = await auth(request(app).get(`/api/verification/orders/${o.id}`), 'ver');
    expect(check.body.order.status).toBe('PENDING_VERIFICATION');
  });

  it('Test 2b: uncounted components also block approval (422)', async () => {
    const o = await makeOrder();
    const a = await auth(request(app).post(`/api/verification/orders/${o.id}/approve`), 'ver').send({});
    expect(a.status).toBe(422);
  });

  it('Test 3: rejecting without a reason is refused; with reason it succeeds', async () => {
    const o = await makeOrder();
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'ab' }, { reason: 123 }]) {
      const r = await auth(request(app).post(`/api/verification/orders/${o.id}/reject`), 'ver').send(body);
      expect(r.status).toBe(400);
    }
    const ok = await auth(request(app).post(`/api/verification/orders/${o.id}/reject`), 'ver').send({ reason: 'Collar shortage, re-cut' });
    expect(ok.status).toBe(200);
    expect(ok.body.order.status).toBe('REJECTED');
    expect(ok.body.order.latest_rejection_note).toBe('Collar shortage, re-cut');
  });

  it('Test 4: non-verifier roles get 403 on verification endpoints (and 401 when anonymous)', async () => {
    const o = await makeOrder();
    for (const role of ['sup', 'sew']) {
      for (const action of ['approve', 'reject', 'counts']) {
        const r = await auth(request(app).post(`/api/verification/orders/${o.id}/${action}`), role).send({ reason: 'xxxxxx', counts: [] });
        expect(r.status).toBe(403);
      }
    }
    const anon = await request(app).post(`/api/verification/orders/${o.id}/approve`).send({});
    expect(anon.status).toBe(401);
  });

  it('Test 5: unapproved orders never appear in the Sewing Queue', async () => {
    const pending = await makeOrder();
    const draft = await makeOrder({ submit: false });
    const rejected = await makeOrder();
    await auth(request(app).post(`/api/verification/orders/${rejected.id}/reject`), 'ver').send({ reason: 'Defective fabric' });
    const good = await makeOrder({ recipeCode: 'REC-CT02', qty: 10, yds: 11 });
    await saveCounts(good, (i) => i.expected_qty);
    await auth(request(app).post(`/api/verification/orders/${good.id}/approve`), 'ver').send({});

    const q = await auth(request(app).get('/api/sewing/queue?status=PENDING_VERIFICATION&all=true'), 'sew');
    expect(q.status).toBe(200);
    const ids = q.body.orders.map((x) => x.id);
    expect(ids).toContain(good.id);
    for (const bad of [pending, draft, rejected]) expect(ids).not.toContain(bad.id);
    expect(q.body.orders.every((x) => x.status === 'VERIFIED')).toBe(true);
    const direct = await auth(request(app).get(`/api/sewing/queue/${pending.id}`), 'sew');
    expect(direct.status).toBe(404);
  });
});

describe('Additional hardening', () => {
  it('sewing role can start sewing only on VERIFIED orders; other roles cannot see the queue', async () => {
    const o = await makeOrder({ recipeCode: 'REC-CT02', qty: 5, yds: 5.5 });
    const early = await auth(request(app).post(`/api/sewing/queue/${o.id}/start`), 'sew').send({});
    expect(early.status).toBe(404);
    expect((await auth(request(app).get('/api/sewing/queue'), 'sup')).status).toBe(403);
    expect((await auth(request(app).get('/api/sewing/queue'), 'ver')).status).toBe(403);
    await saveCounts(o, (i) => i.expected_qty);
    await auth(request(app).post(`/api/verification/orders/${o.id}/approve`), 'ver').send({});
    const s = await auth(request(app).post(`/api/sewing/queue/${o.id}/start`), 'sew').send({});
    expect(s.body.order.status).toBe('SEWING_IN_PROGRESS');
  });

  it('server derives status; YELLOW (excess) may proceed; wastage % is stored', async () => {
    const o = await makeOrder({ qty: 10, yds: 19.8 }); // expected 18 -> +10%
    const c = await saveCounts(o, (i) => i.expected_qty + 1);
    expect(c.body.order.items.every((i) => i.status === 'YELLOW')).toBe(true);
    const a = await auth(request(app).post(`/api/verification/orders/${o.id}/approve`), 'ver').send({});
    expect(a.status).toBe(200);
    expect(a.body.order.wastage_pct).toBe(10);
  });

  it('rejects invalid inputs: negatives, decimals, strings, empty payloads', async () => {
    const recipes = (await auth(request(app).get('/api/recipes'), 'sup')).body.recipes;
    const base = { recipe_id: recipes[0].id, target_qty: 10, fabric_roll_id: 'FAB-1', actual_fabric_yds: 20 };
    expect((await auth(request(app).post('/api/orders'), 'sup').send({})).status).toBe(400);
    for (const bad of [{ target_qty: -5 }, { target_qty: 2.5 }, { target_qty: '10' }, { target_qty: 0 },
      { actual_fabric_yds: -1 }, { actual_fabric_yds: 'abc' }, { fabric_roll_id: '' }, { fabric_roll_id: '<script>' }]) {
      const r = await auth(request(app).post('/api/orders'), 'sup').send({ ...base, ...bad });
      expect(r.status).toBe(400);
    }
    const o = await makeOrder();
    for (const v of [-1, 1.5, '5', null]) {
      const r = await auth(request(app).post(`/api/verification/orders/${o.id}/counts`), 'ver')
        .send({ counts: [{ component_id: o.items[0].component_id, actual_qty: v }] });
      expect(r.status).toBe(400);
    }
  });

  it('supervisor cannot create orders as other roles; verifier/sewing cannot create orders', async () => {
    for (const role of ['ver', 'sew']) {
      expect((await auth(request(app).post('/api/orders'), role).send({})).status).toBe(403);
    }
  });

  it('illegal state transitions fail: re-approving, approving a draft, re-submitting a verified order', async () => {
    const draft = await makeOrder({ submit: false });
    expect((await auth(request(app).post(`/api/verification/orders/${draft.id}/approve`), 'ver').send({})).status).toBe(409);
    const o = await makeOrder({ recipeCode: 'REC-CT02', qty: 2, yds: 2.2 });
    await saveCounts(o, (i) => i.expected_qty);
    await auth(request(app).post(`/api/verification/orders/${o.id}/approve`), 'ver').send({});
    expect((await auth(request(app).post(`/api/verification/orders/${o.id}/approve`), 'ver').send({})).status).toBe(409);
    expect((await auth(request(app).post(`/api/orders/${o.id}/submit`), 'sup').send({})).status).toBe(409);
  });

  it('rejected order can be re-cut and resubmitted, forcing a fresh recount', async () => {
    const o = await makeOrder();
    await saveCounts(o, (i) => i.expected_qty - 1);
    await auth(request(app).post(`/api/verification/orders/${o.id}/reject`), 'ver').send({ reason: 'Shortage on all parts' });
    const re = await auth(request(app).post(`/api/orders/${o.id}/submit`), 'sup').send({ actual_fabric_yds: 95 });
    expect(re.body.order.status).toBe('PENDING_VERIFICATION');
    expect(re.body.order.items.every((i) => i.actual_qty === null)).toBe(true);
  });

  it('database guard blocks VERIFIED on a RED order even if the API check were bypassed', async () => {
    const { query } = await import('../server/db.js');
    const o = await makeOrder();
    await saveCounts(o, (i) => i.expected_qty - 1);
    await expect(query(`UPDATE cutting_orders SET status='VERIFIED' WHERE id=$1`, [o.id])).rejects.toThrow(/Cannot verify/);
    await expect(query(`DELETE FROM verification_logs`)).rejects.toThrow(/immutable/);
  });

  it('pure rules', () => {
    expect(trafficLight(10, 10)).toBe('GREEN');
    expect(trafficLight(10, 11)).toBe('YELLOW');
    expect(trafficLight(10, 9)).toBe('RED');
    expect(trafficLight(10, null)).toBeNull();
    expect(wastagePct(95, 90)).toBe(5.56);
    expect(canTransition('PENDING_VERIFICATION', 'SEWING_IN_PROGRESS')).toBe(false);
    expect(canTransition('REJECTED', 'VERIFIED')).toBe(false);
  });
});
