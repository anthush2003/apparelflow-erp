CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('cutting_supervisor','cutting_verifier','sewing_supervisor')),
  full_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recipes (
  id SERIAL PRIMARY KEY,
  recipe_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  std_fabric_yards DOUBLE PRECISION NOT NULL CHECK (std_fabric_yards > 0),
  wastage_cap DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_components (
  id SERIAL PRIMARY KEY,
  recipe_id INT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  component_name TEXT NOT NULL,
  pieces_per_garment INT NOT NULL CHECK (pieces_per_garment > 0),
  image_url TEXT
);
CREATE SEQUENCE IF NOT EXISTS cutting_order_seq START 1;
CREATE TABLE IF NOT EXISTS cutting_orders (
  id SERIAL PRIMARY KEY,
  order_no TEXT UNIQUE NOT NULL DEFAULT ('CUT-' || lpad(nextval('cutting_order_seq')::text, 5, '0')),
  recipe_id INT NOT NULL REFERENCES recipes(id),
  target_qty INT NOT NULL CHECK (target_qty > 0),
  fabric_roll_id TEXT NOT NULL,
  actual_fabric_yds DOUBLE PRECISION NOT NULL CHECK (actual_fabric_yds > 0),
  expected_fabric_yds DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'CUTTING_IN_PROGRESS'
    CHECK (status IN ('CUTTING_IN_PROGRESS','PENDING_VERIFICATION','REJECTED','VERIFIED','SEWING_IN_PROGRESS')),
  created_by INT NOT NULL REFERENCES users(id),
  verified_by INT REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  wastage_pct DOUBLE PRECISION,
  latest_rejection_note TEXT,
  sewing_started_by INT REFERENCES users(id),
  sewing_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON cutting_orders(status);
CREATE TABLE IF NOT EXISTS verification_items (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES cutting_orders(id) ON DELETE CASCADE,
  component_id INT NOT NULL REFERENCES recipe_components(id),
  expected_qty INT NOT NULL CHECK (expected_qty > 0),
  actual_qty INT CHECK (actual_qty >= 0),
  status TEXT CHECK (status IN ('GREEN','YELLOW','RED')),
  UNIQUE (order_id, component_id)
);
CREATE TABLE IF NOT EXISTS verification_logs (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES cutting_orders(id),
  verifier_id INT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  rejection_note TEXT,
  approval_note TEXT,
  wastage_pct DOUBLE PRECISION,
  items_snapshot JSONB,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (decision <> 'REJECTED' OR (rejection_note IS NOT NULL AND length(trim(rejection_note)) >= 5))
);

-- Defence in depth: audit log is append-only at the database level.
CREATE OR REPLACE FUNCTION forbid_log_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'verification_logs is immutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_logs_immutable ON verification_logs;
CREATE TRIGGER trg_logs_immutable BEFORE UPDATE OR DELETE ON verification_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_log_mutation();

-- Defence in depth: DB itself refuses VERIFIED when any component is RED/uncounted,
-- and freezes attribution once written.
CREATE OR REPLACE FUNCTION guard_order_verification() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'VERIFIED' AND OLD.status IS DISTINCT FROM 'VERIFIED' THEN
    IF NOT EXISTS (SELECT 1 FROM verification_items WHERE order_id = NEW.id)
       OR EXISTS (SELECT 1 FROM verification_items WHERE order_id = NEW.id AND (status IS NULL OR status = 'RED')) THEN
      RAISE EXCEPTION 'Cannot verify: shortage or uncounted components';
    END IF;
  END IF;
  IF OLD.verified_at IS NOT NULL AND (
       NEW.verified_by IS DISTINCT FROM OLD.verified_by OR
       NEW.verified_at IS DISTINCT FROM OLD.verified_at OR
       NEW.wastage_pct IS DISTINCT FROM OLD.wastage_pct) THEN
    RAISE EXCEPTION 'Verification attribution is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_order_guard ON cutting_orders;
CREATE TRIGGER trg_order_guard BEFORE UPDATE ON cutting_orders
  FOR EACH ROW EXECUTE FUNCTION guard_order_verification();
