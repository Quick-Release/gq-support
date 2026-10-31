<?php
/**
 * Upgrade HTTP probe, loaded as a must-use plugin before either package boots.
 *
 * @package GQ_Support
 */

/**
 * Block all transport and record requests except verified WordPress core work.
 *
 * @param mixed  $pre  Earlier short-circuit result.
 * @param array  $args HTTP arguments.
 * @param string $url  Request URL.
 * @return WP_Error No request reaches the network.
 */
function gq_support_package_http_probe( $pre, $args, $url ) {
	// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_debug_backtrace -- Attribute the request before excluding core work.
	$files         = array_column( debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS ), 'file' );
	$plugin_root   = realpath( WP_PLUGIN_DIR . '/gq-support' );
	$plugin_call   = false;
	$core_cron     = false;
	$core_cron_php = realpath( ABSPATH . WPINC . '/cron.php' );
	foreach ( $files as $file ) {
		$file = realpath( $file );
		if ( $file && $plugin_root && ( $file === $plugin_root . '/gq-support.php' || str_starts_with( $file, $plugin_root . '/includes/' ) ) ) {
			$plugin_call = true;
		}
		if ( $file && $file === $core_cron_php ) {
			$core_cron = true;
		}
	}
	// phpcs:ignore WordPress.WP.CapitalPDangit.MisspelledInText -- Literal hostname in the core update URL pattern.
	$core_update = preg_match( '#^https?://([a-z0-9-]+\.)*wordpress\.org/#i', $url );
	$core_spawn  = $core_cron && strtok( $url, '?' ) === site_url( 'wp-cron.php' );
	if ( $plugin_call || ( ! $core_update && ! $core_spawn ) ) {
		update_option( 'package_test_http_calls', array_merge( (array) get_option( 'package_test_http_calls', array() ), array( $url ) ), false );
	}
	return new WP_Error( 'http_request_failed', 'No remote calls during an upgrade.' );
}
add_filter( 'pre_http_request', 'gq_support_package_http_probe', 10, 3 );
