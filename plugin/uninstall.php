<?php
/**
 * Fired when the plugin is uninstalled.
 *
 * @package GQ_Support
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

// Never iterate an entire network during uninstall or contact external services.
// WordPress removes a deleted site's options with that site's tables.
// Offboarding is the operator's `revoke <slot>`; the service keeps its records under its own retention.
$gq_support_state           = get_option( 'gq_support_state' );
$gq_support_recorded_grants = is_array( $gq_support_state ) && isset( $gq_support_state['administrator_grants'] )
	? $gq_support_state['administrator_grants']
	: get_option( 'gq_support_administrator_grants', array() );
$gq_support_administrator   = get_role( 'administrator' );
if ( $gq_support_administrator ) {
	foreach ( (array) $gq_support_recorded_grants as $gq_support_capability ) {
		if ( in_array( $gq_support_capability, array( 'gq_support_submit_requests', 'gq_support_manage_settings' ), true ) ) {
			$gq_support_administrator->remove_cap( $gq_support_capability );
		}
	}
}
delete_option( 'gq_support_state' );
delete_option( 'gq_support_signing_key' );
// Options from before schema 4, for sites uninstalled before they migrated.
delete_option( 'gq_support_administrator_grants' );
delete_option( 'gq_support_connection' );
delete_option( 'gq_support_schema_version' );
delete_option( 'gq_support_installation_id' );
delete_option( 'gq_support_installation_origin' );
