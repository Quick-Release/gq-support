<?php
/**
 * Report context through the real REST server, AJAX preview and HTTP adapter
 * (docs/support-context-design.md, acceptance cases 1, 2, 4–7 and 10).
 *
 * @package GQ_Support
 */

use PHPUnit\Framework\TestCase;

/** WordPress is bootstrapped by the disposable site's WP-CLI. */
final class GQ_Support_Report_Context_Test extends TestCase {
	private const SUBMISSION = '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11';

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
	 * Original WordPress version global.
	 *
	 * @var string
	 */
	private $wp_version;
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
	private $upstream_status = 202;
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
	/**
	 * Arguments of every plugin-owned hook fired during the test.
	 *
	 * @var array
	 */
	private $hooks = array();
	/**
	 * Hook observer.
	 *
	 * @var Closure
	 */
	private $observer;
	/**
	 * Temporary error log.
	 *
	 * @var string
	 */
	private $log;
	/**
	 * Settings replaced while capturing the error log.
	 *
	 * @var array
	 */
	private $logging = array();

	/** Connect an isolated Reporter, stub only the external HTTP boundary, and capture logs and plugin hooks. */
	protected function setUp(): void {
		global $wp_version;
		$this->wp_version = $wp_version;
		$this->state      = GQ_Support_State::get();
		$this->key        = get_option( GQ_Support_Signing_Key::OPTION );
		$this->user       = wp_insert_user(
			array(
				'user_login' => 'context-' . wp_generate_uuid4(),
				'user_pass'  => wp_generate_password(),
				'role'       => 'subscriber',
			)
		);
		$this->login( $this->user );
		wp_get_current_user()->add_cap( 'gq_support_submit_requests' );
		GQ_Support_Signing_Key::pending_for( 'CONTEXT-TEST' );
		GQ_Support_Signing_Key::promote();
		GQ_Support_State::update(
			array(
				'connection' => 'connected',
				'key_id'     => 'context-test-key',
			)
		);
		$this->reply = $this->owned( self::fixtures( 'resources' )[0]['resource'] );
		$this->stub  = function ( $preempt, $args, $url ) {
			$this->calls[] = array( $url, $args );
			return array(
				'response' => array( 'code' => $this->upstream_status ),
				'headers'  => array(),
				'body'     => wp_json_encode( $this->reply ),
			);
		};
		add_filter( 'pre_http_request', $this->stub, 10, 3 );
		$this->observer = function () {
			if ( str_starts_with( current_filter(), 'gq_support' ) ) {
				$this->hooks[] = wp_json_encode( func_get_args() );
			}
		};
		add_action( 'all', $this->observer );
		$this->log = wp_tempnam( 'gq-support-context' );
		// phpcs:ignore WordPress.PHP.IniSet -- Isolate and restore this disposable test's log capture.
		$this->logging = array( ini_set( 'error_log', $this->log ), ini_set( 'log_errors', '1' ) );
	}

	/** Restore connection state, versions and logging, and remove the temporary Reporter. */
	protected function tearDown(): void {
		global $wp_version;
		$wp_version = $this->wp_version; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited -- Restore the simulated upgrade.
		remove_filter( 'pre_http_request', $this->stub );
		remove_action( 'all', $this->observer );
		// phpcs:ignore WordPress.PHP.IniSet -- Restore this disposable test's log capture.
		ini_set( 'error_log', $this->logging[0] );
		// phpcs:ignore WordPress.PHP.IniSet -- Restore this disposable test's log capture.
		ini_set( 'log_errors', $this->logging[1] );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Inspect only this test's temporary log.
		$logged = (string) file_get_contents( $this->log );
		wp_delete_file( $this->log );
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
		// Context, the review envelope and the URL a launcher opened from never reach logs or plugin hooks.
		foreach ( array_merge( array( $logged ), $this->hooks ) as $output ) {
			foreach ( array( 'post-editor', 'v1.', '_wpnonce', 'secret', GQ_SUPPORT_VERSION . '"', '"wp_version"' ) as $needle ) {
				self::assertStringNotContainsString( $needle, $output );
			}
		}
	}

