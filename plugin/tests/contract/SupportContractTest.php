<?php
/**
 * Contract fixtures through the real REST server and HTTP adapter.
 *
 * @package GQ_Support
 */

use PHPUnit\Framework\TestCase;

/** WordPress is bootstrapped by the disposable site's WP-CLI. */
final class GQ_Support_Contract_Test extends TestCase {
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
	 * Stubbed service response.
	 *
	 * @var array
	 */
	private $reply;
	/**
	 * Stubbed service status.
	 *
	 * @var int
	 */
	private $upstream_status = 201;
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
				'user_login' => 'contract-' . wp_generate_uuid4(),
				'user_pass'  => wp_generate_password(),
				'role'       => 'subscriber',
			)
		);
		wp_set_current_user( $this->user );
		wp_get_current_user()->add_cap( 'gq_support_submit_requests' );
		$token                       = WP_Session_Tokens::get_instance( $this->user )->create( time() + HOUR_IN_SECONDS );
		$_COOKIE[ LOGGED_IN_COOKIE ] = wp_generate_auth_cookie( $this->user, time() + HOUR_IN_SECONDS, 'logged_in', $token );
		GQ_Support_Signing_Key::pending_for( 'CONTRACT-TEST' );
		GQ_Support_Signing_Key::promote();
		GQ_Support_State::update(
			array(
				'connection' => 'connected',
				'key_id'     => 'contract-test-key',
			)
		);
		$this->reply = $this->owned( self::fixtures( 'resources' )[5]['resource'] );
		$this->stub  = function ( $preempt, $args, $url ) {
			$this->calls[] = array( $url, $args );
			return array(
				'response' => array( 'code' => $this->upstream_status ),
				'headers'  => array( 'retry-after' => '60' ),
				'body'     => wp_json_encode( $this->reply ),
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
	 * Read shared, language-neutral contract cases.
	 *
	 * @param string $name Fixture group.
	 * @return array
	 */
	private static function fixtures( string $name ): array {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Local versioned JSON fixture.
		return json_decode( file_get_contents( __DIR__ . '/../../../contract/fixtures/' . $name . '.json' ), true, 512, JSON_THROW_ON_ERROR );
	}

	/**
	 * Add the service-only ownership attestation for the current Reporter.
	 *
	 * @param array $item Public resource.
	 * @return array
	 */
	private function owned( array $item ): array {
		return $item + array(
			'installation_id'  => GQ_Support_State::get()['installation_id'],
			'reporter_subject' => GQ_Support_Access::subject(),
		);
	}

	/**
	 * Dispatch through the public REST server and its response filters.
	 *
	 * @param string     $method HTTP method.
	 * @param string     $path Support path.
	 * @param array|null $payload JSON body.
	 * @param int        $padding Trailing JSON whitespace in bytes.
	 * @param array      $query Query arguments.
	 */
	private function request( string $method, string $path = '/requests', ?array $payload = null, int $padding = 0, array $query = array() ): WP_REST_Response {
		$request = new WP_REST_Request( $method, '/gq-support/v1' . $path );
		$request->set_query_params( $query );
		$request->set_header( 'X-WP-Nonce', wp_create_nonce( 'wp_rest' ) );
		if ( null !== $payload ) {
			$request->set_header( 'Content-Type', 'application/json' );
			$request->set_body( wp_json_encode( $payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES ) . str_repeat( ' ', $padding ) );
		}
		$response = rest_do_request( $request );
		$response = apply_filters( 'rest_post_dispatch', $response, rest_get_server(), $request );
		self::assertSame( 'private, no-store', $response->get_headers()['Cache-Control'] );
		return $response;
	}

	/**
	 * Create boundary cases.
	 *
	 * @return array
	 */
	public static function create_cases(): array {
		return array_column(
			array_map(
				static function ( $fixture ) {
					return array( $fixture['name'], array( $fixture ) );
				},
				self::fixtures( 'create' )
			),
			1,
			0
		);
	}

	/**
	 * Enforce each create limit without forwarding invalid payloads.
	 *
	 * @dataProvider create_cases
	 * @param array $fixture Shared create case.
	 */
	public function test_create_limits( array $fixture ): void {
		$response = $this->request( 'POST', '/requests', $fixture['payload'], $fixture['padding'] );
		self::assertSame( $fixture['status'], $response->get_status(), $fixture['name'] );
		if ( isset( $fixture['codes'] ) ) {
			self::assertContains( $response->get_data()['code'], $fixture['codes'] );
		}
		self::assertCount( 201 === $fixture['status'] ? 1 : 0, $this->calls );
	}

	/** A retry carries only the public predecessor reference and attested identity. */
	public function test_failed_request_replacement_is_forwarded(): void {
		$payload                  = self::fixtures( 'create' )[0]['payload'];
		$payload['supersedes_id'] = 'req_01J8Z6Q4M1ZC7X000000000000';
		self::assertSame( 201, $this->request( 'POST', '/requests', $payload )->get_status() );
		$forwarded = json_decode( $this->calls[0][1]['body'], true );
		self::assertSame( $payload['supersedes_id'], $forwarded['supersedes_id'] );
		self::assertSame( GQ_Support_Access::subject(), $forwarded['reporter_subject'] );
		self::assertSame( 'mine', $forwarded['scope'] );
	}

	/**
	 * Delivery and status combinations.
	 *
	 * @return array
	 */
	public static function resource_cases(): array {
		$fixtures = array();
		foreach ( self::fixtures( 'resources' ) as $fixture ) {
			$fixtures[ $fixture['name'] ] = array( $fixture );
		}
		return $fixtures;
	}

	/**
	 * Validate resources on reads, lists and creates.
	 *
	 * @dataProvider resource_cases
	 * @param array $fixture Shared delivery case.
	 */
	public function test_resource_and_list_delivery_status( array $fixture ): void {
		$this->upstream_status = 200;
		$this->reply           = $this->owned( $fixture['resource'] );
		self::assertSame( $fixture['valid'] ? 200 : 503, $this->request( 'GET', '/requests/req_one' )->get_status() );
		$this->reply = array(
			'items'       => array( $this->reply ),
			'next_cursor' => null,
		);
		self::assertSame( $fixture['valid'] ? 200 : 503, $this->request( 'GET' )->get_status() );
		$this->reply           = $this->owned( $fixture['resource'] );
		$this->upstream_status = $fixture['create_status'];
		$payload               = self::fixtures( 'create' )[0]['payload'];
		$response              = $this->request( 'POST', '/requests', $payload );
		self::assertSame( $fixture['valid'] ? $fixture['create_status'] : 504, $response->get_status() );
		if ( $fixture['valid'] ) {
			// WordPress adds `own` after verifying the service's ownership metadata.
			self::assertSame( $fixture['resource'] + array( 'own' => true ), $response->get_data() );
			if ( 201 === $fixture['create_status'] ) {
				self::assertStringEndsWith( '/requests/req_one', $response->get_headers()['Location'] );
			}
		}
	}

	/**
	 * Worker error mappings.
	 *
	 * @return array
	 */
	public static function error_cases(): array {
		$fixtures = array();
		foreach ( self::fixtures( 'errors' ) as $fixture ) {
			$fixtures[ (string) $fixture['status'] ] = array( $fixture );
		}
		return $fixtures;
	}

	/**
	 * Map Worker failures without disclosing upstream content.
	 *
	 * @dataProvider error_cases
	 * @param array $fixture Shared Worker error.
	 */
	public function test_worker_errors_are_sanitized( array $fixture ): void {
		$this->upstream_status = $fixture['status'];
		$this->reply           = array(
			'code'    => 'private-worker-detail',
			'message' => 'SECRET REPORT AND CREDENTIAL',
			'data'    => array( 'private' => true ),
		);
		foreach ( array(
			'GET'  => 'read_code',
			'POST' => 'create_code',
		) as $method => $key ) {
			$response = $this->request( $method, '/requests', 'POST' === $method ? self::fixtures( 'create' )[0]['payload'] : null );
			$data     = $response->get_data();
			self::assertSame( $fixture[ $key ], $data['code'] );
			self::assertSame( 'GET' === $method && 504 === $fixture['status'] ? 503 : $fixture['browser_status'], $response->get_status() );
			self::assertArrayHasKey( 'correlation_id', $data['data'] );
			self::assertIsBool( $data['data']['retryable'] );
			self::assertStringNotContainsString( 'SECRET', wp_json_encode( $data ) );
			if ( 429 === $fixture['status'] ) {
				self::assertSame( '60', $response->get_headers()['Retry-After'] );
			}
		}
	}

	/**
	 * Ambiguous transport outcomes.
	 *
	 * @return array
	 */
	public static function ambiguous_cases(): array {
		return array(
			'timeout'            => array( 'timeout' ),
			'TLS'                => array( 'tls' ),
			'redirect'           => array( 'redirect' ),
			'malformed'          => array( 'malformed' ),
			'oversized'          => array( 'oversized' ),
			'truncated boundary' => array( 'boundary' ),
			'empty'              => array( 'empty' ),
		);
	}

	/**
	 * Never infer acceptance from ambiguous transport outcomes.
	 *
	 * @dataProvider ambiguous_cases
	 * @param string $kind Transport failure scenario.
	 */
	public function test_ambiguous_transport_never_claims_acceptance( string $kind ): void {
		$log_path = wp_tempnam( 'gq-support-contract' );
		// phpcs:ignore WordPress.PHP.IniSet -- Isolate and restore this disposable test's log capture.
		$old_log = ini_set( 'error_log', $log_path );
		// phpcs:ignore WordPress.PHP.IniSet -- Isolate and restore this disposable test's log capture.
		$old_logging = ini_set( 'log_errors', '1' );
		$stub        = static function () use ( $kind ) {
			if ( in_array( $kind, array( 'timeout', 'tls' ), true ) ) {
				return new WP_Error( 'http_request_failed', 'SECRET ' . $kind );
			}
			$body = array(
				'redirect'  => '{}',
				'malformed' => '{SECRET REPORT',
				'oversized' => '{"text":"' . str_repeat( 'a', 65536 ) . '"}',
				'boundary'  => '{}' . str_repeat( ' ', 65534 ),
				'empty'     => '',
			);
			return array(
				'response' => array( 'code' => 'redirect' === $kind ? 302 : 201 ),
				'body'     => $body[ $kind ],
			);
		};
		add_filter( 'pre_http_request', $stub, 11 );
		try {
			foreach ( array(
				'POST' => 'gq_support_outcome_unknown',
				'GET'  => 'gq_support_unavailable',
			) as $method => $code ) {
				$response = $this->request( $method, '/requests', 'POST' === $method ? self::fixtures( 'create' )[0]['payload'] : null );
				self::assertSame( $code, $response->get_data()['code'] );
				self::assertStringNotContainsString( 'SECRET', wp_json_encode( $response->get_data() ) );
				if ( 'POST' === $method ) {
					self::assertSame( self::fixtures( 'create' )[0]['payload']['submission_id'], $response->get_data()['data']['submission_id'] );
				}
			}
		} finally {
			remove_filter( 'pre_http_request', $stub, 11 );
			// phpcs:ignore WordPress.PHP.IniSet -- Isolate and restore this disposable test's log capture.
			ini_set( 'error_log', $old_log );
			// phpcs:ignore WordPress.PHP.IniSet -- Isolate and restore this disposable test's log capture.
			ini_set( 'log_errors', $old_logging );
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Inspect only this test's temporary log.
			$logged = (string) file_get_contents( $log_path );
			wp_delete_file( $log_path );
			self::assertStringNotContainsString( 'SECRET', $logged );
			self::assertStringNotContainsString( str_repeat( 'a', 100 ), $logged );
		}
	}

	/** Verify transport settings and fresh calls for repeated reads. */
	public function test_transport_policy_and_repeated_reads_are_uncached(): void {
		$this->request( 'POST', '/requests', self::fixtures( 'create' )[0]['payload'] );
		$this->upstream_status = 200;
		$this->reply           = array(
			'items'       => array(),
			'next_cursor' => null,
		);
		$this->request( 'GET' );
		$this->request( 'GET' );
		self::assertCount( 3, $this->calls );
		foreach ( $this->calls as $index => list( $url, $args ) ) {
			self::assertStringStartsWith( 'https://support.getquick.io/v1/requests', $url );
			self::assertSame( 0 === $index ? 8 : 5, $args['timeout'] );
			self::assertSame( 0, $args['redirection'] );
			self::assertTrue( $args['sslverify'] );
			self::assertTrue( $args['reject_unsafe_urls'] );
			self::assertSame( 65536, $args['limit_response_size'] );
			foreach ( array( 'GQ-Support-Plugin-Version', 'GQ-Support-Key-Id', 'GQ-Support-Installation-Id', 'GQ-Support-Timestamp', 'GQ-Support-Request-Id', 'Content-Digest', 'GQ-Support-Signature' ) as $header ) {
				self::assertArrayHasKey( $header, $args['headers'] );
			}
		}
	}

	/** A 201 acknowledgment must describe a delivered request. */
	public function test_create_http_status_matches_delivery(): void {
		$this->reply['delivery'] = 'accepted-pending';
		$this->reply['status']   = null;
		self::assertSame( 504, $this->request( 'POST', '/requests', self::fixtures( 'create' )[0]['payload'] )->get_status() );
	}

	/**
	 * Pagination boundary cases.
	 *
	 * @return array
	 */
	public static function list_cases(): array {
		return array_map(
			static function ( $fixture ) {
				return array( $fixture );
			},
			self::fixtures( 'list' )
		);
	}

	/**
	 * Validate list arguments before forwarding.
	 *
	 * @dataProvider list_cases
	 * @param array $fixture Shared pagination case.
	 */
	public function test_list_limits( array $fixture ): void {
		$this->upstream_status = 200;
		$this->reply           = array(
			'items'       => array(),
			'next_cursor' => null,
		);
		$response              = $this->request( 'GET', '/requests', null, 0, $fixture['params'] );
		self::assertSame( $fixture['status'], $response->get_status(), $fixture['name'] );
		self::assertCount( 200 === $fixture['status'] ? 1 : 0, $this->calls );
	}

	/** Repeated creates forward the same intent without changing the submitted text. */
	public function test_repeated_submissions_preserve_identity_and_body(): void {
		$payload = self::fixtures( 'create' )[0]['payload'];
		$first   = $this->request( 'POST', '/requests', $payload );
		$second  = $this->request( 'POST', '/requests', $payload );
		self::assertSame( $first->get_data(), $second->get_data() );
		self::assertSame( $this->calls[0][1]['body'], $this->calls[1][1]['body'] );
		self::assertSame( $payload['submission_id'], $second->get_data()['submission_id'] );
	}

	/**
	 * Browser authorization and configuration errors.
	 *
	 * @return array
	 */
	public static function local_error_cases(): array {
		return array_map(
			static function ( $fixture ) {
				return array( $fixture );
			},
			self::fixtures( 'local-errors' )
		);
	}

	/**
	 * Local failures use the catalogue and never contact the Worker.
	 *
	 * @dataProvider local_error_cases
	 * @param array $fixture Local boundary failure.
	 */
	public function test_local_errors( array $fixture ): void {
		switch ( $fixture['scenario'] ) {
			case 'anonymous':
				wp_set_current_user( 0 );
				break;
			case 'cookie expired':
				unset( $_COOKIE[ LOGGED_IN_COOKIE ] );
				break;
			case 'grant missing':
				wp_get_current_user()->remove_cap( 'gq_support_submit_requests' );
				break;
			case 'not connected':
				GQ_Support_State::update( GQ_Support_State::disconnected( 'not_connected' ) );
				break;
		}
		$response = $this->request( 'GET' );
		self::assertSame( $fixture['status'], $response->get_status() );
		self::assertSame( $fixture['code'], $response->get_data()['code'] );
		self::assertCount( 0, $this->calls );
	}

	/**
	 * Shared signing cases, also verified by the Worker.
	 *
	 * @return array
	 */
	public static function signing_cases(): array {
		$fixtures = array();
		foreach ( self::fixtures( 'signing' )['cases'] as $fixture ) {
			$fixtures[ $fixture['name'] ] = array( $fixture );
		}
		return $fixtures;
	}

	/**
	 * Produce exactly the headers, canonical string and signature the Worker verifies.
	 *
	 * @dataProvider signing_cases
	 * @param array $fixture Shared signing case.
	 */
	public function test_signer_matches_shared_fixture( array $fixture ): void {
		$keys    = self::fixtures( 'signing' );
		$secret  = sodium_base642bin( $keys['secret_key'], SODIUM_BASE64_VARIANT_ORIGINAL );
		$signer  = new GQ_Support_Signer( $secret, $fixture['headers']['GQ-Support-Key-Id'], $fixture['headers']['GQ-Support-Installation-Id'] );
		$headers = $signer->headers( $fixture['method'], $fixture['path'], $fixture['body'], (int) $fixture['headers']['GQ-Support-Timestamp'], $fixture['headers']['GQ-Support-Request-Id'] );
		self::assertSame(
			$fixture['headers'] + array(
				'Content-Digest'       => $fixture['content_digest'],
				'GQ-Support-Signature' => $fixture['signature'],
			),
			$headers
		);
		self::assertSame( $fixture['canonical'], GQ_Support_Signer::canonical( $fixture['method'], $fixture['path'], $fixture['body'], $headers ) );
		self::assertSame( $keys['public_key'], GQ_Support_Signing_Key::encode( GQ_Support_Signing_Key::public_key( $secret ) ) );
	}

	/** The adapter must reject even a complete JSON value at the truncation boundary. */
	public function test_oversized_response_is_ambiguous(): void {
		$stub = static function () {
			return array(
				'response' => array( 'code' => 200 ),
				'body'     => '{"text":"' . str_repeat( 'x', 65536 ) . '"}',
			);
		};
		add_filter( 'pre_http_request', $stub, 11 );
		try {
			$key    = sodium_crypto_sign_secretkey( sodium_crypto_sign_keypair() );
			$result = GQ_Support_Service_Client::request( 'GET', '/v1/requests', null, new GQ_Support_Signer( $key, 'key', 'installation' ), 5 );
			self::assertInstanceOf( WP_Error::class, $result );
			self::assertSame( 'gq_support_ambiguous_response', $result->get_error_code() );
		} finally {
			remove_filter( 'pre_http_request', $stub, 11 );
		}
	}
}
