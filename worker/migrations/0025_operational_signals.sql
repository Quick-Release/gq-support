-- Routed operational signals (#138; docs/support-operations-design.md). The
-- incident's current stage within its category, a bounded code validated in
-- src/operational-signals.ts, such as an uncertain create reaching Operator handoff.
ALTER TABLE incident ADD COLUMN detail TEXT;
-- Incident transition ranks now leave room for each state's stages (src/notifications.ts).
UPDATE notification SET transition_rank = transition_rank * 100 WHERE source_kind = 'incident';
-- Aggregate operational metrics, one row per UTC hour, metric, bounded outcome
-- and Client. Dimensions are closed sets validated in src/operational-metrics.ts;
-- `client` is a reviewed mapping's Client for verified work only, else ''.
-- Counts and durations only: no request, Reporter, credential, URL, header,
-- payload or exception text. Kept 12 months.
CREATE TABLE operational_metric (
  hour INTEGER NOT NULL,
  metric TEXT NOT NULL,
  outcome TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL,
  total_ms INTEGER NOT NULL DEFAULT 0,
  max_ms INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (hour, metric, outcome, client)
);
CREATE INDEX operational_metric_recent ON operational_metric (metric, outcome, last_at);
-- How far GitHub's webhook delivery log has been counted (src/webhook-deliveries.ts):
-- the latest delivery time counted and the GitHub delivery GUIDs counted at that time.
CREATE TABLE webhook_delivery_scan (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  delivered_through INTEGER NOT NULL,
  guids TEXT NOT NULL
);
