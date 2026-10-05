import fs from 'node:fs';
import bcrypt from 'bcryptjs';

let impl = null;
let initPromise = null;

async function connect() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const ssl = process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false };
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: process.env.VERCEL ? 3 : 10 });
    return {
      query: (s, p) => pool.query(s, p),
      exec: (s) => pool.query(s),
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn((s, p) => c.query(s, p));
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      }
    };
  }
  // Local dev / tests: embedded PostgreSQL (WASM). Same SQL dialect as production.
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(process.env.PGLITE_DIR || undefined);
  return {
    query: (s, p) => db.query(s, p),
    exec: (s) => db.exec(s),
    tx: (fn) => db.transaction((t) => fn((s, p) => t.query(s, p)))
  };
}

const RECIPES = [
  { code: 'REC-BL01', name: 'Casual Blouse', category: 'Blouse', yds: 1.8, cap: 5.0, parts: [
    ['Front Body Panel', 1], ['Back Body Panel', 1], ['Sleeves (Left & Right)', 2], ['Collar & Stand', 1], ['Sleeve Cuffs', 2]] },
  { code: 'REC-CT02', name: 'Crop Top', category: 'Crop Top', yds: 1.1, cap: 8.0, parts: [
    ['Front Chest Panel', 1], ['Back Support Panel', 1], ['Neck Binding Strip', 1], ['Hem Elastic Casing', 1], ['Side Strap Accents', 2]] }
];
const USERS = [
  ['supervisor@apparelflow.demo', 'cutting_supervisor', 'Nimali Perera (Cutting Supervisor)'],
  ['verifier@apparelflow.demo', 'cutting_verifier', 'Kasun Silva (Cutting Verifier)'],
  ['sewing@apparelflow.demo', 'sewing_supervisor', 'Dilani Fernando (Sewing Supervisor)']
];
export const DEMO_PASSWORD = 'Demo@1234';

async function seed() {
  const u = await impl.query('SELECT count(*)::int AS n FROM users');
  if (u.rows[0].n === 0) {
    const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
    for (const [email, role, name] of USERS) {
      await impl.query('INSERT INTO users(email,password_hash,role,full_name) VALUES($1,$2,$3,$4)', [email, hash, role, name]);
    }
  }
  const r = await impl.query('SELECT count(*)::int AS n FROM recipes');
  if (r.rows[0].n === 0) {
    for (const rec of RECIPES) {
      const ins = await impl.query(
        'INSERT INTO recipes(recipe_code,name,category,std_fabric_yards,wastage_cap) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [rec.code, rec.name, rec.category, rec.yds, rec.cap]);
      for (const [name, pcs] of rec.parts) {
        await impl.query('INSERT INTO recipe_components(recipe_id,component_name,pieces_per_garment) VALUES($1,$2,$3)', [ins.rows[0].id, name, pcs]);
      }
    }
  }
}

export function initDb() {
  if (!initPromise) {
    initPromise = (async () => {
      impl = await connect();
      await impl.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      await seed();
    })();
  }
  return initPromise;
}
export const query = (s, p) => impl.query(s, p);
export const tx = (fn) => impl.tx(fn);
