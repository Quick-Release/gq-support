-- Remote Operator queries are individual statements. Keep the claim and its
-- audit metadata atomic even without a D1 batch transport. The immutable claim
-- fields are projected into the Operator audit alongside open/resolve events.
ALTER TABLE incident ADD COLUMN claim_via TEXT CHECK (claim_via IN ('api', 'operator'));
UPDATE incident SET claim_via = (SELECT via FROM incident_audit WHERE id = incident.claim_audit_id)
WHERE claimant IS NOT NULL;
