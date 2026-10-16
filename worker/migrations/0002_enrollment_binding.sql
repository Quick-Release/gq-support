-- A consumed code identifies the exact binding returned on an interrupted retry.
ALTER TABLE enrollment_code ADD COLUMN consumed_key_id TEXT REFERENCES installation_key (key_id) DEFERRABLE INITIALLY DEFERRED;

-- Fixed-window enrollment abuse counters. Only IP hashes are retained.
CREATE TABLE enrollment_rate (
  ip_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);

CREATE INDEX replay_expiry ON replay (expires_at);
CREATE INDEX enrollment_rate_expiry ON enrollment_rate (window_start);
