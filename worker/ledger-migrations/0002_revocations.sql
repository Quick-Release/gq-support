-- Runtime key revocations: a site's self-revocation and a re-enrollment's
-- replacement of its previous key. Operator revocations also stay in
-- revocations.json. Expands the kind constraint without rewriting history.
CREATE TABLE ledger_entry_v2 (
  kind TEXT NOT NULL CHECK (kind IN ('suppression', 'erasure', 'cleanup', 'offboarding', 'suspension', 'revocation')),
  reference TEXT NOT NULL,
  payload TEXT,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (kind, reference)
);
INSERT INTO ledger_entry_v2 SELECT * FROM ledger_entry;
DROP TABLE ledger_entry;
ALTER TABLE ledger_entry_v2 RENAME TO ledger_entry;
CREATE INDEX ledger_entry_removed ON ledger_entry (recorded_at) WHERE payload IS NULL;
