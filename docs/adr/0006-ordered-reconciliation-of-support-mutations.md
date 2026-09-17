# Support mutations are ordered and reconciled before retry

Delivery intents for one support request preserve order: a reply or close/reopen action cannot be accepted ahead of an unresolved request creation or earlier mutation. An outcome-unknown intent is reconciled with the provider before retrying, and idempotency keys prevent known duplicate submissions. This favors honest pending states and recoverability over pretending that GitHub side effects are exactly once.
