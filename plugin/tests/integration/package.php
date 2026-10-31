<?php
/**
 * Installed-package lifecycle checks for package.sh, run with `wp eval-file` on a real WordPress
 * installation. Seeds site-owner choices and unrelated data, then checks what an upgrade through
 * the package installer kept and what a real uninstall removed. Uses only WordPress APIs to seed,
 * so the same scenarios run against the previous release's code.
 *
 * @package GQ_Support
 */

$gq_support_scenario = $args[0] ?? '';
$gq_support_fail     = static function ( string $message ): void {
	// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- CLI-only diagnostic.
	throw new RuntimeException( $message );
};

global $wpdb;
$gq_support_subject         = $wpdb->get_blog_prefix() . 'gq_support_reporter_package-test';
$gq_support_snapshot        = get_option( 'package_test_snapshot' );
$gq_support_key_fingerprint = static function (): ?string {
	$gq_support_key = get_option( 'gq_support_signing_key', null );
	// A digest only: the key itself never reaches output.
	return null === $gq_support_key ? null : hash( 'sha256', (string) wp_json_encode( $gq_support_key ) );
};

// Data the plugin does not own: an uninstall or upgrade must leave all of it alone.
$gq_support_unrelated_kept = static function () use ( $gq_support_fail ): void {
	$gq_support_agent = get_role( 'package_test_agent' );
	if ( ! $gq_support_agent || ! $gq_support_agent->has_cap( 'gq_support_submit_requests' ) ) {
		$gq_support_fail( 'A capability the site owner granted to a custom role was removed.' );
	}
	if ( 'keep' !== get_option( 'package_test_sentinel' ) || 'keep' !== get_user_meta( 1, 'package_test_meta', true ) ) {
		$gq_support_fail( 'Unrelated options or user meta were removed.' );
	}
	if ( ! wp_next_scheduled( 'package_test_event' ) ) {
		$gq_support_fail( 'An unrelated scheduled event was removed.' );
	}
};

