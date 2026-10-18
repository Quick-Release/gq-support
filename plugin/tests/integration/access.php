<?php
/**
 * Real WordPress REST authorization tests; the HTTP service is the only stub.
 * Run with wp eval-file, on single-site and multisite.
 *
 * @package GQ_Support
 */

$gq_support_assert  = static function ( bool $condition, string $message ): void {
	if ( ! $condition ) {
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- CLI diagnostic only.
		throw new RuntimeException( $message );
	}
};
$gq_support_request = static function ( string $method = 'GET', string $path = '/requests', array $params = array(), ?array $body = null, ?string $nonce = null ) {
	$request = new WP_REST_Request( $method, '/gq-support/v1' . $path );
	$request->set_header( 'X-WP-Nonce', $nonce ?? wp_create_nonce( 'wp_rest' ) );
	$request->set_query_params( $params );
	if ( 'POST' === $method || null !== $body ) {
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body(
			wp_json_encode(
				$body ?? array(
					'submission_id' => '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11',
					'description'   => '<script>Plain report</script>',
				)
			)
		);
	}
	return rest_do_request( $request );
};
wp_set_current_user( 0 );
$gq_support_response = $gq_support_request();
$gq_support_assert( 401 === $gq_support_response->get_status(), 'Anonymous callers must be rejected by a registered route.' );
$gq_support_user = wp_insert_user(
	array(
		'user_login' => 'access-reporter-' . wp_generate_uuid4(),
		'user_pass'  => wp_generate_password(),
		'role'       => 'subscriber',
	)
);
$gq_support_assert( is_int( $gq_support_user ), 'Create Reporter.' );
$gq_support_login = static function ( int $id ): void {
	wp_set_current_user( $id );
	$token                       = WP_Session_Tokens::get_instance( $id )->create( time() + HOUR_IN_SECONDS );
	$_COOKIE[ LOGGED_IN_COOKIE ] = wp_generate_auth_cookie( $id, time() + HOUR_IN_SECONDS, 'logged_in', $token );
};
try {
	$gq_support_original_state = GQ_Support_State::get();
	$gq_support_original_key   = get_option( GQ_Support_Signing_Key::OPTION );
	GQ_Support_State::update( GQ_Support_State::disconnected( 'not_connected' ) );
	$gq_support_login( $gq_support_user );
	$gq_support_assert( 403 === $gq_support_request()->get_status(), 'Login alone is insufficient.' );
	wp_get_current_user()->add_cap( 'gq_support_submit_requests' );
	$gq_support_assert( 503 === $gq_support_request()->get_status(), 'Authorized unconfigured installation reports unavailable.' );
	$gq_support_assert( 503 === $gq_support_request( 'POST' )->get_status(), 'Create route has the same gate.' );
	$gq_support_assert( 503 === $gq_support_request( 'GET', '/requests/req_one' )->get_status(), 'Read route has the same gate.' );
	$gq_support_secret = GQ_Support_Signing_Key::pending_for( 'ACCESS-TEST' );
	GQ_Support_Signing_Key::promote();
	GQ_Support_State::update(
		array(
			'connection' => 'connected',
			'key_id'     => 'access-test-key',
		)
	);
	// Two independent WordPress processes overlap the first authorized REST read.
	$gq_support_processes = array();
	for ( $gq_support_i = 0; $gq_support_i < 2; ++$gq_support_i ) {
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.system_calls_proc_open -- Disposable CLI test requires independent WordPress processes.
		$gq_support_process     = proc_open(
			array( 'wp', '--path=' . ABSPATH, 'eval-file', __DIR__ . '/subject-worker.php', (string) $gq_support_user ),
			array(
				1 => array( 'pipe', 'w' ),
				2 => array( 'pipe', 'w' ),
			),
			$gq_support_pipes
		);
		$gq_support_processes[] = array( $gq_support_process, $gq_support_pipes );
	}
	$gq_support_subjects = array();
	foreach ( $gq_support_processes as list( $gq_support_process, $gq_support_pipes ) ) {
		$gq_support_subjects[] = trim( stream_get_contents( $gq_support_pipes[1] ) );
		$gq_support_stderr     = stream_get_contents( $gq_support_pipes[2] );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose -- Close a process pipe, not a filesystem file.
		fclose( $gq_support_pipes[1] );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose -- Close a process pipe, not a filesystem file.
		fclose( $gq_support_pipes[2] );
		$gq_support_assert( 0 === proc_close( $gq_support_process ), 'Concurrent WordPress REST probe failed: ' . $gq_support_stderr );
	}
	$gq_support_assert( 36 === strlen( $gq_support_subjects[0] ) && $gq_support_subjects[0] === $gq_support_subjects[1], 'Overlapping first-use REST requests must attest one stable subject.' );
	$gq_support_seen   = array();
	$gq_support_reply  = array(
		'items'       => array(),
		'next_cursor' => null,
	);
	$gq_support_status = 200;
	$gq_support_stub   = static function ( $preempt, array $args, string $url ) use ( &$gq_support_seen, &$gq_support_reply, &$gq_support_status ) {
		$gq_support_seen[] = array( $url, $args );
		return array(
			'response' => array( 'code' => $gq_support_status ),
			'headers'  => array(),
			'body'     => wp_json_encode( $gq_support_reply ),
		);
	};
	add_filter( 'pre_http_request', $gq_support_stub, 10, 3 );
	$gq_support_assert( 200 === $gq_support_request()->get_status(), 'Reporter can list own requests.' );
	$gq_support_assert( 1 === count( $gq_support_seen ), 'Authorized read reaches service.' );
	$gq_support_query = array();
	parse_str( wp_parse_url( $gq_support_seen[0][0], PHP_URL_QUERY ), $gq_support_query );
	$gq_support_assert( ! empty( $gq_support_query['reporter_subject'] ) && 'mine' === $gq_support_query['scope'], 'Service receives server-resolved subject and own scope.' );
	$gq_support_assert( ! str_contains( wp_json_encode( $gq_support_seen ), $_COOKIE[ LOGGED_IN_COOKIE ] ), 'Cookie is never forwarded.' );
	$gq_support_assert( 403 === $gq_support_request( 'GET', '/requests', array( 'scope' => 'site' ) )->get_status(), 'Submit does not grant site-wide visibility.' );
	wp_get_current_user()->remove_cap( 'gq_support_submit_requests' );
	$gq_support_assert( 403 === $gq_support_request()->get_status(), 'Revocation applies on next request.' );
	wp_get_current_user()->add_cap( 'gq_support_view_site_requests' );
	$gq_support_assert( 200 === $gq_support_request( 'GET', '/requests', array( 'scope' => 'site' ) )->get_status(), 'Site manager can list site requests.' );
	$gq_support_assert( 403 === $gq_support_request( 'POST' )->get_status(), 'Site manager remains read-only.' );
	wp_get_current_user()->add_cap( 'gq_support_submit_requests' );
	wp_get_current_user()->remove_cap( 'gq_support_view_site_requests' );
	$gq_support_subject  = $gq_support_query['reporter_subject'];
	$gq_support_resource = array(
		'id'               => 'req_one',
		'submission_id'    => '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11',
		'title'            => '<script>Plain report</script>',
		'summary'          => null,
		'description'      => '<script>Plain report</script>',
		'created_at'       => '2026-10-15T10:00:00Z',
		'delivery'         => 'delivered',
		'status'           => 'open',
		'installation_id'  => GQ_Support_State::get()['installation_id'],
		'reporter_subject' => $gq_support_subject,
		'provider_secret'  => 'MUST-NOT-LEAK',
	);
	$gq_support_reply    = $gq_support_resource;
	$gq_support_own      = $gq_support_request( 'GET', '/requests/req_one' );
	$gq_support_assert( 200 === $gq_support_own->get_status() && ! isset( $gq_support_own->get_data()['provider_secret'] ) && ! isset( $gq_support_own->get_data()['reporter_subject'] ), 'Own read returns only public fields.' );
	$gq_support_assert( true === $gq_support_own->get_data()['own'], 'WordPress marks the current Reporter\'s own request.' );
	$gq_support_login( $gq_support_user );
	$gq_support_reply = array(
		'items'       => array(),
		'next_cursor' => null,
	);
	$gq_support_request();
	$gq_support_last = end( $gq_support_seen );
	parse_str( wp_parse_url( $gq_support_last[0], PHP_URL_QUERY ), $gq_support_identity );
	$gq_support_assert( $gq_support_subject === $gq_support_identity['reporter_subject'], 'Reporter subject survives a new login session.' );
	$gq_support_reply                     = $gq_support_resource;
	$gq_support_reply['reporter_subject'] = 'another-reporter';
	$gq_support_assert( 404 === $gq_support_request( 'GET', '/requests/req_one' )->get_status(), 'Other Reporter is hidden.' );
	wp_get_current_user()->add_cap( 'gq_support_view_site_requests' );
	$gq_support_reply['own'] = true;
	$gq_support_other        = $gq_support_request( 'GET', '/requests/req_one' );
	$gq_support_assert( 200 === $gq_support_other->get_status(), 'Explicit site grant permits another Reporter read.' );
	$gq_support_assert( false === $gq_support_other->get_data()['own'], 'Only WordPress decides own, never the service.' );
	unset( $gq_support_reply['own'] );
	$gq_support_reply['installation_id'] = 'same-client-other-installation';
	$gq_support_assert( 404 === $gq_support_request( 'GET', '/requests/req_one' )->get_status(), 'Site manager cannot read another installation.' );
	$gq_support_reply = array(
		'items'       => array( $gq_support_reply ),
		'next_cursor' => null,
	);
	$gq_support_assert( 404 === $gq_support_request( 'GET', '/requests', array( 'scope' => 'site' ) )->get_status(), 'List checks every item ownership.' );
	$gq_support_reply  = $gq_support_resource;
	$gq_support_status = 201;
	$gq_support_assert( 201 === $gq_support_request( 'POST' )->get_status(), 'Reporter can submit plain text.' );
	$gq_support_last    = end( $gq_support_seen );
	$gq_support_payload = json_decode( $gq_support_last[1]['body'], true );
	$gq_support_assert( $gq_support_payload['reporter_subject'] === $gq_support_subject && 'mine' === $gq_support_payload['scope'], 'Create attests current Reporter without site write authority.' );
	$gq_support_reply   = array( 'unexpected' => 'ambiguous acknowledgment' );
	$gq_support_unknown = $gq_support_request( 'POST' );
	$gq_support_assert( 504 === $gq_support_unknown->get_status() && 'gq_support_outcome_unknown' === $gq_support_unknown->get_data()['code'], 'Malformed create acknowledgment is outcome unknown.' );
	$gq_support_assert( '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11' === $gq_support_unknown->get_data()['data']['submission_id'], 'Unknown create retains Submission ID.' );
	$gq_support_status       = 503;
	$gq_support_not_accepted = $gq_support_request( 'POST' );
	$gq_support_assert( true === $gq_support_not_accepted->get_data()['data']['retryable'], 'Definitely unaccepted create is retryable.' );
	$gq_support_before = count( $gq_support_seen );
	foreach ( array( 'repository', 'reporter_subject', 'installation_id', 'client', 'nonce' ) as $gq_support_field ) {
		$gq_support_assert( 400 === $gq_support_request( 'POST', '/requests', array(), array( $gq_support_field => 'forged' ) )->get_status(), 'Authority overrides are rejected.' );
		$gq_support_assert( 400 === $gq_support_request( 'GET', '/requests', array( $gq_support_field => 'forged' ) )->get_status(), 'Read authority overrides are rejected.' );
	}
	$gq_support_assert( 403 === $gq_support_request( 'GET', '/requests', array(), null, 'stale-nonce' )->get_status(), 'Stale nonce denied before forwarding.' );
	$gq_support_assert( count( $gq_support_seen ) === $gq_support_before, 'Invalid requests never reach service.' );
	foreach ( array( '/receipts/one', '/requests/req_one/replies', '/attachments/one' ) as $gq_support_path ) {
		$gq_support_assert( 404 === $gq_support_request( 'POST', $gq_support_path )->get_status(), 'Deferred routes do not exist.' );
	}
	wp_get_current_user()->set_role( 'subscriber' );
	wp_get_current_user()->remove_cap( 'gq_support_submit_requests' );
	wp_get_current_user()->remove_cap( 'gq_support_view_site_requests' );
	$gq_support_assert( 403 === $gq_support_request()->get_status(), 'Role change without support grants denies access.' );
	if ( is_multisite() ) {
		grant_super_admin( $gq_support_user );
		$gq_support_assert( 403 === $gq_support_request()->get_status(), 'Super Admin shortcut cannot replace a site grant.' );
		revoke_super_admin( $gq_support_user );
		wp_get_current_user()->add_cap( 'gq_support_submit_requests' );
		remove_user_from_blog( $gq_support_user, get_current_blog_id() );
		wp_set_current_user( 0 );
		$gq_support_login( $gq_support_user );
		$gq_support_assert( 403 === $gq_support_request()->get_status(), 'Removed site membership denies the next request.' );
		add_user_to_blog( get_current_blog_id(), $gq_support_user, 'subscriber' );
	}
	wp_get_current_user()->add_cap( 'gq_support_submit_requests' );
	$gq_support_login( $gq_support_user );
	$gq_support_reply = array(
		'items'       => array(),
		'next_cursor' => null,
	);
	if ( is_multisite() ) {
		$gq_support_site = wp_insert_site(
			array(
				'domain' => wp_parse_url( home_url(), PHP_URL_HOST ),
				'path'   => '/support-access-' . wp_generate_uuid4() . '/',
			)
		);
		$gq_support_assert( is_int( $gq_support_site ), 'Create isolated site.' );
		switch_to_blog( $gq_support_site );
		GQ_Support_Lifecycle::ensure_site();
		add_user_to_blog( $gq_support_site, $gq_support_user, 'administrator' );
		$gq_support_login( $gq_support_user );
		$gq_support_assert( GQ_Support_Access::subject() !== $gq_support_subject, 'Same network account has an independent subject on each site.' );
		get_role( 'administrator' )->remove_cap( 'gq_support_submit_requests' );
		GQ_Support_Lifecycle::ensure_site();
		$gq_support_assert( ! get_role( 'administrator' )->has_cap( 'gq_support_submit_requests' ), 'Per-site upgrade preserves revoked grants.' );
		restore_current_blog();
		wp_delete_site( $gq_support_site );
	}
	$gq_support_login( $gq_support_user );
	$gq_support_old_subject = GQ_Support_Access::subject();
	require_once ABSPATH . 'wp-admin/includes/user.php';
	$gq_support_old_login = wp_get_current_user()->user_login;
	if ( is_multisite() ) {
		wpmu_delete_user( $gq_support_user );
	} else {
		wp_delete_user( $gq_support_user );
	}
	$gq_support_assert( 403 === $gq_support_request()->get_status(), 'Deleted account cookie cannot authorize another request.' );
	$gq_support_user = wp_insert_user(
		array(
			'user_login' => $gq_support_old_login,
			'user_pass'  => wp_generate_password(),
			'role'       => 'subscriber',
		)
	);
	$gq_support_login( $gq_support_user );
	wp_get_current_user()->add_cap( 'gq_support_submit_requests' );
	$gq_support_assert( GQ_Support_Access::subject() !== $gq_support_old_subject, 'Replacement account cannot inherit Reporter ownership.' );
	remove_filter( 'pre_http_request', $gq_support_stub );
} finally {
	update_option( GQ_Support_State::OPTION, $gq_support_original_state, false );
	if ( false === $gq_support_original_key ) {
		GQ_Support_Signing_Key::delete();
	} else {
		update_option( GQ_Support_Signing_Key::OPTION, $gq_support_original_key, false );
	}
	wp_set_current_user( 0 );
	unset( $_COOKIE[ LOGGED_IN_COOKIE ] );
	require_once ABSPATH . 'wp-admin/includes/user.php';
	if ( is_multisite() ) {
		wpmu_delete_user( $gq_support_user );
	} else {
		wp_delete_user( $gq_support_user );
	}
}
WP_CLI::success( 'Support REST authorization' );
