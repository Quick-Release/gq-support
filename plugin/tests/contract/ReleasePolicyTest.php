<?php
/**
 * The release policy at the installation (#141, ADR 0021): a signed plugin
 * version, a cached service policy and local new-intake disablement that
 * preserves accepted work, through the real REST server and HTTP adapter.
 *
 * @package GQ_Support
 */

use PHPUnit\Framework\TestCase;

/** WordPress is bootstrapped by the disposable site's WP-CLI. */
final class GQ_Support_Release_Policy_Test extends TestCase {
	/**
	 * Reporter created for this test.
	 *
	 * @var int
	 */
	private $user;
	/**
	 * Original connection state.
	 *
	 * @var array
	 */
	private $state;
	/**
	 * Original local signing key.
	 *
	 * @var array|false
	 */
	private $key;
	/**
	 * Stubbed service replies, in order; the last repeats.
	 *
	 * @var array<int, array{0: int, 1: array}>
	 */
	private $replies = array();
	/**
	 * HTTP boundary stub.
	 *
	 * @var Closure
	 */
	private $stub;
	/**
	 * Captured service requests.
	 *
	 * @var array
	 */
	private $calls = array();

	/** Connect an isolated Reporter and stub only the external HTTP boundary. */
	protected function setUp(): void {
		$this->state = GQ_Support_State::get();
		$this->key   = get_option( GQ_Support_Signing_Key::OPTION );
		$this->user  = wp_insert_user(
			array(
				'user_login' => 'release-' . wp_generate_uuid4(),
				'user_pass'  => wp_generate_password(),
				'role'       => 'subscriber',
			)
		);
		wp_set_current_user( $this->user );
		wp_get_current_user()->add_cap( 'gq_support_submit_requests' );
		$token                       = WP_Session_Tokens::get_instance( $this->user )->create( time() + HOUR_IN_SECONDS );
		$_COOKIE[ LOGGED_IN_COOKIE ] = wp_generate_auth_cookie( $this->user, time() + HOUR_IN_SECONDS, 'logged_in', $token );
		GQ_Support_Signing_Key::pending_for( 'RELEASE-TEST' );
		GQ_Support_Signing_Key::promote();
		GQ_Support_State::update(
			array(
				'connection' => 'connected',
				'key_id'     => 'release-test-key',
				'release'    => null,
			)
		);
		$this->stub = function ( $preempt, $args, $url ) {
			$this->calls[]          = array( $url, $args );
			list( $status, $reply ) = count( $this->replies ) > 1 ? array_shift( $this->replies ) : $this->replies[0];
			return array(
				'response' => array( 'code' => $status ),
				'headers'  => array(),
				'body'     => wp_json_encode( $reply ),
			);
		};
		add_filter( 'pre_http_request', $this->stub, 10, 3 );
	}

	/** Restore connection state and remove the temporary Reporter. */
	protected function tearDown(): void {
		remove_filter( 'pre_http_request', $this->stub );
		update_option( GQ_Support_State::OPTION, $this->state, false );
		if ( false === $this->key ) {
			GQ_Support_Signing_Key::delete();
		} else {
			update_option( GQ_Support_Signing_Key::OPTION, $this->key, false );
		}
		wp_set_current_user( 0 );
		unset( $_COOKIE[ LOGGED_IN_COOKIE ] );
		require_once ABSPATH . 'wp-admin/includes/user.php';
		if ( is_multisite() ) {
			wpmu_delete_user( $this->user );
		} else {
			wp_delete_user( $this->user );
		}
	}

	/**
	 * The policy the Worker returns for this plugin (worker/src/release-policy.ts).
	 *
	 * @param array<string, mixed> $fields Fields to replace.
	 * @return array<string, mixed>
	 */
	private static function policy( array $fields = array() ): array {
		return $fields + array(
			'enforcement'      => 'enforced',
			'intake'           => 'open',
			'reason'           => 'current',
			'plugin_version'   => GQ_SUPPORT_VERSION,
			'approved_version' => GQ_SUPPORT_VERSION,
			'compatible_until' => null,
		);
	}

