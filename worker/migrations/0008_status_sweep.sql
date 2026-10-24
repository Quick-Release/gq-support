-- Support status refresh from GitHub (#50, #51). Bookkeeping only: no
-- payload, delivery ID or Reporter content. `last_swept_at` exists since 0001.
-- GitHub's `updated_at` of the last applied observation. An older one never overwrites it.
ALTER TABLE support_request ADD COLUMN status_source_updated_at INTEGER;
-- A target-keyed refresh obligation, set by a webhook or the daily pass.
ALTER TABLE support_request ADD COLUMN status_refresh_due_at INTEGER;
ALTER TABLE support_request ADD COLUMN status_refresh_attempts INTEGER NOT NULL DEFAULT 0;
-- When sweeping this repository began, so lag is measurable before a first success.
ALTER TABLE repository_state ADD COLUMN sweep_scheduled_at INTEGER;
-- Least recently attempted first, so a failing repository cannot starve others.
ALTER TABLE repository_state ADD COLUMN sweep_attempted_at INTEGER;
-- A sweep in progress: its start time and its (updated_at, page) keyset position.
ALTER TABLE repository_state ADD COLUMN sweep_started_at INTEGER;
ALTER TABLE repository_state ADD COLUMN sweep_cursor INTEGER;
ALTER TABLE repository_state ADD COLUMN sweep_page INTEGER;
