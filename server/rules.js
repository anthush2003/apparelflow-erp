// Pure domain rules – no I/O, trivially unit-testable.
export const ROLES = { SUPERVISOR: 'cutting_supervisor', VERIFIER: 'cutting_verifier', SEWING: 'sewing_supervisor' };
export const STATUS = {
  IN_PROGRESS: 'CUTTING_IN_PROGRESS', PENDING: 'PENDING_VERIFICATION', REJECTED: 'REJECTED',
  VERIFIED: 'VERIFIED', SEWING: 'SEWING_IN_PROGRESS'
};

// Deterministic state machine: the only legal transitions.
export const TRANSITIONS = {
  CUTTING_IN_PROGRESS: ['PENDING_VERIFICATION'],
  PENDING_VERIFICATION: ['VERIFIED', 'REJECTED'],
  REJECTED: ['PENDING_VERIFICATION'],
  VERIFIED: ['SEWING_IN_PROGRESS'],
  SEWING_IN_PROGRESS: []
};
export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

export function trafficLight(expected, actual) {
  if (actual === null || actual === undefined) return null;
  if (actual === expected) return 'GREEN';
  return actual > expected ? 'YELLOW' : 'RED';
}
export const round2 = (n) => Math.round(n * 100) / 100;
export const wastagePct = (actual, expected) => round2(((actual - expected) / expected) * 100);

// Strict validators: typeof number only – strings, decimals, NaN, Infinity are rejected.
export const isInt = (v, min, max) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
export const isYards = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1_000_000 && Math.round(v * 100) / 100 === v;
export const isRollId = (v) => typeof v === 'string' && /^[A-Za-z0-9-]{3,40}$/.test(v);
