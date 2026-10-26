<?php
/**
 * Checklist 9 / isolation G: generated and constants-backed keys never leave
 * WordPress in responses, signed HTTP payloads, output or the PHP error log.
 * Run in a separate wp eval-file process for each key source.
 *
 * @package GQ_Support
 */

$gq_support_source = $args[0] ?? 'generated';
if ( ! in_array( $gq_support_source, array( 'generated', 'constants' ), true ) ) {
	throw new RuntimeException( 'Unknown key source.' );
}
$gq_support_log       = wp_tempnam( 'gq-support-key-custody' );
$gq_support_error_log = ini_get( 'error_log' );
$gq_support_logging   = ini_get( 'log_errors' );
// phpcs:disable WordPress.PHP.IniSet -- Capture this disposable CLI process's PHP log.
ini_set( 'error_log', $gq_support_log );
ini_set( 'log_errors', '1' );
ob_start();
try {
	// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedVariableFound -- wp eval-file's scenario argument, consumed by connection.php.
	$args = array( 'constants' === $gq_support_source ? 'constants' : 'no-key-exposure' );
	require __DIR__ . '/connection.php';
	$gq_support_private = GQ_Support_Signing_Key::active();
	if ( null === $gq_support_private ) {
		throw new RuntimeException( 'Key custody probe did not exercise a signing key.' );
	}
	// Also exercise the failure path: provider diagnostics must stay out of state,
	// user-facing status, output and logs, even if an upstream error contains a key.
	$gq_support_service->responder = static fn( array $call ) => new WP_Error(
		'http_request_failed',
		str_contains( $call['url'], '/v1/' ) ? $gq_support_private : 'Offline test provider.'
	);
	$gq_support_failure            = GQ_Support_Connection::test();
	wp_set_current_user( 1 );
	$gq_support_reporter  = wp_get_current_user();
	$gq_support_had_grant = array_key_exists( 'gq_support_submit_requests', $gq_support_reporter->caps );
	$gq_support_grant     = $gq_support_reporter->caps['gq_support_submit_requests'] ?? false;
	$gq_support_reporter->add_cap( 'gq_support_submit_requests' );
	require_once ABSPATH . 'wp-admin/includes/class-wp-screen.php';
	require_once ABSPATH . 'wp-admin/includes/screen.php';
	set_current_screen( 'dashboard' );
	GQ_Support_Plugin::enqueue_launcher();
	$gq_support_bootstrap = wp_scripts()->get_data( 'gq-support-launcher', 'before' );
	if ( ! is_array( $gq_support_bootstrap ) || ! str_contains( implode( '', $gq_support_bootstrap ), 'window.gqSupportLauncher=' ) ) {
		throw new RuntimeException( 'Key custody probe did not produce a Reporter bootstrap.' );
	}
	require_once ABSPATH . 'wp-admin/includes/class-wp-debug-data.php';
	require_once ABSPATH . 'wp-admin/includes/update.php';
	require_once ABSPATH . 'wp-admin/includes/misc.php';
	$gq_support_exposure = array(
		'enrollment' => $gq_support_enrollment_calls ?? $gq_support_service->calls,
		'calls'      => $gq_support_service->calls,
		'status'     => GQ_Support_Connection::status(),
		'failure'    => is_wp_error( $gq_support_failure ) ? $gq_support_failure->get_error_messages() : $gq_support_failure,
		'state'      => GQ_Support_State::get(),
		'health'     => WP_Debug_Data::debug_data(),
		'rest'       => rest_do_request( new WP_REST_Request( 'GET', '/wp/v2/settings' ) )->get_data(),
		'scripts'    => $gq_support_bootstrap,
	);
	// Non-secret controls prove that both capture channels are actually live.
	// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- Verify the isolated log capture.
	error_log( 'custody-log-control' );
	echo 'custody-output-control';
	$gq_support_exposure['output'] = ob_get_contents();
	// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Read the isolated PHP error log, never print it.
	$gq_support_exposure['log'] = file_get_contents( $gq_support_log );
	if ( ! str_contains( (string) $gq_support_exposure['log'], 'custody-log-control' ) || ! str_contains( (string) $gq_support_exposure['output'], 'custody-output-control' ) ) {
		throw new RuntimeException( 'Key custody capture is not active.' );
	}
	$gq_support_needles = array();
	foreach ( array( $gq_support_private, substr( $gq_support_private, 0, 32 ) ) as $gq_support_material ) {
		$gq_support_encoded   = GQ_Support_Signing_Key::encode( $gq_support_material );
		$gq_support_needles[] = $gq_support_material;
		$gq_support_needles[] = $gq_support_encoded;
		$gq_support_needles[] = str_replace( '/', '\\/', $gq_support_encoded );
		$gq_support_needles[] = bin2hex( $gq_support_material );
	}
	// Inspect string values before JSON encoding can escape or scrub key bytes.
	$gq_support_detect = static function ( array $surfaces ) use ( $gq_support_needles ): bool {
		$found = false;
		array_walk_recursive(
			$surfaces,
			static function ( $value ) use ( $gq_support_needles, &$found ): void {
				if ( is_string( $value ) ) {
					foreach ( $gq_support_needles as $needle ) {
						$found = $found || str_contains( $value, $needle );
					}
				}
			}
		);
		return $found;
	};
	foreach ( $gq_support_needles as $gq_support_control ) {
		if ( ! $gq_support_detect( array( 'enrollment' => array( 'body' => array( 'leaked_key' => $gq_support_control ) ) ) ) || ! $gq_support_detect( array( 'log' => 'leaked: ' . $gq_support_control ) ) ) {
			throw new RuntimeException( 'Key custody detector missed its injected leak control.' );
		}
	}
	$gq_support_control = 'window.gqSupportLauncher=' . wp_json_encode( array( 'leaked_key' => GQ_Support_Signing_Key::encode( $gq_support_private ) ) );
	if ( ! $gq_support_detect( array( 'scripts' => array( $gq_support_control ) ) ) ) {
		throw new RuntimeException( 'Key custody detector missed an escaped bootstrap leak.' );
	}
	foreach ( $gq_support_exposure as $gq_support_surface => $gq_support_values ) {
		if ( $gq_support_detect( array( $gq_support_values ) ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- Surface name only, never key material.
			throw new RuntimeException( 'Private signing material escaped WordPress custody: ' . $gq_support_surface );
		}
	}
} finally {
	// A temporary bootstrap grant must not override later role revocation tests.
	if ( isset( $gq_support_reporter ) ) {
		if ( $gq_support_had_grant ) {
			$gq_support_reporter->add_cap( 'gq_support_submit_requests', $gq_support_grant );
		} else {
			$gq_support_reporter->remove_cap( 'gq_support_submit_requests' );
		}
	}
	ob_end_clean();
	ini_set( 'error_log', $gq_support_error_log );
	ini_set( 'log_errors', $gq_support_logging );
	// phpcs:enable
	wp_delete_file( $gq_support_log );
}
WP_CLI::success( 'Signing key custody: ' . $gq_support_source );