	/**
	 * The installation check's reply with a policy.
	 *
	 * @param array|null $release The policy, or null when the service could not say.
	 */
	private static function installation( ?array $release ): array {
		return array(
			200,
			array(
				'key_id'        => 'release-test-key',
				'environment'   => wp_get_environment_type(),
				'connected_at'  => '2026-10-20T10:00:00.000Z',
				'mapping_state' => 'active',
				'release'       => $release,
			),
		);
	}

	/**
	 * A create through the public REST server.
	 *
	 * @param string $submission_id Submission ID.
	 */
	private function create( string $submission_id ): WP_REST_Response {
		$request = new WP_REST_Request( 'POST', '/gq-support/v1/requests' );
		$request->set_header( 'X-WP-Nonce', wp_create_nonce( 'wp_rest' ) );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body(
			wp_json_encode(
				array(
					'submission_id' => $submission_id,
					'description'   => 'Checkout does nothing',
				)
			)
		);
		return rest_do_request( $request );
	}

	/**
	 * A receipt the service returns for an accepted create.
	 *
	 * @param string $submission_id Submission ID.
	 */
	private function receipt( string $submission_id ): array {
		return array(
			202,
			array(
				'id'               => 'req_01J8Z6Q4M1ZC7X000000000001',
				'submission_id'    => $submission_id,
				'title'            => 'Checkout does nothing',
				'summary'          => null,
				'description'      => 'Checkout does nothing',
				'created_at'       => '2026-10-20T10:00:00.000Z',
				'delivery'         => 'accepted-pending',
				'status'           => null,
				'status_change'    => null,
				'installation_id'  => GQ_Support_State::get()['installation_id'],
				'reporter_subject' => GQ_Support_Access::subject(),
			),
		);
	}

