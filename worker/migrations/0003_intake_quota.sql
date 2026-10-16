-- Atomic intake quotas (docs/support-delivery-design.md). One row per accepted
-- Support request and quota scope: `subject` is the Reporter subject, or ''
-- for the Slot's own budget. Keyed by Slot, so re-enrollment never resets it.
-- Acceptance purges rows older than the longest window.
CREATE TABLE intake_debit (
  slot TEXT NOT NULL,
  subject TEXT NOT NULL,
  debited_at INTEGER NOT NULL
);

CREATE INDEX intake_debit_window ON intake_debit (slot, subject, debited_at);
