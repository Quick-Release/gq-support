-- The ledger epoch this database last replayed (ADR 0016). A restore rewinds
-- it, so an epoch the Operator recorded in the ledger since shows the gap.
CREATE TABLE restore_state (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL DEFAULT 0, replayed_at INTEGER);
INSERT INTO restore_state (id) VALUES (1);
