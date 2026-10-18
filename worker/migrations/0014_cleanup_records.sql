-- Self-contained cleanup records. Once captured, a cleanup row alone
-- identifies a possible GitHub side effect, so the request rows are deleted.
ALTER TABLE support_cleanup ADD COLUMN intent_id TEXT;
ALTER TABLE support_cleanup ADD COLUMN github_installation_id INTEGER;
ALTER TABLE support_cleanup ADD COLUMN repository_id INTEGER;
ALTER TABLE support_cleanup ADD COLUMN attempt_started_at INTEGER;
ALTER TABLE support_cleanup ADD COLUMN attempt_ended_at INTEGER;
-- Issues still to redact, as a JSON array of {id, nodeId, number}.
ALTER TABLE support_cleanup ADD COLUMN issues_json TEXT;
CREATE INDEX support_cleanup_intent ON support_cleanup (intent_id);