	/**
	 * A cookie session for the user.
	 *
	 * @param int $id User ID.
	 */
	private function login( int $id ): void {
		wp_set_current_user( $id );
		$token                       = WP_Session_Tokens::get_instance( $id )->create( time() + HOUR_IN_SECONDS );
		$_COOKIE[ LOGGED_IN_COOKIE ] = wp_generate_auth_cookie( $id, time() + HOUR_IN_SECONDS, 'logged_in', $token );
	}

	/**
	 * Read shared, language-neutral contract cases.
	 *
	 * @param string $name  Fixture group.
	 * @param bool   $assoc Decode objects as arrays.
	 * @return mixed
	 */
	private static function fixtures( string $name, bool $assoc = true ) {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Local versioned JSON fixture.
		return json_decode( file_get_contents( __DIR__ . '/../../../contract/fixtures/' . $name . '.json' ), $assoc, 512, JSON_THROW_ON_ERROR );
	}

	/**
	 * Add the service-only ownership attestation for the current Reporter.
	 *
	 * @param array $item Public resource.
	 * @return array
	 */
	private function owned( array $item ): array {
		return array( 'submission_id' => self::SUBMISSION ) + $item + array(
			'installation_id'  => GQ_Support_State::get()['installation_id'],
			'reporter_subject' => GQ_Support_Access::subject(),
		);
	}

	/**
	 * Dispatch a create through the public REST server and its response filters.
	 *
	 * @param array $payload Browser JSON body.
	 * @param int   $padding Trailing JSON whitespace in bytes.
	 */
	private function create( array $payload, int $padding = 0 ): WP_REST_Response {
		$request = new WP_REST_Request( 'POST', '/gq-support/v1/requests' );
		$request->set_header( 'X-WP-Nonce', wp_create_nonce( 'wp_rest' ) );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body( self::json( $payload ) . str_repeat( ' ', $padding ) );
		$response = rest_do_request( $request );
		return apply_filters( 'rest_post_dispatch', $response, rest_get_server(), $request );
	}

