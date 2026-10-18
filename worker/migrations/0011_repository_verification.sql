-- Only an Operator can lift a suspension, after a later passing sweep (#53).
ALTER TABLE repository_state ADD COLUMN verified_safe_at INTEGER;
-- Fences a passing read that began before a newer unsafe observation.
ALTER TABLE repository_state ADD COLUMN unsafe_observed_at INTEGER;
