---
status: accepted
---

# Support records belong to the Slot, not the installation ID

Every Support request, Submission ID and delivery intent in D1 is keyed by the Operator-approved Slot, and the installation-scoped storage seam from ADR 0013 takes a Slot. The WordPress installation ID is recorded only as the key binding and as an audit column. We chose this because the plugin issues a new installation ID whenever `home_url()` changes, and the Operator re-enrolls that site into the same Slot; keyed by installation ID, every Reporter on a site that changed domain would lose their request history, even though their Reporter subjects survive in user meta. A staging copy still sees nothing, because it enrolls into a different Slot. The trade-off is that a copy wrongly enrolled into a production Slot would see production requests. Re-enrollment revokes the previous key, so only one site can use a Slot at a time.
