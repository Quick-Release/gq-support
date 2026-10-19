<?php
/**
 * WordPress privacy tools against a stubbed service (docs/support-privacy-design.md,
 * required tests 2, 5 and 7). Run with wp eval-file on a single site.
 *
 * @package GQ_Support
 */

$gq_support_assert = static function ( bool $condition, string $message ): void {
	if ( ! $condition ) {
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- CLI diagnostic only.
		throw new RuntimeException( $message );
	}
};
require_once ABSPATH . 'wp-admin/includes/user.php';
$gq_support_email             = 'privacy-reporter-' . wp_generate_uuid4() . '@example.test';
$gq_support_user              = wp_insert_user(
	array(
		'user_login' => 'privacy-reporter-' . wp_generate_uuid4(),
		'user_pass'  => wp_generate_password(),
		'user_email' => $gq_support_email,
		'role'       => 'subscriber',
	)
);
$gq_support_never             = wp_insert_user(
	array(
		'user_login' => 'privacy-silent-' . wp_generate_uuid4(),
		'user_pass'  => wp_generate_password(),
		'user_email' => 'privacy-silent-' . wp_generate_uuid4() . '@example.test',
		'role'       => 'subscriber',
	)
);
$gq_support_subject           = wp_generate_uuid4();
$gq_support_seen              = array();
$gq_support_replies           = array();
$gq_support_stub              = static function ( $preempt, array $args, string $url ) use ( &$gq_support_seen, &$gq_support_replies ) {
	$gq_support_seen[] = array( $url, $args );
	$reply             = array_shift( $gq_support_replies );
	if ( null === $reply ) {
		return new WP_Error( 'http_request_failed', 'Service unreachable' );
	}
	return array(
		'response' => array( 'code' => $reply[0] ),
		'headers'  => array(),
		'body'     => wp_json_encode( $reply[1] ),
	);
};
$gq_support_original_state    = GQ_Support_State::get();
$gq_support_original_key      = get_option( GQ_Support_Signing_Key::OPTION );
$gq_support_original_erasures = get_option( 'gq_support_erasures' );
try {
	$gq_support_assert( is_int( $gq_support_user ) && is_int( $gq_support_never ), 'Create users.' );
	GQ_Support_Signing_Key::pending_for( 'PRIVACY-TEST' );
	GQ_Support_Signing_Key::promote();
	GQ_Support_State::update(
		array(
			'connection' => 'connected',
			'key_id'     => 'privacy-test-key',
		)
	);
	global $wpdb;
	add_user_meta( $gq_support_user, $wpdb->get_blog_prefix() . 'gq_support_reporter_' . GQ_Support_State::get()['installation_id'], $gq_support_subject, true );
	add_filter( 'pre_http_request', $gq_support_stub, 10, 3 );

	$gq_support_exporters = apply_filters( 'wp_privacy_personal_data_exporters', array() ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Core filter.
	$gq_support_erasers   = apply_filters( 'wp_privacy_personal_data_erasers', array() ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Core filter.
	$gq_support_assert( isset( $gq_support_exporters['gq-support'], $gq_support_erasers['gq-support'] ), 'The exporter and eraser are registered.' );
	$gq_support_export = $gq_support_exporters['gq-support']['callback'];
	$gq_support_erase  = $gq_support_erasers['gq-support']['callback'];

	// A user who never submitted: "no data", without a service call.
	$gq_support_silent = get_userdata( $gq_support_never )->user_email;
	$gq_support_assert(
		array(
			'data' => array(),
			'done' => true,
		) === $gq_support_export( $gq_support_silent, 1 ),
		'No subject exports nothing.'
	);
	$gq_support_assert( false === $gq_support_erase( $gq_support_silent, 1 )['items_retained'], 'No subject retains nothing.' );
	$gq_support_assert( array() === $gq_support_seen, 'A user without a subject causes no service call.' );

	// Export pages follow the service cursor; the email never leaves WordPress.
	$gq_support_item    = array(
		'id'          => 'req_01M54MVN80H1GQ296DCQ8S14F0',
		'summary'     => 'Checkout fails',
		'description' => 'Private report text',
		'created_at'  => '2026-10-17T10:00:00.000Z',
		'delivery'    => 'delivered',
		'status'      => 'open',
	);
	$gq_support_replies = array(
		array(
			200,
			array(
				'items'       => array( $gq_support_item ),
				'next_cursor' => 'cursor-two',
			),
		),
		array(
			200,
			array(
				'items'       => array( array( 'id' => 'req_01M54MVN80H1GQ296DCQ8S14F1' ) + $gq_support_item ),
				'next_cursor' => null,
			),
		),
	);
	$gq_support_first   = $gq_support_export( $gq_support_email, 1 );
	$gq_support_second  = $gq_support_export( $gq_support_email, 2 );
	$gq_support_assert( false === $gq_support_first['done'] && true === $gq_support_second['done'], 'Export pages follow the service cursor.' );
	$gq_support_assert( 'gq-support-req_01M54MVN80H1GQ296DCQ8S14F0' === $gq_support_first['data'][0]['item_id'], 'Each request is one export item.' );
	$gq_support_assert( str_contains( wp_json_encode( $gq_support_first['data'] ), 'Private report text' ), 'The export carries the Submitted text.' );
	$gq_support_assert( str_contains( $gq_support_seen[1][0], 'cursor=cursor-two' ), 'The second page asks for the next cursor.' );
	$gq_support_assert( str_contains( $gq_support_seen[0][0], '/v1/export?reporter_subject=' . $gq_support_subject ), 'The service receives the subject.' );
	$gq_support_assert( ! str_contains( wp_json_encode( $gq_support_seen ), $gq_support_email ), 'The email address never leaves WordPress.' );
	$gq_support_assert( ! empty( $gq_support_seen[0][1]['headers']['GQ-Support-Signature'] ), 'Export calls are signed.' );

	// The eraser never claims completion while the service still works or needs review.
	$gq_support_seen    = array();
	$gq_support_replies = array(
		array(
			202,
			array(
				'id'       => 'era_01M54MVN80H1GQ296DCQ8S14F0',
				'state'    => 'in_progress',
				'counts'   => array(
					'purged'   => 0,
					'redacted' => 0,
					'pending'  => 1,
				),
				'residual' => array(),
			),
		),
	);
	$gq_support_result  = $gq_support_erase( $gq_support_email, 1 );
	$gq_support_assert( true === $gq_support_result['items_retained'] && true === $gq_support_result['done'] && array() !== $gq_support_result['messages'], 'An erasure in progress is reported as retained.' );
	$gq_support_assert( array( 'reporter_subject' => $gq_support_subject ) === json_decode( $gq_support_seen[0][1]['body'], true ), 'The eraser sends only the subject.' );
	$gq_support_assert( array( 'era_01M54MVN80H1GQ296DCQ8S14F0' ) === array_keys( GQ_Support_Privacy::erasures() ), 'The site remembers the erasure.' );
	$gq_support_assert( 'in_progress' === GQ_Support_Privacy::erasures()['era_01M54MVN80H1GQ296DCQ8S14F0']['state'], 'The site remembers its state.' );
	$gq_support_replies = array(
		array(
			202,
			array(
				'id'       => 'era_01M54MVN80H1GQ296DCQ8S14F0',
				'state'    => 'completed',
				'counts'   => array(
					'purged'   => 1,
					'redacted' => 0,
					'pending'  => 0,
				),
				'residual' => array(),
			),
		),
	);
	$gq_support_result  = $gq_support_erase( $gq_support_email, 1 );
	$gq_support_assert( false === $gq_support_result['items_retained'] && true === $gq_support_result['items_removed'], 'Only a completed erasure retains nothing.' );

	// The setup page lists the erasure; only a refresh asks the service, and a closed erasure leaves the list.
	$gq_support_seen    = array();
	$gq_support_replies = array(
		array(
			200,
			array(
				'id'    => 'era_01M54MVN80H1GQ296DCQ8S14F0',
				'state' => 'needs_review',
			),
		),
	);
	$gq_support_assert( GQ_Support_Privacy::refresh_erasures(), 'A refresh reaches the service.' );
	$gq_support_assert( str_ends_with( $gq_support_seen[0][0], '/v1/erasures/era_01M54MVN80H1GQ296DCQ8S14F0' ), 'A refresh reads each listed erasure.' );
	require_once GQ_SUPPORT_PLUGIN_DIR . 'includes/class-gq-support-setup-page.php';
	wp_set_current_user( $gq_support_user );
	wp_get_current_user()->add_cap( 'gq_support_manage_settings' );
	ob_start();
	GQ_Support_Setup_Page::render();
	$gq_support_page = (string) ob_get_clean();
	wp_set_current_user( 0 );
	$gq_support_assert( str_contains( $gq_support_page, 'era_01M54MVN80H1GQ296DCQ8S14F0' ) && str_contains( $gq_support_page, 'remaining copies under review' ), 'The setup page lists the erasure and its state.' );
	$gq_support_assert( 1 === count( $gq_support_seen ), 'Rendering the page calls nothing.' );
	$gq_support_assert( false === GQ_Support_Privacy::refresh_erasures(), 'An unreachable service is reported.' );
	$gq_support_assert( array() !== GQ_Support_Privacy::erasures(), 'An unanswered refresh keeps the erasure listed.' );
	$gq_support_replies = array(
		array(
			200,
			array(
				'id'    => 'era_01M54MVN80H1GQ296DCQ8S14F0',
				'state' => 'closed',
			),
		),
	);
	GQ_Support_Privacy::refresh_erasures();
	$gq_support_assert( array() === GQ_Support_Privacy::erasures(), 'A closed erasure leaves the list.' );
	$gq_support_assert( is_wp_error( $gq_support_erase( $gq_support_email, 1 ) ), 'An unreachable service is an error, never a completed erasure.' );

	// Deleting the user erases with the subject read before deletion; a failure retries once.
	$gq_support_seen = array();
	wp_delete_user( $gq_support_user );
	$gq_support_user = 0;
	$gq_support_assert( 1 === count( $gq_support_seen ) && str_ends_with( $gq_support_seen[0][0], '/v1/erasures' ), 'Deleting a user sends its erasure.' );
	$gq_support_assert( array( 'reporter_subject' => $gq_support_subject ) === json_decode( $gq_support_seen[0][1]['body'], true ), 'The subject was read before deletion.' );
	$gq_support_assert( false !== wp_next_scheduled( 'gq_support_retry_erasure', array( $gq_support_subject, get_current_blog_id() ) ), 'A failed erasure is retried once.' );
} finally {
	remove_filter( 'pre_http_request', $gq_support_stub );
	wp_unschedule_hook( 'gq_support_retry_erasure' );
	update_option( GQ_Support_State::OPTION, $gq_support_original_state, false );
	if ( false === $gq_support_original_key ) {
		GQ_Support_Signing_Key::delete();
	} else {
		update_option( GQ_Support_Signing_Key::OPTION, $gq_support_original_key, false );
	}
	if ( false === $gq_support_original_erasures ) {
		delete_option( 'gq_support_erasures' );
	} else {
		update_option( 'gq_support_erasures', $gq_support_original_erasures, false );
	}
	foreach ( array( $gq_support_user, $gq_support_never ) as $gq_support_id ) {
		if ( is_int( $gq_support_id ) && $gq_support_id > 0 ) {
			wp_delete_user( $gq_support_id );
		}
	}
}
