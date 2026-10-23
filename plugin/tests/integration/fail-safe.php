<?php
/**
 * The local support fail-safe and independent help contact (docs/research/outage-draft-recovery.md, tests 8 and 11).
 * Run with wp eval-file in its own process: it defines GQ_SUPPORT_DISABLED, which cannot be undefined.
 *
 * @package GQ_Support
 */

$gq_support_assert = static function ( bool $condition, string $message ): void {
	if ( ! $condition ) {
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- CLI diagnostic only.
		throw new RuntimeException( $message );
	}
};
// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Local versioned JSON fixture.
$gq_support_fixture = current( wp_list_filter( json_decode( file_get_contents( __DIR__ . '/../../../contract/fixtures/local-errors.json' ), true ), array( 'scenario' => 'disabled' ) ) );
$gq_support_seen    = array();
$gq_support_stub    = static function ( $preempt, array $args, string $url ) use ( &$gq_support_seen ) {
	$gq_support_seen[] = $url;
	return new WP_Error( 'http_request_failed', 'The fail-safe must not reach the network.' );
};
$gq_support_request = static function ( string $method, string $path = '/requests', ?string $nonce = null ): WP_REST_Response {
	$request = new WP_REST_Request( $method, '/gq-support/v1' . $path );
	$request->set_header( 'X-WP-Nonce', $nonce ?? wp_create_nonce( 'wp_rest' ) );
	if ( 'POST' === $method ) {
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body(
			(string) wp_json_encode(
				array(
					'submission_id' => '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11',
					'description'   => 'A private report',
				)
			)
		);
	}
	$response = rest_do_request( $request );
	// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Core's REST response filter, which sends no-store.
	return apply_filters( 'rest_post_dispatch', $response, rest_get_server(), $request );
};

// The independent contact: an Operator-verified https, mailto or tel route, never prefilled.
$gq_support_contacts = array(
	array( 'https://help.example.test/support', 'Help desk', 'Help desk' ),
	array( 'https://help.example.test/support#contact', null, 'help.example.test' ),
	array( 'mailto:help@example.test', '', 'help@example.test' ),
	array( 'tel:+351210000000', ' Call us ', 'Call us' ),
	array( 'https://help.example.test/' . str_repeat( 'a', 2048 - 26 ), null, 'help.example.test' ),
	array( 'https://help.example.test/' . str_repeat( 'a', 2049 - 26 ), null, null ),
	array( 'http://help.example.test/', null, null ),
	array( 'javascript:alert(1)', null, null ),
	array( 'https://help.example.test/?body=report', null, null ),
	array( 'mailto:help@example.test?subject=Report', null, null ),
	array( 'mailto:help@example.test?body=A%20private%20report', null, null ),
	array( 'https://user:secret@help.example.test/', null, null ),
	array( 'https://help.example.test/ space', null, null ),
	array( 'tel:call-us', null, null ),
	array( '', null, null ),
	array( array( 'https://help.example.test/' ), null, null ),
	array( 'https://help.example.test/', str_repeat( 'é', 120 ), str_repeat( 'é', 120 ) ),
	array( 'https://help.example.test/', str_repeat( 'é', 121 ), null ),
	array( 'https://help.example.test/', "Two\nlines", null ),
);
foreach ( $gq_support_contacts as list( $gq_support_url, $gq_support_label, $gq_support_expected ) ) {
	$gq_support_contact = GQ_Support_Fail_Safe::contact( $gq_support_url, $gq_support_label );
	$gq_support_valid   = null !== $gq_support_expected && array(
		'url'   => $gq_support_url,
		'label' => $gq_support_expected,
	) === $gq_support_contact;
	$gq_support_assert( null === $gq_support_expected ? null === $gq_support_contact : $gq_support_valid, 'Unexpected contact validation for ' . wp_json_encode( array( $gq_support_url, $gq_support_label ) ) );
}
$gq_support_assert( null === GQ_Support_Fail_Safe::help() && ! GQ_Support_Fail_Safe::help_configured(), 'No contact is invented when none is configured.' );
$gq_support_assert( ! GQ_Support_Fail_Safe::disabled(), 'Support is enabled unless GQ_SUPPORT_DISABLED is set.' );

