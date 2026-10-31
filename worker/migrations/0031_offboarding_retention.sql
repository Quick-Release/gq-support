-- Offboarding and contact retention (#147; src/offboarding.ts, src/cleanup.ts).
-- A Slot whose rows remain with no Repository mapping and no offboarding:
-- when the cleanup pass first found it unmapped. Its contact routes and other
-- Slot rows go 30 days later, the offboarding grace; mapping it again clears
-- the clock. No report content, contact routes or secrets.
CREATE TABLE slot_unmapped (
  slot TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL
);

-- The responsible responder the Client named for its independent contact,
-- and how the route was verified. Only `separate-device-drill`, a live
-- contact from a device separate from the WordPress installation, verifies
-- it; an `attestation` is recorded but never counts as verified. Rows from
-- before this migration have neither and stay unverified.
ALTER TABLE slot_contact_verification ADD COLUMN responder TEXT;
ALTER TABLE slot_contact_verification ADD COLUMN method TEXT CHECK (method IN ('separate-device-drill', 'attestation'));
