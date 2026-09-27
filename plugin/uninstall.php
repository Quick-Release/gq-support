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
delete_option( 'gq_support_schema_version' );
delete_option( 'gq_support_installation_id' );
delete_option( 'gq_support_installation_origin' );
