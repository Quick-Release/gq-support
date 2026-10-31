-- Discord waits apply to a destination across ticks and newly queued sources.
CREATE TABLE notification_cooldown (
  destination TEXT PRIMARY KEY CHECK (destination IN ('support_requests', 'operational_incidents')),
  retry_at INTEGER NOT NULL
);
