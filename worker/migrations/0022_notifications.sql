-- Discord notification delivery state (#136; docs/support-operations-design.md),
-- kept apart from incident and Support request state. One row per source and
-- destination: `transition` is the latest state to announce and
-- `sent_transition` the latest one Discord confirmed, so a source, destination
-- and transition is announced once unless Discord's outcome was unknown. The
-- known message identity lets a later transition edit the same message.
-- No Submitted text, Reporter identity, webhook credential or URL is stored here.
CREATE TABLE notification (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('support_request', 'incident')),
  source_id TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (destination IN ('support_requests', 'operational_incidents')),
  transition TEXT NOT NULL,
  transition_rank INTEGER NOT NULL,
  sent_transition TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  -- A bounded code from src/notifications.ts, never a provider response.
  error_code TEXT,
  -- The public webhook ID that posted message_id; a rotated webhook posts anew.
  webhook_id TEXT,
  message_id TEXT,
  -- Acceptance or opening time, which bounds how long the row is kept.
  source_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (source_kind, source_id, destination)
);
CREATE INDEX notification_due ON notification (next_attempt_at) WHERE state = 'pending';
CREATE INDEX notification_retention ON notification (source_at);
