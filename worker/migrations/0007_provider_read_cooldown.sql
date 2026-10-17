-- Provider throttling covers reads as well as mutations. It is independent
-- from the mutation interval and the execution-drain ownership window.
ALTER TABLE delivery_permit ADD COLUMN provider_cooldown_until INTEGER NOT NULL DEFAULT 0;
