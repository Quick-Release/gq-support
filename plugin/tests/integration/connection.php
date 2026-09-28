<?php
/**
 * Connection scenarios from docs/support-onboarding-design.md ("Tests to plan").
 * Run with `wp eval-file` on a real WordPress installation. The support
 * service is mocked through `pre_http_request` until the Worker side (#41) lands.
 *
 * @package GQ_Support
 */

$gq_support_scenario = $args[0] ?? '';
$gq_support_fail     = static function ( string $message ): void {
	// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- CLI-only diagnostic.
	throw new RuntimeException( $message );
};

/**
 * Records every outgoing HTTP request and answers it with the current responder.
 */
final class GQ_Support_Test_Service {

	/**
	 * Requests seen so far.
	 *
	 * @var array<int, array{url: string, method: string, headers: array<string, string>, body: array<string, mixed>|null}>
	 */
	public array $calls = array();

	/**
	 * Answers the next request.
	 *
	 * @var callable
	 */
	public $responder;

	/** Starts intercepting. */
	public function __construct() {
		$this->responder = static fn() => new WP_Error( 'http_request_failed', 'Unreachable.' );
		add_filter( 'pre_http_request', array( $this, 'intercept' ), 10, 3 );
	}

	/**
	 * Records and answers one request.
	 *
	 * @param false|array<string, mixed>|WP_Error $pre  Short-circuit value.
	 * @param array<string, mixed>                $args Request arguments.
	 * @param string                              $url  Request URL.
	 * @return array<string, mixed>|WP_Error
	 */
	public function intercept( $pre, array $args, string $url ) {
		$call          = array(
			'url'     => $url,
			'method'  => (string) $args['method'],
			'headers' => (array) $args['headers'],
			'body'    => isset( $args['body'] ) && '' !== $args['body'] ? json_decode( (string) $args['body'], true ) : null,
		);
		$this->calls[] = $call;
		return ( $this->responder )( $call );
	}

	/**
	 * A JSON response.
	 *
	 * @param int                  $status HTTP status.
	 * @param array<string, mixed> $body   Response body.
	 * @return array<string, mixed>
	 */
	public static function json( int $status, array $body ): array {
		return array(
			'headers'  => array( 'content-type' => 'application/json' ),
			'body'     => (string) wp_json_encode( $body ),
			'response' => array(
				'code'    => $status,
				'message' => '',
			),
			'cookies'  => array(),
			'filename' => null,
		);
	}

	/**
	 * A successful enrollment response.
	 *
	 * @return array<string, mixed>
	 */
	public static function enrolled(): array {
		return self::json(
			200,
			array(
				'key_id'       => 'key_test',
				'environment'  => 'production',
				'connected_at' => '2026-09-28T12:00:00Z',
			)
		);
	}
}

/**
 * Connects the current site against the mocked service.
 */
$gq_support_connect = static function () use ( $gq_support_fail ): GQ_Support_Test_Service {
	$service            = new GQ_Support_Test_Service();
	$service->responder = static fn() => GQ_Support_Test_Service::enrolled();
	$result             = GQ_Support_Connection::enroll( 'ABCD-EFGH-IJKL' );
	if ( is_wp_error( $result ) ) {
		$gq_support_fail( 'Enrollment failed: ' . $result->get_error_code() );
	}
	return $service;
};