$gq_support_user              = wp_insert_user(
	array(
		'user_login' => 'disabled-reporter-' . wp_generate_uuid4(),
		'user_pass'  => wp_generate_password(),
		'user_email' => 'disabled-reporter-' . wp_generate_uuid4() . '@example.test',
		'role'       => 'subscriber',
	)
);
$gq_support_original_state    = GQ_Support_State::get();
$gq_support_original_key      = get_option( GQ_Support_Signing_Key::OPTION );
$gq_support_original_erasures = get_option( GQ_Support_Privacy::ERASURES_OPTION );
try {
	$gq_support_assert( is_array( $gq_support_fixture ) && 503 === $gq_support_fixture['status'] && 'gq_support_disabled' === $gq_support_fixture['code'], 'The shared fixture lists the fail-safe error.' );
	$gq_support_assert( is_int( $gq_support_user ), 'Create Reporter.' );
	GQ_Support_Signing_Key::pending_for( 'DISABLED-TEST' );
	GQ_Support_Signing_Key::promote();
	GQ_Support_State::update(
		array(
			'connection' => 'connected',
			'key_id'     => 'disabled-test-key',
		)
	);
	add_filter( 'pre_http_request', $gq_support_stub, 10, 3 );
	// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- The plugin's own constant.
	define( 'GQ_SUPPORT_DISABLED', true );

	// Anonymous callers still get the ordinary authorization error: the fail-safe never makes a route public.
	wp_set_current_user( 0 );
	$gq_support_assert( 401 === $gq_support_request( 'GET' )->get_status(), 'The fail-safe must not bypass authentication.' );

	wp_set_current_user( $gq_support_user );
	wp_get_current_user()->add_cap( 'gq_support_submit_requests' );
	$gq_support_token            = WP_Session_Tokens::get_instance( $gq_support_user )->create( time() + HOUR_IN_SECONDS );
	$_COOKIE[ LOGGED_IN_COOKIE ] = wp_generate_auth_cookie( $gq_support_user, time() + HOUR_IN_SECONDS, 'logged_in', $gq_support_token );
	$gq_support_assert( 403 === $gq_support_request( 'GET', '/requests', 'expired' )->get_status(), 'The fail-safe must not bypass the REST nonce.' );

	foreach ( array( array( 'POST', '/requests' ), array( 'GET', '/requests' ), array( 'GET', '/requests/req_01J8Z6Q4M1ZC7X000000000000' ) ) as list( $gq_support_method, $gq_support_path ) ) {
		$gq_support_response = $gq_support_request( $gq_support_method, $gq_support_path );
		$gq_support_data     = $gq_support_response->get_data();
		$gq_support_label    = "{$gq_support_method} {$gq_support_path}";
		$gq_support_assert( $gq_support_fixture['status'] === $gq_support_response->get_status(), "{$gq_support_label} must return 503." );
		$gq_support_assert( $gq_support_fixture['code'] === $gq_support_data['code'], "{$gq_support_label} must return gq_support_disabled." );
		$gq_support_assert( false === $gq_support_data['data']['retryable'], "{$gq_support_label} must not be retryable." );
		$gq_support_assert( 'private, no-store' === $gq_support_response->get_headers()['Cache-Control'], "{$gq_support_label} must not be cached." );
		$gq_support_assert( ! str_contains( (string) wp_json_encode( $gq_support_data ), 'A private report' ), "{$gq_support_label} must not echo report text." );
	}
	$gq_support_assert( array() === $gq_support_seen, 'Disabled support routes must not contact the service.' );

	// The Report context preview collects nothing while support is disabled.
	$_POST           = array(
		'session'       => GQ_Support_Access::session(),
		'nonce'         => wp_create_nonce( 'wp_rest' ),
		'submission_id' => '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11',
		'screen'        => 'dashboard',
	);
	$gq_support_exit = new class() extends Exception {};
	$gq_support_done = static function () use ( $gq_support_exit ) {
		return static function () use ( $gq_support_exit ) {
			throw $gq_support_exit;
		};
	};
	add_filter( 'wp_doing_ajax', '__return_true' );
	add_filter( 'wp_die_ajax_handler', $gq_support_done );
	ob_start();
	try {
		do_action( 'wp_ajax_gq_support_context' ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Core's AJAX hook for the plugin's action.
	} catch ( Exception $gq_support_error ) {
		$gq_support_assert( $gq_support_error === $gq_support_exit, 'The preview ends as an AJAX response.' );
	} finally {
		$gq_support_preview = (string) ob_get_clean();
		remove_filter( 'wp_doing_ajax', '__return_true' );
		remove_filter( 'wp_die_ajax_handler', $gq_support_done );
		$_POST = array();
	}
	$gq_support_assert( '{"state":"disabled"}' === $gq_support_preview, 'A disabled site previews no Report context.' );
	$gq_support_assert( array() === $gq_support_seen, 'A disabled preview contacts no service.' );

	// Setup operations, shared by the setup page and WP-CLI, refuse before any service call or local change.
	$gq_support_state = GQ_Support_State::get();
	$gq_support_key   = get_option( GQ_Support_Signing_Key::OPTION );
	foreach ( array( 'enroll', 'test', 'disconnect' ) as $gq_support_operation ) {
		$gq_support_result = 'enroll' === $gq_support_operation ? GQ_Support_Connection::enroll( 'ABCD-EFGH-IJKL' ) : GQ_Support_Connection::$gq_support_operation();
		$gq_support_assert( is_wp_error( $gq_support_result ) && 'gq_support_disabled' === $gq_support_result->get_error_code(), "{$gq_support_operation} must report the fail-safe." );
	}
	$gq_support_assert( GQ_Support_State::get() === $gq_support_state && get_option( GQ_Support_Signing_Key::OPTION ) === $gq_support_key, 'The fail-safe must not revoke, rotate or forget the Installation credential.' );

	$gq_support_assert( array() === $gq_support_seen, 'Disabled setup operations must not contact the service.' );

	// Privacy tools remain available, using the same signed transport while the widget is off.
	global $wpdb;
	$gq_support_subject = wp_generate_uuid4();
	add_user_meta( $gq_support_user, $wpdb->get_blog_prefix() . 'gq_support_reporter_' . GQ_Support_State::get()['installation_id'], $gq_support_subject, true );
	$gq_support_email = get_userdata( $gq_support_user )->user_email;
	remove_filter( 'pre_http_request', $gq_support_stub );
	$gq_support_privacy_stub = static function ( $preempt, array $args, string $url ) use ( &$gq_support_seen ) {
		$gq_support_seen[] = array( $url, $args );
		return array(
			'response' => array( 'code' => 'POST' === $args['method'] ? 202 : 200 ),
			'headers'  => array(),
			'body'     => wp_json_encode(
				array(
					'items'       => array(
						array(
							'id'      => 'req_01J8Z6Q4M1ZC7X000000000000',
							'summary' => 'Private export',
						),
					),
					'next_cursor' => null,
					'id'          => 'era_01J8Z6Q4M1ZC7X000000000000',
					'state'       => 'completed',
					'counts'      => array( 'purged' => 1 ),
				),
			),
		);
	};
	add_filter( 'pre_http_request', $gq_support_privacy_stub, 10, 3 );
	$gq_support_exporters = apply_filters( 'wp_privacy_personal_data_exporters', array() ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Core privacy filter.
	$gq_support_erasers   = apply_filters( 'wp_privacy_personal_data_erasers', array() ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Core privacy filter.
	$gq_support_exported  = $gq_support_exporters['gq-support']['callback']( $gq_support_email, 1 );
	$gq_support_assert( ! is_wp_error( $gq_support_exported ) && true === $gq_support_exported['done'] && str_contains( wp_json_encode( $gq_support_exported['data'] ), 'Private export' ), 'Disabled support still exports Submitted text.' );
	$gq_support_erased = $gq_support_erasers['gq-support']['callback']( $gq_support_email, 1 );
	$gq_support_assert( ! is_wp_error( $gq_support_erased ) && true === $gq_support_erased['items_removed'] && false === $gq_support_erased['items_retained'], 'Disabled support still reports a completed erasure.' );
	$gq_support_assert( 2 === count( $gq_support_seen ), 'Both privacy callbacks reach the Worker.' );
	foreach ( $gq_support_seen as list( $gq_support_url, $gq_support_args ) ) {
		$gq_support_assert( ! empty( $gq_support_args['headers']['GQ-Support-Signature'] ), 'Disabled privacy calls remain signed.' );
	}

	// A real transport failure still schedules the deleted-user retry, which can reach the Worker.
	remove_filter( 'pre_http_request', $gq_support_privacy_stub );
	add_filter( 'pre_http_request', $gq_support_stub, 10, 3 );
	require_once ABSPATH . 'wp-admin/includes/user.php';
	wp_delete_user( $gq_support_user );
	$gq_support_user       = 0;
	$gq_support_retry_args = array( $gq_support_subject, get_current_blog_id() );
	$gq_support_assert( false !== wp_next_scheduled( GQ_Support_Privacy::RETRY_HOOK, $gq_support_retry_args ), 'A failed disabled erasure schedules its retry.' );
	remove_filter( 'pre_http_request', $gq_support_stub );
	add_filter( 'pre_http_request', $gq_support_privacy_stub, 10, 3 );
	$gq_support_seen = array();
	do_action( GQ_Support_Privacy::RETRY_HOOK, ...$gq_support_retry_args );
	$gq_support_assert( 1 === count( $gq_support_seen ) && array( 'reporter_subject' => $gq_support_subject ) === json_decode( $gq_support_seen[0][1]['body'], true ), 'The retry sends the deleted Reporter subject while support is disabled.' );
	$gq_support_assert( 'completed' === GQ_Support_Privacy::erasures()['era_01J8Z6Q4M1ZC7X000000000000']['state'], 'The retry records the Worker result.' );
	remove_filter( 'pre_http_request', $gq_support_privacy_stub );
	add_filter( 'pre_http_request', $gq_support_stub, 10, 3 );
	$gq_support_seen = array();

	// Setup erasure refresh remains disabled.

	update_option( GQ_Support_Privacy::ERASURES_OPTION, array( 'era_01J8Z6Q4M1ZC7X000000000000' => array( 'state' => 'in_progress' ) ), false );
	$gq_support_assert( false === GQ_Support_Privacy::refresh_erasures(), 'An erasure refresh must not claim an answer.' );
	delete_option( GQ_Support_Privacy::ERASURES_OPTION );
	$gq_support_assert( array() === $gq_support_seen, 'Disabled setup and privacy operations must not contact the service.' );
} finally {
	remove_filter( 'pre_http_request', $gq_support_stub );
	if ( isset( $gq_support_privacy_stub ) ) {
		remove_filter( 'pre_http_request', $gq_support_privacy_stub );
	}
	if ( isset( $gq_support_retry_args ) ) {
		wp_clear_scheduled_hook( GQ_Support_Privacy::RETRY_HOOK, $gq_support_retry_args );
	}
	if ( false === $gq_support_original_erasures ) {
		delete_option( GQ_Support_Privacy::ERASURES_OPTION );
	} else {
		update_option( GQ_Support_Privacy::ERASURES_OPTION, $gq_support_original_erasures, false );
	}
	update_option( GQ_Support_State::OPTION, $gq_support_original_state, false );
	if ( false === $gq_support_original_key ) {
		GQ_Support_Signing_Key::delete();
	} else {
		update_option( GQ_Support_Signing_Key::OPTION, $gq_support_original_key, false );
	}
	wp_set_current_user( 0 );
	unset( $_COOKIE[ LOGGED_IN_COOKIE ] );
	if ( is_int( $gq_support_user ) && $gq_support_user > 0 ) {
		require_once ABSPATH . 'wp-admin/includes/user.php';
		wp_delete_user( $gq_support_user );
	}
}
WP_CLI::success( 'fail-safe' );
