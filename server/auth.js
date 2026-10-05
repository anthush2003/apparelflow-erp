import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-only-secret');
if (!SECRET) throw new Error('JWT_SECRET must be set in production');

export const ROLES = Object.freeze({
  SUPERVISOR: 'cutting_supervisor',
  VERIFIER: 'cutting_verifier',
  SEWING: 'sewing_supervisor'
});

export const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.SUPERVISOR]: ['orders.read', 'orders.create', 'orders.submit', 'orders.reopen', 'recipes.read'],
  [ROLES.VERIFIER]: ['orders.read', 'verification.read', 'verification.counts', 'verification.approve', 'verification.reject', 'recipes.read'],
  [ROLES.SEWING]: ['sewing.read', 'sewing.start', 'orders.read']
});

export const getRolePermissions = (role) => ROLE_PERMISSIONS[role] || [];
export const hasPermission = (role, permission) => getRolePermissions(role).includes(permission);

export const signToken = (u) => jwt.sign({
  sub: u.id,
  role: u.role,
  name: u.full_name,
  permissions: getRolePermissions(u.role)
}, SECRET, { expiresIn: '8h' });

// Identity comes ONLY from the verified JWT – never from the request body.
export function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const p = jwt.verify(token, SECRET);
    req.user = {
      id: p.sub,
      role: p.role,
      name: p.name,
      permissions: Array.isArray(p.permissions) ? p.permissions : getRolePermissions(p.role)
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export const requirePermission = (...permissions) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });

  const granted = permissions.some((permission) => req.user.permissions.includes(permission));
  if (granted) return next();
  return res.status(403).json({ error: 'Forbidden: your role cannot perform this action' });
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (roles.includes(req.user.role)) return next();
  return res.status(403).json({ error: 'Forbidden: your role cannot perform this action' });
};
