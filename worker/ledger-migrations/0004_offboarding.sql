-- Offboarding audit (#147; src/offboarding.ts). Held here, outside the main
-- D1 a restore rewinds, like the offboarding image and the key revocations it
-- records first. Each attempt writes `begin` before changing anything and
-- `complete` once every step applied, with exactly what it revoked, cancelled
-- and left uncertain: opaque IDs, counts and times only. No report text,
-- Reporter IDs, contact routes or secrets. Kept as the minimal authorized
-- audit of ending service; GitHub issues stay with the Client.
CREATE TABLE offboarding_audit (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  actor TEXT NOT NULL,
  evidence TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('begin', 'complete')),
  effects TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX offboarding_audit_slot ON offboarding_audit (slot, occurred_at);
