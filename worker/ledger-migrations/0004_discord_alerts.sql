-- Independent of SupportDB restores. Finite operational classes, no report identifiers or content.
CREATE TABLE discord_alert (
  signal TEXT PRIMARY KEY,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  count INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  version INTEGER NOT NULL,
  sent_version INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE discord_alert_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT,
  next_at INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1))
);
INSERT INTO discord_alert_control (id) VALUES (1);
