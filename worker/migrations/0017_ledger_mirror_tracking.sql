-- Incremental ledger mirroring (src/ledger.ts). Every write to a mirrored
-- table sets `changed_at`; existing rows start at 0, which the daily full
-- mirror covers, as it does any writer that leaves the default.
ALTER TABLE support_cleanup ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE erasure ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE delivery_suppression ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE offboarding ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX support_cleanup_changed ON support_cleanup (changed_at);
CREATE INDEX erasure_changed ON erasure (changed_at);
CREATE INDEX delivery_suppression_changed ON delivery_suppression (changed_at);
CREATE INDEX offboarding_changed ON offboarding (changed_at);
CREATE INDEX installation_key_revoked ON installation_key (revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX repository_state_suspended ON repository_state (suspended_at) WHERE suspended_reason IS NOT NULL;
-- Mirror watermarks: the start of the last incremental and full passes.
ALTER TABLE restore_state ADD COLUMN mirrored_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE restore_state ADD COLUMN full_mirrored_at INTEGER NOT NULL DEFAULT 0;
