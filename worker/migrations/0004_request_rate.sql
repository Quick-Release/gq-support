-- Fixed-window request budgets for every authenticated /v1/requests call,
-- including reads and same-key create lookups. `subject` is the Reporter
-- subject, or '' for the Slot's own budget. Old windows are purged per Slot.
CREATE TABLE request_rate (
  slot TEXT NOT NULL,
  subject TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  PRIMARY KEY (slot, subject)
);