	/** Every request signs this plugin's version, so the service can trust it (gq-support-v2). */
	public function test_requests_sign_the_plugin_version(): void {
		$this->replies = array( self::installation( self::policy() ) );
		GQ_Support_Connection::test();
		$headers = $this->calls[0][1]['headers'];
		self::assertSame( GQ_SUPPORT_VERSION, $headers['GQ-Support-Plugin-Version'] );
		$canonical = GQ_Support_Signer::canonical( 'GET', '/v1/installation', '', $headers );
		self::assertStringStartsWith( "gq-support-v2\nGET\n/v1/installation\nrelease-test-key\n", $canonical );
		self::assertStringContainsString( "\n" . GQ_SUPPORT_VERSION . "\n", $canonical );
		$public = GQ_Support_Signing_Key::public_key( GQ_Support_Signing_Key::active() );
		self::assertTrue( sodium_crypto_sign_verify_detached( base64_decode( $headers['GQ-Support-Signature'] ), $canonical, $public ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
	}

	/** An explicit connection test caches the policy; later local decisions make no remote call. */
	public function test_connection_test_caches_the_policy_and_the_window_closes_locally(): void {
		$now           = time();
		$this->replies = array(
			self::installation(
				self::policy(
					array(
						'reason'           => 'previous',
						'compatible_until' => gmdate( 'Y-m-d\TH:i:s.000\Z', $now + 60 ),
					)
				)
			),
		);
		self::assertSame( 'unknown', GQ_Support_Release::local_intake( $now ) );
		GQ_Support_Connection::test();
		self::assertCount( 1, $this->calls );
		self::assertSame( 'open', GQ_Support_Release::local_intake( $now + 59 ) );
		// Exactly at expiry new intake closes here too, with no further service call.
		self::assertSame( 'closed', GQ_Support_Release::local_intake( $now + 60 ) );
		self::assertCount( 1, $this->calls );
	}

	/** Staged, unavailable, unreachable or malformed answers never close intake locally. */
	public function test_only_an_outdated_plugin_closes_intake_locally(): void {
		foreach ( array(
			array( self::policy( array( 'enforcement' => 'staged' ) ), 'open' ),
			array(
				self::policy(
					array(
						'intake' => 'closed',
						'reason' => 'unavailable',
					)
				),
				'open',
			),
			array(
				self::policy(
					array(
						'intake'           => 'closed',
						'reason'           => 'expired',
						'compatible_until' => null,
					)
				),
				'closed',
			),
		) as list( $release, $expected ) ) {
			$this->replies = array( self::installation( $release ) );
			GQ_Support_Connection::test();
			self::assertSame( $expected, GQ_Support_Release::local_intake( time() ) );
		}
		// What cannot be trusted leaves the last known policy alone.
		foreach ( array(
			self::installation( null ),
			self::installation( self::policy( array( 'intake' => 'open' ) ) + array( 'extra' => 1 ) ),
			self::installation( self::policy( array( 'reason' => 'whatever' ) ) ),
			self::installation( self::policy( array( 'plugin_version' => '0.0.1' ) ) ),
			self::installation( self::policy( array( 'compatible_until' => 'tomorrow' ) ) ),
			array( 503, array( 'code' => 'service_unavailable' ) ),
		) as $reply ) {
			$this->replies = array( $reply );
			GQ_Support_Connection::test();
			self::assertSame( 'closed', GQ_Support_Release::local_intake( time() ) );
		}
	}

	/** After the plugin itself is updated, a policy learned for its old version is unknown. */
	public function test_a_policy_for_another_version_is_unknown(): void {
		GQ_Support_State::update(
			array(
				'release' => array( 'plugin_version' => '0.0.1' ) + array_intersect_key(
					self::policy(
						array(
							'intake' => 'closed',
							'reason' => 'expired',
						)
					),
					array_flip( array( 'enforcement', 'intake', 'reason' ) )
				) + array( 'compatible_until' => null ),
			)
		);
		self::assertSame( 'unknown', GQ_Support_Release::local_intake( time() ) );
		$this->replies = array( $this->receipt( '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11' ) );
		self::assertSame( 202, $this->create( '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11' )->get_status() );
		self::assertArrayNotHasKey( 'reconcile_only', json_decode( $this->calls[0][1]['body'], true ) );
	}

	/** The service's refusal teaches the local policy, so the next execution stops new intake itself. */
	public function test_service_refusal_is_cached(): void {
		$this->replies = array(
			array(
				426,
				array(
					'code'    => 'gq_support_plugin_outdated',
					'release' => self::policy(
						array(
							'intake' => 'closed',
							'reason' => 'expired',
						)
					),
				),
			),
		);
		$response      = $this->create( '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11' );
		self::assertSame( 426, $response->get_status() );
		self::assertSame( 'gq_support_plugin_outdated', $response->get_data()['code'] );
		self::assertSame( 'closed', GQ_Support_Release::local_intake( time() ) );
	}

	/** Locally closed: a create only checks for its accepted intent, and reads keep working. */
	public function test_locally_closed_create_reconciles_but_never_starts_new_intake(): void {
		$submission    = '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11';
		$this->replies = array(
			self::installation(
				self::policy(
					array(
						'intake' => 'closed',
						'reason' => 'unsupported',
					)
				)
			),
		);
		GQ_Support_Connection::test();

		// An intent the service already accepted is still returned: no false failure or loss.
		$this->replies = array( $this->receipt( $submission ) );
		$accepted      = $this->create( $submission );
		self::assertSame( 202, $accepted->get_status() );
		self::assertSame( 'req_01J8Z6Q4M1ZC7X000000000001', $accepted->get_data()['id'] );
		self::assertTrue( json_decode( $this->calls[1][1]['body'], true )['reconcile_only'] );

		// A new intent is refused honestly, as an outdated plugin.
		$this->replies = array( array( 412, array( 'code' => 'gq_support_context_expired' ) ) );
		$refused       = $this->create( '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c12' );
		self::assertSame( 426, $refused->get_status() );
		self::assertSame( 'gq_support_plugin_outdated', $refused->get_data()['code'] );
		self::assertTrue( json_decode( $this->calls[2][1]['body'], true )['reconcile_only'] );

		$this->replies = array(
			array(
				200,
				array(
					'items'       => array(),
					'next_cursor' => null,
				),
			),
		);
		$read          = new WP_REST_Request( 'GET', '/gq-support/v1/requests' );
		$read->set_header( 'X-WP-Nonce', wp_create_nonce( 'wp_rest' ) );
		$list = rest_do_request( $read );
		self::assertSame( 200, $list->get_status() );
		self::assertStringNotContainsString( 'reconcile_only', (string) $this->calls[3][0] );
	}
}