switch ( $gq_support_scenario ) {
	case 'state':
		// Migration 4 folds the legacy options into one non-autoloaded state option.
		$gq_support_state = get_option( 'gq_support_state' );
		if ( ! is_array( $gq_support_state ) || GQ_Support_State::SCHEMA_VERSION !== $gq_support_state['schema_version'] || empty( $gq_support_state['installation_id'] ) ) {
			$gq_support_fail( 'Missing gq_support_state.' );
		}
		foreach ( array( 'gq_support_installation_id', 'gq_support_installation_origin', 'gq_support_schema_version', 'gq_support_administrator_grants', 'gq_support_connection' ) as $gq_support_legacy ) {
			if ( false !== get_option( $gq_support_legacy ) ) {
				$gq_support_fail( "Legacy option {$gq_support_legacy} was not migrated." );
			}
		}
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery -- Asserting the stored autoload flag.
		$gq_support_autoload = $wpdb->get_var( $wpdb->prepare( "SELECT autoload FROM {$wpdb->options} WHERE option_name = %s", 'gq_support_state' ) );
		if ( ! in_array( $gq_support_autoload, array( 'no', 'off' ), true ) ) {
			$gq_support_fail( 'gq_support_state is autoloaded.' );
		}
		break;

	case 'legacy-upgrade':
		// A schema-3 site keeps its identity, origin and grant record through migration 4.
		$gq_support_state = GQ_Support_State::get();
		delete_option( 'gq_support_state' );
		add_option( 'gq_support_installation_id', 'legacy-id', '', false );
		add_option( 'gq_support_installation_origin', $gq_support_state['origin'], '', false );
		add_option( 'gq_support_schema_version', 3, '', false );
		add_option( 'gq_support_administrator_grants', array( 'gq_support_submit_requests' ), '', false );
		wp_cache_flush();
		GQ_Support_Lifecycle::ensure_site();
		$gq_support_upgraded = GQ_Support_State::get();
		if ( 'legacy-id' !== $gq_support_upgraded['installation_id'] || array( 'gq_support_submit_requests' ) !== $gq_support_upgraded['administrator_grants'] ) {
			$gq_support_fail( 'Migration 4 lost the legacy identity or grants.' );
		}
		if ( false !== get_option( 'gq_support_installation_id' ) ) {
			$gq_support_fail( 'Migration 4 left legacy options behind.' );
		}
		// Restore the pre-test state.
		update_option( 'gq_support_state', $gq_support_state, false );
		break;

	case 'no-remote-calls':
		// Test 10: activation and ordinary requests make no remote calls and read one option.
		$gq_support_service = new GQ_Support_Test_Service();
		global $wpdb;
		$gq_support_queries = 0;
		add_filter(
			'query',
			static function ( string $query ) use ( &$gq_support_queries ): string {
				if ( str_contains( $query, 'gq_support' ) ) {
					++$gq_support_queries;
				}
				return $query;
			}
		);
		wp_cache_flush();
		GQ_Support_Lifecycle::activate( false );
		GQ_Support_Lifecycle::ensure_site();
		GQ_Support_State::get();
		GQ_Support_Connection::status();
		if ( 1 !== $gq_support_queries ) {
			$gq_support_fail( "Expected one option query, saw {$gq_support_queries}." );
		}
		if ( $gq_support_service->calls ) {
			$gq_support_fail( 'Activation or bootstrap made a remote call.' );
		}
		break;

	case 'enroll':
		$gq_support_service = $gq_support_connect();
		$gq_support_call    = $gq_support_service->calls[0];
		$gq_support_state   = GQ_Support_State::get();
		if ( 'POST' !== $gq_support_call['method'] || ! str_ends_with( $gq_support_call['url'], '/v1/enroll' ) ) {
			$gq_support_fail( 'Enrollment did not POST /v1/enroll.' );
		}
		foreach ( array( 'code', 'installation_id', 'origin', 'public_key', 'wp_environment_type', 'plugin_version' ) as $gq_support_field ) {
			if ( ! isset( $gq_support_call['body'][ $gq_support_field ] ) ) {
				$gq_support_fail( "Enrollment body lacks {$gq_support_field}." );
			}
		}
		if ( 'ABCDEFGHIJKL' !== $gq_support_call['body']['code'] || $gq_support_state['installation_id'] !== $gq_support_call['body']['installation_id'] ) {
			$gq_support_fail( 'Enrollment sent the wrong code or installation ID.' );
		}
		if ( ( $gq_support_call['headers']['GQ-Support-Installation-Id'] ?? '' ) !== $gq_support_state['installation_id'] ) {
			$gq_support_fail( 'Enrollment did not sign the installation ID.' );
		}
		foreach ( array( 'GQ-Support-Timestamp', 'GQ-Support-Request-Id', 'Content-Digest', 'GQ-Support-Signature', 'GQ-Support-Plugin-Version' ) as $gq_support_header ) {
			if ( empty( $gq_support_call['headers'][ $gq_support_header ] ) ) {
				$gq_support_fail( "Enrollment lacks the {$gq_support_header} header." );
			}
		}
		if ( 'connected' !== $gq_support_state['connection'] || 'key_test' !== $gq_support_state['key_id'] || 'production' !== $gq_support_state['environment'] ) {
			$gq_support_fail( 'Enrollment did not record the connection.' );
		}
		$gq_support_status = GQ_Support_Connection::status();
		if ( 'connected' !== $gq_support_status['connection'] || empty( $gq_support_status['fingerprint'] ) ) {
			$gq_support_fail( 'Status does not show the connection.' );
		}
		break;

	case 'interrupted-setup':
		// Test 7: a pending key survives a failed exchange; a retry with the same code reuses it;
		// a different code replaces an abandoned pending key.
		GQ_Support_Connection::disconnect();
		$gq_support_service = new GQ_Support_Test_Service();
		$gq_support_first   = GQ_Support_Connection::enroll( 'code-one' );
		if ( ! is_wp_error( $gq_support_first ) ) {
			$gq_support_fail( 'A failed exchange reported success.' );
		}
		if ( 'not_connected' !== GQ_Support_State::get()['connection'] ) {
			$gq_support_fail( 'A failed exchange changed the connection state.' );
		}
		$gq_support_service->responder = static fn() => GQ_Support_Test_Service::enrolled();
		if ( is_wp_error( GQ_Support_Connection::enroll( 'CODE-ONE' ) ) ) {
			$gq_support_fail( 'The retry did not complete.' );
		}
		[ $gq_support_failed, $gq_support_retried ] = $gq_support_service->calls;
		if ( $gq_support_failed['body']['public_key'] !== $gq_support_retried['body']['public_key'] ) {
			$gq_support_fail( 'The retry did not reuse the pending key.' );
		}
		if ( 'connected' !== GQ_Support_State::get()['connection'] ) {
			$gq_support_fail( 'The retry did not connect.' );
		}
		GQ_Support_Connection::disconnect();
		$gq_support_service->calls     = array();
		$gq_support_service->responder = static fn() => GQ_Support_Test_Service::json( 400, array( 'code' => 'gq_support_code_not_valid' ) );
		GQ_Support_Connection::enroll( 'abandoned' );
		$gq_support_service->responder = static fn() => GQ_Support_Test_Service::enrolled();
		GQ_Support_Connection::enroll( 'fresh-code' );
		$gq_support_bodies             = array_column( $gq_support_service->calls, 'body' );
		if ( $gq_support_bodies[0]['public_key'] === $gq_support_bodies[1]['public_key'] ) {
			$gq_support_fail( 'An abandoned pending key was reused for a different code.' );
		}
		break;

	case 'test-connection':
		$gq_support_service            = $gq_support_connect();
		$gq_support_service->calls     = array();
		$gq_support_service->responder = static fn() => GQ_Support_Test_Service::json(
			200,
			array(
				'environment'   => 'production',
				'key_id'        => 'key_test',
				'connected_at'  => '2026-09-28T12:00:00Z',
				'mapping_state' => 'suspended',
			)
		);
		GQ_Support_Connection::test();
		$gq_support_state              = GQ_Support_State::get();
		if ( 'GET' !== $gq_support_service->calls[0]['method'] || ! str_ends_with( $gq_support_service->calls[0]['url'], '/v1/installation' ) ) {
			$gq_support_fail( 'Test did not GET /v1/installation.' );
		}
		if ( 'key_test' !== $gq_support_service->calls[0]['headers']['GQ-Support-Key-Id'] ) {
			$gq_support_fail( 'Test was not signed with the active key.' );
		}
		if ( 'suspended' !== $gq_support_state['last_test']['result'] || empty( $gq_support_state['last_test']['at'] ) ) {
			$gq_support_fail( 'Test did not record a suspended mapping.' );
		}
		// Test 6 (WordPress side): a revoked key shows "Rejected by service".
		$gq_support_service->responder = static fn() => GQ_Support_Test_Service::json( 401, array( 'code' => 'gq_support_unauthenticated' ) );
		GQ_Support_Connection::test();
		if ( 'rejected' !== GQ_Support_State::get()['connection'] ) {
			$gq_support_fail( 'A rejected key did not mark the connection rejected.' );
		}
		break;

	case 'disconnect':
		$gq_support_service            = $gq_support_connect();
		$gq_support_service->calls     = array();
		$gq_support_service->responder = static fn() => new WP_Error( 'http_request_failed', 'Unreachable.' );
		GQ_Support_Connection::disconnect();
		if ( 'DELETE' !== ( $gq_support_service->calls[0]['method'] ?? '' ) ) {
			$gq_support_fail( 'Disconnect did not try a signed self-revoke.' );
		}
		if ( false !== get_option( 'gq_support_signing_key' ) || 'not_connected' !== GQ_Support_State::get()['connection'] ) {
			$gq_support_fail( 'Disconnect kept the key after a failed revoke.' );
		}
		break;

	case 'clone':
		// Test 4: a copy at a new URL deletes the key locally, without a service call.
		$gq_support_service        = $gq_support_connect();
		$gq_support_service->calls = array();
		$gq_support_before         = GQ_Support_State::get();
		$gq_support_home           = get_option( 'home' );
		// WP-CLI overrides home URLs; remove its filters to simulate a real cloned site.
		remove_all_filters( 'option_home' );
		remove_all_filters( 'home_url' );
		try {
			update_option( 'home', 'https://clone.example.test', false );
			GQ_Support_Lifecycle::ensure_site();
			$gq_support_after = GQ_Support_State::get();
			if ( $gq_support_after['installation_id'] === $gq_support_before['installation_id'] ) {
				$gq_support_fail( 'A cloned installation retained the original identity.' );
			}
			if ( false !== get_option( 'gq_support_signing_key' ) || 'copied_or_moved' !== $gq_support_after['connection'] || null !== $gq_support_after['key_id'] ) {
				$gq_support_fail( 'A cloned installation kept its key or connection.' );
			}
			if ( $gq_support_service->calls ) {
				$gq_support_fail( 'A cloned installation contacted the service.' );
			}
		} finally {
			update_option( 'home', $gq_support_home, false );
			GQ_Support_Lifecycle::ensure_site();
		}
		break;

	case 'no-key-exposure':
		// Test 9: the key never appears in REST, Site Health or the browser bootstrap.
		$gq_support_connect();
		$gq_support_stored = get_option( 'gq_support_signing_key' );
		$gq_support_secret = $gq_support_stored['active']['secret'] ?? '';
		if ( '' === $gq_support_secret ) {
			$gq_support_fail( 'No active key was stored.' );
		}
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery -- Asserting the stored autoload flag.
		$gq_support_autoload = $wpdb->get_var( $wpdb->prepare( "SELECT autoload FROM {$wpdb->options} WHERE option_name = %s", 'gq_support_signing_key' ) );
		if ( ! in_array( $gq_support_autoload, array( 'no', 'off' ), true ) ) {
			$gq_support_fail( 'gq_support_signing_key is autoloaded.' );
		}
		wp_set_current_user( 1 );
		$gq_support_exposed = array(
			'settings'  => rest_do_request( new WP_REST_Request( 'GET', '/wp/v2/settings' ) )->get_data(),
			'index'     => rest_do_request( new WP_REST_Request( 'GET', '/' ) )->get_data(),
			'status'    => GQ_Support_Connection::status(),
			'bootstrap' => wp_scripts()->get_data( 'gq-support-launcher', 'before' ),
		);
		require_once ABSPATH . 'wp-admin/includes/class-wp-debug-data.php';
		require_once ABSPATH . 'wp-admin/includes/update.php';
		require_once ABSPATH . 'wp-admin/includes/misc.php';
		$gq_support_exposed['site_health'] = WP_Debug_Data::debug_data();
		$gq_support_haystack               = (string) wp_json_encode( $gq_support_exposed );
		if ( str_contains( $gq_support_haystack, $gq_support_secret ) || str_contains( $gq_support_haystack, 'gq_support_signing_key' ) ) {
			$gq_support_fail( 'The signing key is exposed.' );
		}
		break;

	case 'constants':
		// Test 9: constants override the stored key; Disconnect is unavailable.
		$gq_support_keypair = sodium_crypto_sign_keypair();
		// phpcs:disable WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- Plugin constants.
		define( 'GQ_SUPPORT_SIGNING_KEY', base64_encode( sodium_crypto_sign_secretkey( $gq_support_keypair ) ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		define( 'GQ_SUPPORT_KEY_ID', 'key_from_config' );
		// phpcs:enable
		$gq_support_service            = $gq_support_connect();
		$gq_support_service->calls     = array();
		$gq_support_service->responder = static fn() => GQ_Support_Test_Service::json( 200, array( 'mapping_state' => 'active' ) );
		$gq_support_enrolled_key       = base64_encode( sodium_crypto_sign_publickey( $gq_support_keypair ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		GQ_Support_Connection::test();
		$gq_support_headers = $gq_support_service->calls[0]['headers'];
		if ( 'key_from_config' !== $gq_support_headers['GQ-Support-Key-Id'] ) {
			$gq_support_fail( 'GQ_SUPPORT_KEY_ID did not override the key ID.' );
		}
		$gq_support_signature = base64_decode( $gq_support_headers['GQ-Support-Signature'] ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		$gq_support_canonical = GQ_Support_Signer::canonical( 'GET', '/v1/installation', '', $gq_support_headers );
		if ( ! sodium_crypto_sign_verify_detached( $gq_support_signature, $gq_support_canonical, base64_decode( $gq_support_enrolled_key ) ) ) { // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
			$gq_support_fail( 'GQ_SUPPORT_SIGNING_KEY did not sign the request.' );
		}
		if ( false !== get_option( 'gq_support_signing_key' ) ) {
			$gq_support_fail( 'A managed key was written to the database.' );
		}
		if ( ! GQ_Support_Connection::status()['managed'] || ! is_wp_error( GQ_Support_Connection::disconnect() ) ) {
			$gq_support_fail( 'A managed key can be disconnected from WordPress.' );
		}
		break;

	case 'uninstall':
		// Test 11: uninstall removes plugin options and recorded grants, with no remote call.
		$gq_support_connect();
		$gq_support_service = new GQ_Support_Test_Service();
		update_option( 'gq_support_external_record', 'unchanged', false );
		get_role( 'administrator' )->add_cap( 'gq_support_submit_requests' );
		get_role( 'administrator' )->add_cap( 'gq_support_manage_settings' );
		GQ_Support_State::update( array( 'administrator_grants' => array( 'gq_support_submit_requests' ) ) );
		if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
			// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- WordPress uninstall guard.
			define( 'WP_UNINSTALL_PLUGIN', 'gq-support/gq-support.php' );
		}
		require dirname( __DIR__, 2 ) . '/uninstall.php';
		if ( false !== get_option( 'gq_support_state' ) || false !== get_option( 'gq_support_signing_key' ) ) {
			$gq_support_fail( 'Uninstall kept plugin options.' );
		}
		$gq_support_administrator = get_role( 'administrator' );
		if ( $gq_support_administrator->has_cap( 'gq_support_submit_requests' ) || ! $gq_support_administrator->has_cap( 'gq_support_manage_settings' ) ) {
			$gq_support_fail( 'Uninstall did not remove exactly the recorded Administrator grants.' );
		}
		$gq_support_administrator->remove_cap( 'gq_support_manage_settings' );
		if ( 'unchanged' !== get_option( 'gq_support_external_record' ) ) {
			$gq_support_fail( 'Uninstall removed unrelated data.' );
		}
		delete_option( 'gq_support_external_record' );
		if ( $gq_support_service->calls ) {
			$gq_support_fail( 'Uninstall contacted the service.' );
		}
		break;

	default:
		$gq_support_fail( 'Unknown connection scenario.' );
}

WP_CLI::success( $gq_support_scenario );
