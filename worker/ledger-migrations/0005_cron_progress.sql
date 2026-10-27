-- Aggregate observation only; never replayed into SupportDB or admitted as work.
CREATE TABLE cron_progress_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  watermark INTEGER NOT NULL DEFAULT 0,
  partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1))
);
INSERT INTO cron_progress_control (id) VALUES (1);
CREATE TABLE cron_progress (
  cell INTEGER PRIMARY KEY,
  stage TEXT NOT NULL CHECK (stage IN ('staging', 'prod')),
  candidate TEXT NOT NULL,
  generation INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt IN (1, 2, 3, 4)),
  started INTEGER NOT NULL,
  terminal INTEGER,
  outcome TEXT CHECK (outcome IN ('settled', 'failed', 'interrupted')),
  delivery TEXT NOT NULL CHECK (delivery IN ('ok', 'failed', 'timed_out', 'contained', 'not_run')),
  cleanup TEXT NOT NULL CHECK (cleanup IN ('ok', 'failed', 'timed_out', 'contained', 'not_run')),
  refresh TEXT NOT NULL CHECK (refresh IN ('ok', 'failed', 'timed_out', 'contained', 'not_run')),
  sweep TEXT NOT NULL CHECK (sweep IN ('ok', 'failed', 'timed_out', 'contained', 'not_run')),
  drain TEXT NOT NULL CHECK (drain IN ('ok', 'failed', 'timed_out', 'contained', 'not_run'))
);
