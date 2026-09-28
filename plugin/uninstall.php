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
if ( get_option( 'gq_support_administrator_grant' ) ) {
	$gq_support_administrator = get_role( 'administrator' );
	if ( $gq_support_administrator ) {
		$gq_support_administrator->remove_cap( 'gq_support_submit_requests' );
	}
}
delete_option( 'gq_support_administrator_grant' );
delete_option( 'gq_support_connection' );
delete_option( 'gq_support_schema_version' );
delete_option( 'gq_support_installation_id' );
delete_option( 'gq_support_installation_origin' );
