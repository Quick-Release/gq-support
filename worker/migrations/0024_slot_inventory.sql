-- Append-only version evidence per Slot (src/inventory.ts). Each row is a
-- trusted observation from a signed enrollment or an audited Operator record;
-- the inventory projects the latest of each kind. No secret values or contacts.
CREATE TABLE slot_version_evidence (
  slot TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('desired', 'attempted', 'observed', 'failed')),
  version TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('enrollment', 'operator')),
  evidence TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX slot_version_evidence_latest ON slot_version_evidence (slot, kind, observed_at);

-- Append-only verifications of a Client's independent emergency contact route
-- for a Slot. The route is restricted: only the Operator CLI shows it.
CREATE TABLE slot_contact_verification (
  slot TEXT NOT NULL,
  route TEXT NOT NULL,
  evidence TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  verified_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX slot_contact_verification_latest ON slot_contact_verification (slot, verified_at);
