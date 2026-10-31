-- Native WordPress update access (src/update-access.ts, #142). A narrow update
-- grant per Slot, independent of the report Installation credential: it reads
-- only the approved release's metadata and package bytes. Grants and revocations
-- are append-only audited Operator records, each written in one statement. No
-- report content, Reporter IDs or secrets: only public keys and digests.

-- An update key a native installation generated, granted to one Slot until
-- expires_at. The Slot's newest grant supersedes its older ones.
CREATE TABLE update_access_grant (
  -- Lowercase hex SHA-256 of the raw Ed25519 public key.
  key_id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  public_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL
);

CREATE INDEX update_access_grant_slot ON update_access_grant (slot);

-- A revoked grant, never lifted. Also recorded in the suppression ledger first,
-- so a restore of this database cannot revive it (src/ledger.ts).
CREATE TABLE update_access_revocation (
  key_id TEXT PRIMARY KEY REFERENCES update_access_grant (key_id),
  slot TEXT NOT NULL,
  evidence TEXT NOT NULL,
  revoked_by TEXT NOT NULL,
  revoked_at INTEGER NOT NULL
);

-- Request IDs already used by an update key, until its signatures expire.
CREATE TABLE update_replay (
  key_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, request_id)
);

CREATE INDEX update_replay_expiry ON update_replay (expires_at);

-- Short-lived download access to one approved release, issued by an
-- authenticated metadata request. Only the token's SHA-256 is stored.
CREATE TABLE update_download_grant (
  grant_hash TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  release_sequence INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX update_download_grant_expiry ON update_download_grant (expires_at);

-- The approved package last served to each Slot's native updater: an attempt,
-- never a completed update. One row per Slot.
CREATE TABLE slot_update_attempt (
  slot TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