switch ( $gq_support_scenario ) {
	case 'probe-boundary':
		delete_option( 'package_test_http_calls' );
		delete_transient( 'doing_cron' );
		wp_schedule_single_event( time() - 1, 'package_test_probe_due' );
		$gq_support_cron_requests = 0;
		$gq_support_observe_cron  = static function ( $pre, $request_args, $url ) use ( &$gq_support_cron_requests ) {
			if ( strtok( $url, '?' ) === site_url( 'wp-cron.php' ) ) {
				++$gq_support_cron_requests;
			}
			return $pre;
		};
		add_filter( 'pre_http_request', $gq_support_observe_cron, 9, 3 );
		spawn_cron( time() );
		remove_filter( 'pre_http_request', $gq_support_observe_cron, 9 );
		if ( 1 !== $gq_support_cron_requests ) {
			$gq_support_fail( 'Core cron did not dispatch exactly one request.' );
		}
		wp_clear_scheduled_hook( 'package_test_probe_due' );
		if ( get_option( 'package_test_http_calls', array() ) ) {
			$gq_support_fail( 'Core cron was attributed to the plugin.' );
		}
		// The same URL outside core's cron path must remain detectable.
		wp_remote_post( site_url( 'wp-cron.php?doing_wp_cron=fixture' ) );
		wp_remote_get( 'https://fake-worker.gq-support.test/upgrade-negative-control' );
		if ( 2 !== count( (array) get_option( 'package_test_http_calls', array() ) ) ) {
			$gq_support_fail( 'The upgrade probe missed an outgoing request.' );
		}
		delete_option( 'package_test_http_calls' );
		break;

	case 'seed':
		$gq_support_state = get_option( 'gq_support_state' );
		if ( ! is_array( $gq_support_state ) || empty( $gq_support_state['installation_id'] ) ) {
			$gq_support_fail( 'The installed plugin has no installation identity to preserve.' );
		}
		update_option(
			'package_test_snapshot',
			array(
				'installation_id' => $gq_support_state['installation_id'],
				'origin'          => $gq_support_state['origin'],
				'grants'          => (array) ( $gq_support_state['administrator_grants'] ?? array() ),
				'key'             => $gq_support_key_fingerprint(),
			),
			false
		);
		add_role(
			'package_test_agent',
			'Package test agent',
			array(
				'read'                       => true,
				'gq_support_submit_requests' => true,
			)
		);
		update_user_meta( 1, $gq_support_subject, 'owned-subject' );
		update_user_meta( 1, 'package_test_meta', 'keep' );
		update_option( 'package_test_sentinel', 'keep', false );
		if ( ! wp_next_scheduled( 'package_test_event' ) ) {
			wp_schedule_single_event( time() + DAY_IN_SECONDS, 'package_test_event' );
		}
		break;

	case 'revoke':
		// A deliberate revocation by the site owner, which no upgrade may undo.
		get_role( 'administrator' )->remove_cap( 'gq_support_submit_requests' );
		break;

	case 'upgraded':
		$gq_support_version = $args[1] ?? '';
		if ( ! defined( 'GQ_SUPPORT_VERSION' ) || GQ_SUPPORT_VERSION !== $gq_support_version ) {
			$gq_support_fail( "The running plugin is not release {$gq_support_version}." );
		}
		if ( is_link( WP_PLUGIN_DIR . '/gq-support' ) || realpath( GQ_SUPPORT_PLUGIN_DIR ) !== realpath( WP_PLUGIN_DIR . '/gq-support' ) ) {
			$gq_support_fail( 'The running plugin is not the copy the package installer unpacked.' );
		}
		if ( ! is_plugin_active( 'gq-support/gq-support.php' ) ) {
			$gq_support_fail( 'The upgrade deactivated the plugin.' );
		}
		// package.sh's must-use probe recorded every outgoing request since before the upgrade,
		// including the migration that runs when the plugin boots under WP-CLI.
		// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Simulate WordPress REST context.
		do_action( 'rest_api_init', rest_get_server() );
		if ( ! has_filter( 'pre_http_request', 'gq_support_package_http_probe' ) ) {
			$gq_support_fail( 'The remote-call probe is not loaded.' );
		}
		$gq_support_calls = (array) get_option( 'package_test_http_calls', array() );
		if ( $gq_support_calls ) {
			$gq_support_fail( 'The upgrade contacted a remote service: ' . implode( ', ', $gq_support_calls ) );
		}
		$gq_support_state = get_option( 'gq_support_state' );
		if ( ! is_array( $gq_support_state ) || GQ_Support_State::SCHEMA_VERSION !== $gq_support_state['schema_version'] ) {
			$gq_support_fail( 'The upgrade did not leave the current schema.' );
		}
		if ( $gq_support_snapshot['installation_id'] !== $gq_support_state['installation_id'] || $gq_support_snapshot['origin'] !== $gq_support_state['origin'] ) {
			$gq_support_fail( 'The upgrade changed the installation identity.' );
		}
		if ( $gq_support_snapshot['key'] !== $gq_support_key_fingerprint() ) {
			$gq_support_fail( 'The upgrade changed the signing key.' );
		}
		if ( get_role( 'administrator' )->has_cap( 'gq_support_submit_requests' ) ) {
			$gq_support_fail( 'The upgrade re-granted a capability the site owner revoked.' );
		}
		if ( 'owned-subject' !== get_user_meta( 1, $gq_support_subject, true ) ) {
			$gq_support_fail( 'The upgrade lost a Reporter subject.' );
		}
		$gq_support_unrelated_kept();
		break;

	case 'uninstalled':
		if ( file_exists( WP_PLUGIN_DIR . '/gq-support' ) ) {
			$gq_support_fail( 'Uninstall left the plugin files.' );
		}
		$gq_support_options = $wpdb->get_col( $wpdb->prepare( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s", $wpdb->esc_like( 'gq_support_' ) . '%' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Test-only inventory.
		if ( $gq_support_options ) {
			$gq_support_fail( 'Uninstall kept plugin options: ' . implode( ', ', $gq_support_options ) );
		}
		if ( '' !== get_user_meta( 1, $gq_support_subject, true ) ) {
			$gq_support_fail( 'Uninstall kept this site\'s Reporter subjects.' );
		}
		foreach ( $gq_support_snapshot['grants'] as $gq_support_capability ) {
			if ( get_role( 'administrator' )->has_cap( $gq_support_capability ) ) {
				$gq_support_fail( "Uninstall kept the plugin's own Administrator grant {$gq_support_capability}." );
			}
		}
		if ( wp_next_scheduled( 'gq_support_retry_erasure' ) ) {
			$gq_support_fail( 'Uninstall kept plugin-owned scheduled work.' );
		}
		// The native update key and offer belong to the whole installation, network included.
		if ( false !== get_site_option( 'gq_support_update_key' ) || false !== get_site_option( 'gq_support_update_offer' ) ) {
			$gq_support_fail( 'Uninstall kept the native update key or offer.' );
		}
		$gq_support_unrelated_kept();
		break;

	case 'kept':
		// Uninstall never iterates the network: this site keeps its own rows until it is deleted.
		if ( ! is_array( get_option( 'gq_support_state' ) ) ) {
			$gq_support_fail( 'A main-site uninstall removed another site\'s state.' );
		}
		$gq_support_unrelated_kept();
		break;

	case 'cleanup':
		remove_role( 'package_test_agent' );
		delete_option( 'package_test_sentinel' );
		delete_option( 'package_test_snapshot' );
		delete_option( 'package_test_http_calls' );
		delete_user_meta( 1, 'package_test_meta' );
		delete_user_meta( 1, $gq_support_subject );
		wp_clear_scheduled_hook( 'package_test_event' );
		// Leave the Administrator as the plugin's initial grant made it, for the checks that follow.
		if ( in_array( 'gq_support_submit_requests', (array) ( $gq_support_snapshot['grants'] ?? array() ), true ) && get_option( 'gq_support_state' ) ) {
			get_role( 'administrator' )->add_cap( 'gq_support_submit_requests' );
		}
		break;

	default:
		$gq_support_fail( 'Unknown package scenario.' );
}

WP_CLI::success( $gq_support_scenario );
