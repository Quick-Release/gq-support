-- When the reference search stopped being pending (#46): a never-closed
-- erasure's tombstone window starts there, not at recording. An existing
-- finished search takes the row's last change, which is no earlier, or the
-- migration time when that is unknown. `changed_at` moves too, so the next
-- mirror pass carries the new column to the ledger.
ALTER TABLE erasure ADD COLUMN search_ended_at INTEGER;
UPDATE erasure SET search_ended_at = CASE WHEN changed_at > 0 THEN MAX(recorded_at, changed_at) ELSE CAST(strftime('%s', 'now') AS INTEGER) * 1000 END,
  changed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE search_state != 'pending';