	/**
	 * Compact JSON, as the browser serializes it.
	 *
	 * @param mixed $value Value.
	 */
	private static function json( $value ): string {
		return (string) wp_json_encode( $value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
	}

	/**
	 * A create body with reviewed context, as the panel sends it.
	 *
	 * @param array       $context Context, normalized.
	 * @param string|null $review  Envelope, or a fresh one for this context and Submission ID.
	 * @return array
	 */
	private function reviewed( array $context, ?string $review = null ): array {
		return array(
			'submission_id'  => self::SUBMISSION,
			'description'    => 'Checkout does nothing',
			'context'        => GQ_Support_Report_Context::json_value( $context ),
			'context_review' => $review ?? GQ_Support_Report_Context::envelope( $context, self::SUBMISSION, GQ_Support_Access::subject(), time() ),
		);
	}

	/**
	 * The default context for a launcher on the post editor.
	 *
	 * @return array
	 */
	private static function editor_context(): array {
		return array(
			'schema'  => 1,
			'default' => array(
				'wp_version'             => get_bloginfo( 'version' ),
				'support_plugin_version' => GQ_SUPPORT_VERSION,
				'originating_screen'     => 'post-editor',
			),
		);
	}

	/**
	 * What WordPress forwarded to the service, by call.
	 *
	 * @param int $index Call index.
	 * @return array
	 */
	private function forwarded( int $index = 0 ): array {
		return json_decode( $this->calls[ $index ][1]['body'], true );
	}

	/**
	 * The forwarded context, serialized again with objects kept as objects.
	 *
	 * @param int $index Call index.
	 */
	private function forwarded_context( int $index = 0 ): string {
		return self::json( json_decode( $this->calls[ $index ][1]['body'] )->context );
	}

	/**
	 * Run the preview AJAX action with these fields and decode what it sent.
	 *
	 * @param array $fields POST fields.
	 * @return array
	 * @throws Exception Anything the action throws other than its exit.
	 */
	private function preview( array $fields ): array {
		$_POST = $fields;
		// Stands in for the exit that ends an AJAX response.
		$exit = new class() extends Exception {};
		$done = static function () use ( $exit ) {
			return static function () use ( $exit ) {
				throw $exit;
			};
		};
		add_filter( 'wp_doing_ajax', '__return_true' );
		add_filter( 'wp_die_ajax_handler', $done );
		ob_start();
		try {
			do_action( 'wp_ajax_gq_support_context' );
		} catch ( Exception $e ) {
			if ( $e !== $exit ) {
				throw $e;
			}
		} finally {
			$output = (string) ob_get_clean();
			remove_filter( 'wp_doing_ajax', '__return_true' );
			remove_filter( 'wp_die_ajax_handler', $done );
			$_POST = array();
		}
		return json_decode( $output, true );
	}

	/**
	 * Preview fields from a current session.
	 *
	 * @param array $fields Overrides.
	 * @return array
	 */
	private static function preview_fields( array $fields = array() ): array {
		return $fields + array(
			'session'       => GQ_Support_Access::session(),
			'nonce'         => wp_create_nonce( 'wp_rest' ),
			'submission_id' => self::SUBMISSION,
			'screen'        => 'post-editor',
		);
	}

	/** Each side's limits are the shared ones. */
	public function test_limits_match_the_shared_fixture(): void {
		$limits = self::fixtures( 'context' )['limits'];
		self::assertSame(
			array( $limits['schema'], $limits['scalar_bytes'], $limits['context_bytes'], $limits['default_keys'], $limits['create_body_bytes'] ),
			array( GQ_Support_Report_Context::SCHEMA, GQ_Support_Report_Context::SCALAR_BYTES, GQ_Support_Report_Context::CONTEXT_BYTES, GQ_Support_Report_Context::DEFAULT_KEYS, GQ_Support_Limits::BODY_BYTES )
		);
	}

	/**
	 * Shared context cases, decoded with objects as objects.
	 *
	 * @return array
	 */
	public static function context_cases(): array {
		$cases = array();
		foreach ( self::fixtures( 'context', false )->cases as $fixture ) {
			$cases[ $fixture->name ] = array( $fixture );
		}
		return $cases;
	}

	/**
	 * Normalize exactly as the service does.
	 *
	 * @dataProvider context_cases
	 * @param stdClass $fixture Shared context case.
	 */
	public function test_context_schema_matches_the_service( stdClass $fixture ): void {
		$context = GQ_Support_Report_Context::parse( $fixture->context );
		self::assertSame( $fixture->canonical ?? null, null === $context ? null : GQ_Support_Report_Context::encode( $context ) );
	}

	/**
	 * Valid shared context reaches the service canonical and without its envelope; invalid context never leaves WordPress.
	 *
	 * @dataProvider context_cases
	 * @param stdClass $fixture Shared context case.
	 */
	public function test_create_forwards_only_valid_reviewed_context( stdClass $fixture ): void {
		$context = GQ_Support_Report_Context::parse( $fixture->context );
		$payload = $this->reviewed( $context ?? self::editor_context() );
		// Send the case's own JSON, not a normalized copy.
		$payload['context'] = $fixture->context;
		$response           = $this->create( $payload );
		if ( null === $context ) {
			self::assertSame( 400, $response->get_status(), $fixture->name );
			self::assertContains( $response->get_data()['code'], array( 'gq_support_invalid_request', 'rest_invalid_param' ) );
			self::assertCount( 0, $this->calls );
			return;
		}
		self::assertSame( 202, $response->get_status(), $fixture->name );
		$forwarded = $this->forwarded();
		self::assertSame( $fixture->canonical, $this->forwarded_context() );
		self::assertArrayNotHasKey( 'context_review', $forwarded );
		self::assertArrayNotHasKey( 'reconcile_only', $forwarded );
		// The Reporter's projection never carries context.
		self::assertArrayNotHasKey( 'context', $response->get_data() );
	}

	/** Removing reviewed values is the Reporter's choice: any subset travels exactly as selected. */
	public function test_any_reviewed_subset_travels_exactly(): void {
		$reviewed = self::editor_context();
		$review   = GQ_Support_Report_Context::envelope( $reviewed, self::SUBMISSION, GQ_Support_Access::subject(), time() );
		foreach ( array( array( 'wp_version' ), array( 'originating_screen' ), array() ) as $index => $kept ) {
			$selected = array(
				'schema'  => 1,
				'default' => array_intersect_key( $reviewed['default'], array_flip( $kept ) ),
			);
			self::assertSame( 202, $this->create( $this->reviewed( $selected, $review ) )->get_status() );
			self::assertSame( GQ_Support_Report_Context::encode( $selected ), $this->forwarded_context( $index ) );
		}
	}

	/**
	 * Envelopes that must not authorize the context they arrive with.
	 *
	 * @return array
	 */
	public static function forged_cases(): array {
		return array(
			'changed value'        => array( 'value' ),
			'added key'            => array( 'added' ),
			'tampered payload'     => array( 'payload' ),
			'tampered MAC'         => array( 'mac' ),
			'another submission'   => array( 'submission' ),
			'another Reporter'     => array( 'reporter' ),
			'another installation' => array( 'installation' ),
			'unsupported version'  => array( 'version' ),
			'not a string'         => array( 'type' ),
			'oversized'            => array( 'oversized' ),
			'missing'              => array( 'missing' ),
			'without context'      => array( 'alone' ),
			'trailing newline'     => array( 'newline' ),
			'extended expiry'      => array( 'unsigned-expiry' ),
		);
	}

	/**
	 * Tampering, a changed identity or an unsupported envelope cannot introduce a value, and nothing is forwarded.
	 *
	 * @dataProvider forged_cases
	 * @param string $forgery How the envelope or context differs from what was reviewed.
	 */
	public function test_forged_review_cannot_introduce_a_value( string $forgery ): void {
		$reviewed             = array(
			'schema'  => 1,
			'default' => array( 'wp_version' => get_bloginfo( 'version' ) ),
		);
		$subject              = GQ_Support_Access::subject();
		$review               = GQ_Support_Report_Context::envelope( $reviewed, self::SUBMISSION, $subject, time() );
		list( , $body, $mac ) = explode( '.', $review );
		$payload              = $this->reviewed( $reviewed, $review );
		switch ( $forgery ) {
			case 'value':
				$payload['context']['default']->wp_version = '9.9.9';
				break;
			case 'added':
				$payload['context']['default']->originating_screen = 'dashboard';
				break;
			case 'payload':
				$data                                      = json_decode( sodium_base642bin( $body, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING ), true );
				$data['context']['default']['wp_version']  = '9.9.9';
				$payload['context']['default']->wp_version = '9.9.9';
				$payload['context_review']                 = 'v1.' . sodium_bin2base64( self::json( $data ), SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING ) . '.' . $mac;
				break;
			case 'mac':
				$payload['context_review'] = 'v1.' . $body . '.' . strrev( $mac );
				break;
			case 'submission':
				$payload['context_review'] = GQ_Support_Report_Context::envelope( $reviewed, wp_generate_uuid4(), $subject, time() );
				break;
			case 'reporter':
				$payload['context_review'] = GQ_Support_Report_Context::envelope( $reviewed, self::SUBMISSION, wp_generate_uuid4(), time() );
				break;
			case 'installation':
				GQ_Support_State::update( array( 'installation_id' => wp_generate_uuid4() ) );
				break;
			case 'version':
				$payload['context_review'] = 'v2.' . $body . '.' . $mac;
				break;
			case 'type':
				$payload['context_review'] = array( $review );
				break;
			case 'oversized':
				$payload['context_review'] = 'v1.' . str_repeat( 'A', GQ_Support_Report_Context::REVIEW_BYTES ) . '.' . $mac;
				break;
			case 'missing':
				unset( $payload['context_review'] );
				break;
			case 'alone':
				unset( $payload['context'] );
				break;
			case 'newline':
				$payload['context_review'] = $review . "\n";
				break;
			case 'unsigned-expiry':
				$data                      = json_decode( sodium_base642bin( $body, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING ), true );
				$data['exp']               = time() + YEAR_IN_SECONDS;
				$payload['context_review'] = 'v1.' . sodium_bin2base64( self::json( $data ), SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING ) . '.' . $mac;
				break;
		}
		$response = $this->create( $payload );
		self::assertSame( 400, $response->get_status() );
		self::assertSame( 'gq_support_invalid_request', $response->get_data()['code'] );
		self::assertCount( 0, $this->calls );
	}

	/** An expired envelope still reconciles an accepted intent, and never authorizes a new acceptance. */
	public function test_expired_review_only_reconciles(): void {
		$context = self::editor_context();
		$expired = GQ_Support_Report_Context::envelope( $context, self::SUBMISSION, GQ_Support_Access::subject(), time() - GQ_Support_Report_Context::REVIEW_SECONDS );
		$payload = $this->reviewed( $context, $expired );
		self::assertSame( 202, $this->create( $payload )->get_status() );
		self::assertTrue( $this->forwarded()['reconcile_only'] );
		self::assertSame( GQ_Support_Report_Context::encode( $context ), $this->forwarded_context() );
		$this->upstream_status = 412;
		$this->reply           = array( 'code' => 'gq_support_context_expired' );
		$response              = $this->create( $payload );
		self::assertSame( 412, $response->get_status() );
		self::assertSame( 'gq_support_context_expired', $response->get_data()['code'] );
		self::assertFalse( $response->get_data()['data']['retryable'] );
		self::assertSame( self::SUBMISSION, $response->get_data()['data']['submission_id'] );
		// One second before expiry, the same review still authorizes acceptance.
		$fresh = GQ_Support_Report_Context::envelope( $context, self::SUBMISSION, GQ_Support_Access::subject(), time() - GQ_Support_Report_Context::REVIEW_SECONDS + 2 );
		$this->create( $this->reviewed( $context, $fresh ) );
		self::assertArrayNotHasKey( 'reconcile_only', $this->forwarded( 2 ) );
	}

	/** Retries replay the frozen intent: an upgrade between attempts never recollects or changes it. */
	public function test_retry_after_an_upgrade_sends_the_frozen_intent(): void {
		global $wp_version;
		$preview               = $this->preview( self::preview_fields() );
		$payload               = array(
			'submission_id'  => self::SUBMISSION,
			'description'    => 'Checkout does nothing',
			'context'        => $preview['context'],
			'context_review' => $preview['review'],
		);
		$this->upstream_status = 504;
		self::assertSame( 504, $this->create( $payload )->get_status() );
		$wp_version            = '99.0'; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited -- Simulate an upgrade between attempts.
		$this->upstream_status = 202;
		self::assertSame( 202, $this->create( $payload )->get_status() );
		self::assertSame( $this->calls[0][1]['body'], $this->calls[1][1]['body'] );
		self::assertSame( $this->wp_version, $this->forwarded( 1 )['context']['default']['wp_version'] );
		// A fresh preview would differ; only a new intent may carry it.
		self::assertSame( '99.0', $this->preview( self::preview_fields() )['context']['default']['wp_version'] );
	}

	/** A context-free create is forwarded exactly as before Report context existed. */
	public function test_context_free_create_is_unchanged(): void {
		$payload = array(
			'submission_id' => self::SUBMISSION,
			'summary'       => ' Checkout ',
			'description'   => 'Checkout does nothing',
		);
		self::assertSame( 202, $this->create( $payload )->get_status() );
		self::assertSame(
			array(
				'submission_id'    => self::SUBMISSION,
				'summary'          => 'Checkout',
				'description'      => 'Checkout does nothing',
				'reporter_subject' => GQ_Support_Access::subject(),
				'scope'            => 'mine',
			),
			$this->forwarded()
		);
	}

	/** The browser body cap counts context and its envelope; the forwarded body stays within it. */
	public function test_32_kib_includes_context_and_review(): void {
		$payload  = $this->reviewed( self::editor_context() );
		$compact  = strlen( self::json( $payload ) );
		$response = $this->create( $payload, GQ_Support_Limits::BODY_BYTES - $compact );
		self::assertSame( 202, $response->get_status() );
		self::assertLessThanOrEqual( GQ_Support_Limits::BODY_BYTES, strlen( $this->calls[0][1]['body'] ) );
		$response = $this->create( $payload, GQ_Support_Limits::BODY_BYTES - $compact + 1 );
		self::assertSame( 413, $response->get_status() );
		// The longest multibyte text that fits with context also fits when forwarded.
		$payload['description'] = str_repeat( '😀', 8000 );
		$fill                   = GQ_Support_Limits::BODY_BYTES - strlen( self::json( $payload ) );
		$payload['description'] = str_repeat( '😀', 8000 ) . str_repeat( 'a', $fill );
		self::assertSame( GQ_Support_Limits::BODY_BYTES, strlen( self::json( $payload ) ) );
		self::assertSame( 202, $this->create( $payload )->get_status() );
		self::assertLessThanOrEqual( GQ_Support_Limits::BODY_BYTES, strlen( $this->calls[1][1]['body'] ) );
		self::assertCount( 2, $this->calls );
	}

	/** The preview shows exact final server values and the launcher's coarse screen, with an envelope bound to them. */
	public function test_preview_returns_server_values_and_a_bound_envelope(): void {
		$preview = $this->preview( self::preview_fields() );
		self::assertSame( 'current', $preview['state'] );
		self::assertSame( self::editor_context(), $preview['context'] );
		self::assertFalse( $preview['omitted'] );
		self::assertSame( GQ_Support_Report_Context::REVIEW_SECONDS, $preview['expires_in'] );
		self::assertSame( 'valid', GQ_Support_Report_Context::verify( $preview['review'], self::editor_context(), self::SUBMISSION, GQ_Support_Access::subject(), time() ) );
		self::assertSame( 'invalid', GQ_Support_Report_Context::verify( $preview['review'], self::editor_context(), wp_generate_uuid4(), GQ_Support_Access::subject(), time() ) );
		self::assertCount( 0, $this->calls, 'A preview never contacts the service.' );
	}

	/**
	 * Screen hints a browser could send.
	 *
	 * @return array
	 */
	public static function screen_cases(): array {
		return array(
			'nonce-bearing URL'   => array( 'post.php?post=123&_wpnonce=secret&token=secret#customer' ),
			'raw screen ID'       => array( 'post' ),
			'custom screen'       => array( 'toplevel_page_acme' ),
			'oversized'           => array( str_repeat( 'post-editor', 100 ) ),
			'markup'              => array( '<b>post-editor</b>' ),
			'none'                => array( null ),
			'array'               => array( array( 'post-editor' ) ),
			'trailing whitespace' => array( "dashboard\n" ),
		);
	}

	/**
	 * Only an approved coarse screen is previewed; anything else is omitted, never echoed.
	 *
	 * @dataProvider screen_cases
	 * @param mixed $screen Browser screen hint.
	 */
	public function test_preview_omits_any_other_screen( $screen ): void {
		$fields = self::preview_fields();
		unset( $fields['screen'] );
		$preview = $this->preview( null === $screen ? $fields : $fields + array( 'screen' => $screen ) );
		self::assertSame( 'current', $preview['state'] );
		self::assertArrayNotHasKey( 'originating_screen', $preview['context']['default'] );
		self::assertSame( array( 'wp_version', 'support_plugin_version' ), array_keys( $preview['context']['default'] ) );
		self::assertStringNotContainsString( 'secret', wp_json_encode( $preview ) );
	}

	/** A value the server cannot validate is omitted and reported, never truncated. */
	public function test_preview_omits_a_malformed_server_value(): void {
		global $wp_version;
		$wp_version = '6.5<script>alert(1)</script>'; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited -- A malformed installed value.
		$preview    = $this->preview( self::preview_fields() );
		self::assertTrue( $preview['omitted'] );
		self::assertSame( array( 'support_plugin_version', 'originating_screen' ), array_keys( $preview['context']['default'] ) );
		self::assertStringNotContainsString( 'script', wp_json_encode( $preview ) );
	}

	/**
	 * Refusals that must disclose nothing.
	 *
	 * @return array
	 */
	public static function refusal_cases(): array {
		return array(
			'anonymous'              => array( 'anonymous', 'changed' ),
			'expired cookie'         => array( 'cookie', 'changed' ),
			'another session'        => array( 'session', 'changed' ),
			'missing nonce'          => array( 'nonce', 'forbidden' ),
			'nonce for another user' => array( 'foreign-nonce', 'forbidden' ),
			'grant revoked'          => array( 'grant', 'forbidden' ),
			'malformed submission'   => array( 'submission', 'invalid' ),
			'not connected'          => array( 'disconnected', 'unavailable' ),
		);
	}

	/**
	 * Authentication and authorization failures disclose nothing.
	 *
	 * @dataProvider refusal_cases
	 * @param string $scenario What is wrong with the request.
	 * @param string $state    The expected answer.
	 */
	public function test_preview_refusals_disclose_nothing( string $scenario, string $state ): void {
		$fields = self::preview_fields();
		switch ( $scenario ) {
			case 'anonymous':
				wp_set_current_user( 0 );
				break;
			case 'cookie':
				unset( $_COOKIE[ LOGGED_IN_COOKIE ] );
				break;
			case 'session':
				$fields['session'] = hash( 'sha256', 'another session' );
				break;
			case 'nonce':
				unset( $fields['nonce'] );
				break;
			case 'foreign-nonce':
				wp_set_current_user( 0 );
				$fields['nonce'] = wp_create_nonce( 'wp_rest' );
				wp_set_current_user( $this->user );
				break;
			case 'grant':
				wp_get_current_user()->remove_cap( 'gq_support_submit_requests' );
				break;
			case 'submission':
				$fields['submission_id'] = 'not-a-uuid';
				break;
			case 'disconnected':
				GQ_Support_State::update( GQ_Support_State::disconnected( 'not_connected' ) );
				break;
		}
		self::assertSame( array( 'state' => $state ), $this->preview( $fields ) );
	}

	/** A revoked grant also stops a create carrying an envelope issued while it held. */
	public function test_stale_capability_cannot_use_its_review(): void {
		$preview = $this->preview( self::preview_fields() );
		wp_get_current_user()->remove_cap( 'gq_support_submit_requests' );
		$response = $this->create(
			array(
				'submission_id'  => self::SUBMISSION,
				'description'    => 'Checkout does nothing',
				'context'        => $preview['context'],
				'context_review' => $preview['review'],
			)
		);
		self::assertSame( 403, $response->get_status() );
		self::assertCount( 0, $this->calls );
	}

	/** Another Reporter on this site cannot use a review issued to the first one. */
	public function test_review_is_isolated_to_its_reporter(): void {
		$preview = $this->preview( self::preview_fields() );
		$other   = wp_insert_user(
			array(
				'user_login' => 'context-other-' . wp_generate_uuid4(),
				'user_pass'  => wp_generate_password(),
				'role'       => 'subscriber',
			)
		);
		try {
			$this->login( $other );
			wp_get_current_user()->add_cap( 'gq_support_submit_requests' );
			$response = $this->create(
				array(
					'submission_id'  => self::SUBMISSION,
					'description'    => 'Checkout does nothing',
					'context'        => $preview['context'],
					'context_review' => $preview['review'],
				)
			);
			self::assertSame( 400, $response->get_status() );
			self::assertCount( 0, $this->calls );
		} finally {
			$this->login( $this->user );
			require_once ABSPATH . 'wp-admin/includes/user.php';
			if ( is_multisite() ) {
				wpmu_delete_user( $other );
			} else {
				wp_delete_user( $other );
			}
		}
	}
}
