import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-only-secret');
if (!SECRET) throw new Error('JWT_SECRET must be set in production');

export const signToken = (u) => jwt.sign({ sub: u.id, role: u.role, name: u.full_name }, SECRET, { expiresIn: '8h' });

// Identity comes ONLY from the verified JWT – never from the request body.
export function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const p = jwt.verify(token, SECRET);
    req.user = { id: p.sub, role: p.role, name: p.name };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden: your role cannot perform this action' });
