<?php
/**
 * Concurrent first-use REST probe, launched by access.php on the disposable site.
 *
 * @package GQ_Support
 */

$gq_support_user_id = (int) $args[0];
wp_set_current_user( $gq_support_user_id );
// The parent creates the session: two processes creating one each lose a token to
// WordPress's read-modify-write of the user's session metadata.
$gq_support_token            = $args[1];
$_COOKIE[ LOGGED_IN_COOKIE ] = wp_generate_auth_cookie( $gq_support_user_id, time() + HOUR_IN_SECONDS, 'logged_in', $gq_support_token );
// Make overlapping first-use initialization deterministic, without mocking identity storage.
add_filter(
	'add_user_metadata',
	static function ( $check, $id, $key ) {
		if ( str_contains( $key, 'gq_support_reporter_' ) ) {
			usleep( 250000 );
		}
		return $check;
	},
	10,
	3
);
add_filter(
	'pre_http_request',
	static function ( $preempt, $options, $url ) {
		parse_str( wp_parse_url( $url, PHP_URL_QUERY ), $identity );
		return array(
			'response' => array( 'code' => 200 ),
			'headers'  => array(),
			'body'     => wp_json_encode(
				array(
					'items'       => array(
						array(
							'id'               => 'req_race',
							'submission_id'    => '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11',
							'title'            => $identity['reporter_subject'],
							'summary'          => null,
							'description'      => 'First use',
							'created_at'       => '2026-10-15T10:00:00Z',
							'delivery'         => 'delivered',
							'status'           => 'open',
							'installation_id'  => GQ_Support_State::get()['installation_id'],
							'reporter_subject' => $identity['reporter_subject'],
						),
					),
					'next_cursor' => null,
				)
			),
		);
	},
	10,
	3
);
$gq_support_request = new WP_REST_Request( 'GET', '/gq-support/v1/requests' );
$gq_support_request->set_header( 'X-WP-Nonce', wp_create_nonce( 'wp_rest' ) );
$gq_support_response = rest_do_request( $gq_support_request );
if ( 200 !== $gq_support_response->get_status() ) {
	WP_CLI::error( 'Concurrent first use failed.' );
}
echo $gq_support_response->get_data()['items'][0]['title']; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- CLI-only opaque subject.
