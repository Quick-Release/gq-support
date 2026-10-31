-- The independent checker's reported observations (#139; src/independent-check.ts).
-- One row per component: its latest reported state and when the checker saw it.
-- No URL, credential, response body or request data.
CREATE TABLE independent_component (
  component TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  code TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
-- Each outage interval the checker observed, linked to the one incident it was
-- reconciled into, so a resent episode never opens another.
CREATE TABLE independent_episode (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  code TEXT NOT NULL,
  first_failed_at INTEGER NOT NULL,
  last_failed_at INTEGER NOT NULL,
  recovered_at INTEGER,
  incident_id TEXT NOT NULL REFERENCES incident (id),
  received_at INTEGER NOT NULL
);
CREATE INDEX independent_episode_incident ON independent_episode (incident_id);
