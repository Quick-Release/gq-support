<?php
/**
 * Native WordPress updates (#142): the update key's signing contract, validated
 * and cached offers, and the plugin-specific download that installs only the
 * approved bytes from the configured service, through WordPress's real filters
 * and HTTP API with only the external boundary stubbed.
 *
 * @package GQ_Support
 */

use PHPUnit\Framework\TestCase;

// phpcs:disable WordPress.NamingConventions.ValidHookName.UseUnderscores -- Core names the update filter after the Update URI's host.

/** WordPress is bootstrapped by the disposable site's WP-CLI, a maintenance context. */
final class GQ_Support_Updater_Test extends TestCase {
	private const SHA256 = '8f0c3a1d6f0d1e1f4c6f2a1b0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a392817';
	private const GRANT  = 'fixture-grant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

	/**
	 * Original update key and offer, and report signing key.
	 *
	 * @var array<string, mixed>
	 */
	private $saved = array();
	/**
	 * Stubbed service replies, in order; the last repeats. Each is status, body and response headers.
	 *
	 * @var array<int, array{0: int, 1: string, 2?: array<string, string>}>
	 */
	private $replies = array();
	/**
	 * Captured service requests: URL and arguments.
	 *
	 * @var array<int, array{0: string, 1: array}>
	 */
	private $calls = array();
	/**
	 * HTTP boundary stub.
	 *
	 * @var Closure
	 */
	private $stub;

	/** Provision a fresh update key and stub only the external HTTP boundary. */
	protected function setUp(): void {
		foreach ( array( GQ_Support_Updater::KEY_OPTION, GQ_Support_Updater::OFFER_OPTION ) as $option ) {
			$this->saved[ $option ] = get_site_option( $option );
		}
		$this->saved['signing'] = get_option( GQ_Support_Signing_Key::OPTION );
		$this->saved['state']   = GQ_Support_State::get();
		GQ_Support_Updater::provision( true );
		$this->stub = function ( $preempt, $args, $url ) {
			$this->calls[] = array( $url, $args );
			$reply         = count( $this->replies ) > 1 ? array_shift( $this->replies ) : $this->replies[0];
			// WordPress streams a download to its file; the stub writes there as Requests would.
			if ( ! empty( $args['stream'] ) ) {
				file_put_contents( $args['filename'], $reply[1] ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- Test transport.
			}
			return array(
				'response' => array( 'code' => $reply[0] ),
				'headers'  => $reply[2] ?? array(),
				'body'     => empty( $args['stream'] ) ? $reply[1] : '',
			);
		};
		add_filter( 'pre_http_request', $this->stub, 10, 3 );
	}

	/** Restore the update and report keys. */
	protected function tearDown(): void {
		remove_filter( 'pre_http_request', $this->stub );
		foreach ( array( GQ_Support_Updater::KEY_OPTION, GQ_Support_Updater::OFFER_OPTION ) as $option ) {
			if ( false === $this->saved[ $option ] ) {
				delete_site_option( $option );
			} else {
				update_site_option( $option, $this->saved[ $option ] );
			}
		}
		if ( false === $this->saved['signing'] ) {
			GQ_Support_Signing_Key::delete();
		} else {
			update_option( GQ_Support_Signing_Key::OPTION, $this->saved['signing'], false );
		}
		update_option( GQ_Support_State::OPTION, $this->saved['state'], false );
	}

	/**
	 * Shared fixtures.
	 *
	 * @param string $name Fixture file name without `.json`.
	 * @return array<string, mixed>
	 */
	private static function fixtures( string $name ): array {
		return json_decode( (string) file_get_contents( dirname( __DIR__, 3 ) . "/contract/fixtures/{$name}.json" ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Local fixture.
	}

	/**
	 * A metadata reply offering `$version` with fresh download access.
	 *
	 * @param string $version The approved version.
	 * @param string $sha256  Its package digest.
	 * @param int    $expires Grant expiry, epoch seconds.
	 * @param string $kind    `production`, or `recovery` for an earlier verified package.
	 */
	private static function offered( string $version, string $sha256, int $expires = 0, string $kind = 'production' ): array {
		return array(
			200,
			(string) wp_json_encode(
				array(
					'plugin'      => 'gq-support',
					'auto_update' => true,
					'release'     => array(
						'release_id'     => 3,
						'version'        => $version,
						'kind'           => $kind,
						'files_sha256'   => str_repeat( 'c', 64 ),
						'package_sha256' => $sha256,
						'package_path'   => GQ_Support_Updater::PACKAGE_PATH . '?version=' . $version . '&sha256=' . $sha256,
					),
					'grant'       => array(
						'token'      => self::GRANT,
						'expires_at' => gmdate( 'Y-m-d\TH:i:s\Z', $expires ? $expires : time() + 900 ),
					),
				)
			),
		);
	}

	/** Core's context for this plugin's update. */
	private static function ours(): array {
		return array(
			'plugin' => plugin_basename( GQ_SUPPORT_PLUGIN_FILE ),
			'type'   => 'plugin',
			'action' => 'update',
		);
	}

	/** The URLs called, in order. */
	private function urls(): array {
		return array_map( static fn ( $call ) => $call[0], $this->calls );
	}

	/**
	 * The update headers match the Worker's fixture, and are never the report key's.
	 *
	 * @return array<string, array{0: array}>
	 */
	public static function signing_cases(): array {
		$cases = array();
		foreach ( self::fixtures( 'update-signing' )['cases'] as $case ) {
			$cases[ $case['name'] ] = array( $case );
		}
		return $cases;
	}

	/**
	 * Produce exactly the headers and signature the Worker verifies.
	 *
	 * @dataProvider signing_cases
	 * @param array $fixture Shared signing case.
	 */
	public function test_headers_match_shared_fixture( array $fixture ): void {
		$keys    = self::fixtures( 'signing' );
		$secret  = sodium_base642bin( $keys['secret_key'], SODIUM_BASE64_VARIANT_ORIGINAL );
		$headers = GQ_Support_Updater::headers( $fixture['path'], $fixture['headers']['GQ-Update-Grant'], $secret, (int) $fixture['headers']['GQ-Update-Timestamp'], $fixture['headers']['GQ-Update-Request-Id'], $fixture['headers']['GQ-Update-Installed-Version'], $fixture['headers']['GQ-Update-Installed-Files'] ?? null );
		self::assertSame(
			$fixture['headers'] + array(
				'Content-Digest'      => $fixture['content_digest'],
				'GQ-Update-Signature' => $fixture['signature'],
			),
			$headers
		);
		self::assertSame( self::fixtures( 'update-signing' )['key_id'], GQ_Support_Updater::key_id( $secret ) );
	}

	/**
	 * Metadata bodies, valid or not.
	 *
	 * @return array<string, array{0: array}>
	 */
	public static function offer_cases(): array {
		$cases = array();
		foreach ( self::fixtures( 'update' )['offers'] as $case ) {
			$cases[ $case['name'] ] = array( $case );
		}
		return $cases;
	}

	/**
	 * Cache only a valid offer; anything else keeps no download access.
	 *
	 * @dataProvider offer_cases
	 * @param array $fixture Shared metadata case.
	 */
	public function test_only_valid_offers_are_cached( array $fixture ): void {
		$this->replies = array( array( 200, (string) wp_json_encode( $fixture['body'] ) ) );
		$offer         = GQ_Support_Updater::refresh( time(), true );
		self::assertSame( array( GQ_Support_Service_Client::base_url() . GQ_Support_Updater::METADATA_PATH ), $this->urls() );
		self::assertArrayNotHasKey( 'Authorization', $this->calls[0][1]['headers'] );
		self::assertSame( 0, $this->calls[0][1]['redirection'] );
		self::assertTrue( $this->calls[0][1]['sslverify'] );
		if ( ! $fixture['valid'] ) {
			self::assertSame( 'unavailable', $offer['error'] );
			self::assertArrayNotHasKey( 'grant', $offer );
			return;
		}
		self::assertArrayNotHasKey( 'error', $offer );
		self::assertSame( $fixture['body']['release']['version'] ?? null, $offer['version'] ?? null );
		self::assertSame( $fixture['body']['grant']['token'] ?? null, $offer['grant'] ?? null );
	}

	/** Maintenance asks at most hourly; core's update check then files the cached offer, with no credential in it. */
	public function test_core_offer_is_cached_and_credential_free(): void {
		$this->replies = array( self::offered( '99.0.0', self::SHA256 ) );
		$installed     = get_plugin_data( GQ_SUPPORT_PLUGIN_FILE, false, false );
		$update        = apply_filters( 'update_plugins_support.getquick.io', false, $installed, plugin_basename( GQ_SUPPORT_PLUGIN_FILE ), array() );
		self::assertCount( 1, $this->calls );
		self::assertSame( '99.0.0', $update['version'] );
		self::assertSame( GQ_Support_Updater::package_url( '99.0.0', self::SHA256 ), $update['package'] );
		self::assertStringNotContainsString( self::GRANT, (string) wp_json_encode( $update ) );
		self::assertTrue( $update['autoupdate'] );
		self::assertSame( GQ_Support_Updater::UPDATE_URI, $installed['UpdateURI'] );

		// Within the hour another check asks nothing; another plugin's check is not ours.
		apply_filters( 'update_plugins_support.getquick.io', false, $installed, plugin_basename( GQ_SUPPORT_PLUGIN_FILE ), array() );
		self::assertFalse( apply_filters( 'update_plugins_support.getquick.io', false, $installed, 'other/other.php', array() ) );
		self::assertCount( 1, $this->calls );
		self::assertTrue( apply_filters( 'auto_update_plugin', false, (object) array( 'plugin' => plugin_basename( GQ_SUPPORT_PLUGIN_FILE ) ) ) );
		self::assertFalse( apply_filters( 'auto_update_plugin', false, (object) array( 'plugin' => 'other/other.php' ) ) );
	}

	/** Without an update key, nothing is asked and core sees no offer. */
	public function test_unprovisioned_installation_asks_nothing(): void {
		delete_site_option( GQ_Support_Updater::KEY_OPTION );
		$installed = get_plugin_data( GQ_SUPPORT_PLUGIN_FILE, false, false );
		self::assertFalse( apply_filters( 'update_plugins_support.getquick.io', false, $installed, plugin_basename( GQ_SUPPORT_PLUGIN_FILE ), array() ) );
		self::assertFalse( apply_filters( 'auto_update_plugin', false, (object) array( 'plugin' => plugin_basename( GQ_SUPPORT_PLUGIN_FILE ) ) ) );
		self::assertSame( array(), $this->calls );
	}

	/** The verified local archive, from the approved origin, with the grant only in a header. */
	public function test_download_returns_the_verified_archive(): void {
		$bytes         = 'PK approved package bytes';
		$this->replies = array( self::offered( '99.0.0', hash( 'sha256', $bytes ) ) );
		GQ_Support_Updater::refresh( time(), true );
		$this->replies = array( array( 200, $bytes, array( 'gq-update-package-sha256' => hash( 'sha256', $bytes ) ) ) );
		$file          = apply_filters( 'upgrader_pre_download', false, GQ_Support_Updater::package_url( '99.0.0', hash( 'sha256', $bytes ) ), null, self::ours() );
		self::assertIsString( $file );
		self::assertSame( $bytes, file_get_contents( $file ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Local temp file.
		wp_delete_file( $file );
		list( $url, $args ) = $this->calls[1];
		self::assertSame( GQ_Support_Updater::package_url( '99.0.0', hash( 'sha256', $bytes ) ), $url );
		self::assertStringNotContainsString( self::GRANT, $url );
		self::assertSame( self::GRANT, $args['headers']['GQ-Update-Grant'] );
		self::assertSame( 0, $args['redirection'] );
		self::assertSame( GQ_Support_Updater::PACKAGE_BYTES, $args['limit_response_size'] );
	}

	/** A corrupt or mismatched package is refused and its temporary file removed. */
	public function test_corrupt_package_is_refused_and_removed(): void {
		$this->replies = array( self::offered( '99.0.0', self::SHA256 ) );
		GQ_Support_Updater::refresh( time(), true );
		foreach ( array( array( 'PK tampered', self::SHA256 ), array( 'PK tampered', hash( 'sha256', 'PK tampered' ) ) ) as list( $bytes, $header ) ) {
			$this->calls   = array();
			$this->replies = array( array( 200, $bytes, array( 'gq-update-package-sha256' => $header ) ) );
			$result        = apply_filters( 'upgrader_pre_download', false, GQ_Support_Updater::package_url( '99.0.0', self::SHA256 ), null, self::ours() );
			self::assertInstanceOf( WP_Error::class, $result );
			self::assertSame( 'gq_support_update_corrupt', $result->get_error_code() );
			self::assertFileDoesNotExist( $this->calls[0][1]['filename'] );
		}
	}

	/** Another origin, version or plugin is refused before any request; other plugins' packages pass through. */
	public function test_unapproved_packages_are_refused_without_a_request(): void {
		$this->replies = array( self::offered( '99.0.0', self::SHA256 ) );
		GQ_Support_Updater::refresh( time(), true );
		$this->calls = array();
		foreach ( array( 'https://attacker.example/gq-support.zip', GQ_Support_Updater::package_url( '99.0.1', self::SHA256 ), '/tmp/gq-support.zip' ) as $package ) {
			$result = apply_filters( 'upgrader_pre_download', false, $package, null, self::ours() );
			self::assertSame( 'gq_support_update_refused', $result->get_error_code() );
		}
		$addressed = apply_filters(
			'upgrader_pre_download',
			false,
			GQ_Support_Updater::package_url( '99.0.0', self::SHA256 ),
			null,
			array(
				'type'   => 'plugin',
				'action' => 'install',
			)
		);
		self::assertSame( 'gq_support_update_refused', $addressed->get_error_code() );
		self::assertFalse( apply_filters( 'upgrader_pre_download', false, 'https://downloads.wordpress.org/plugin/other.zip', null, array( 'plugin' => 'other/other.php' ) ) );
		self::assertSame( array(), $this->calls );
	}

	/** Expired download access is renewed by a signed metadata request, once, then the download retried. */
	public function test_expired_access_is_renewed_through_metadata(): void {
		$bytes         = 'PK approved package bytes';
		$sha256        = hash( 'sha256', $bytes );
		$this->replies = array( self::offered( '99.0.0', $sha256 ) );
		GQ_Support_Updater::refresh( time(), true );
		$this->calls   = array();
		$this->replies = array(
			array( 401, (string) wp_json_encode( array( 'code' => 'gq_support_update_grant_expired' ) ) ),
			self::offered( '99.0.0', $sha256 ),
			array( 200, $bytes, array( 'gq-update-package-sha256' => $sha256 ) ),
		);
		$file          = apply_filters( 'upgrader_pre_download', false, GQ_Support_Updater::package_url( '99.0.0', $sha256 ), null, self::ours() );
		self::assertIsString( $file );
		wp_delete_file( $file );
		$base = GQ_Support_Service_Client::base_url();
		self::assertSame( array( GQ_Support_Updater::package_url( '99.0.0', $sha256 ), $base . GQ_Support_Updater::METADATA_PATH, GQ_Support_Updater::package_url( '99.0.0', $sha256 ) ), $this->urls() );
		self::assertSame( '', $this->calls[1][1]['headers']['GQ-Update-Grant'] );

		// Access already known to be expired is renewed first.
		$this->replies = array( self::offered( '99.0.0', $sha256, time() - 1 ) );
		GQ_Support_Updater::refresh( time(), true );
		$this->calls   = array();
		$this->replies = array( self::offered( '99.0.0', $sha256 ), array( 200, $bytes, array( 'gq-update-package-sha256' => $sha256 ) ) );
		$file          = apply_filters( 'upgrader_pre_download', false, GQ_Support_Updater::package_url( '99.0.0', $sha256 ), null, self::ours() );
		self::assertIsString( $file );
		wp_delete_file( $file );
		self::assertSame( $base . GQ_Support_Updater::METADATA_PATH, $this->urls()[0] );
	}

	/** A withdrawn release is refused and the replacement learned; an unauthorized key forgets the offer. */
	public function test_withdrawn_and_unauthorized_downloads_fail_safely(): void {
		$this->replies = array( self::offered( '99.0.0', self::SHA256 ) );
		GQ_Support_Updater::refresh( time(), true );
		$this->replies = array( array( 410, (string) wp_json_encode( array( 'code' => 'gq_support_update_withdrawn' ) ) ), self::offered( '99.0.1', self::SHA256 ) );
		$result        = apply_filters( 'upgrader_pre_download', false, GQ_Support_Updater::package_url( '99.0.0', self::SHA256 ), null, self::ours() );
		self::assertSame( 'gq_support_update_withdrawn', $result->get_error_code() );
		self::assertSame( '99.0.1', GQ_Support_Updater::status()['version'] );

		$this->replies = array( array( 401, (string) wp_json_encode( array( 'code' => 'gq_support_update_unauthorized' ) ) ) );
		$result        = apply_filters( 'upgrader_pre_download', false, GQ_Support_Updater::package_url( '99.0.1', self::SHA256 ), null, self::ours() );
		self::assertSame( 'gq_support_update_unauthorized', $result->get_error_code() );
		GQ_Support_Updater::refresh( time(), true );
		self::assertSame(
			array(
				'provisioned' => true,
				'version'     => null,
				'error'       => 'unauthorized',
				'auto_update' => false,
			),
			array_intersect_key( GQ_Support_Updater::status(), array_flip( array( 'provisioned', 'version', 'error', 'auto_update' ) ) )
		);
		self::assertSame( 'gq_support_update_refused', apply_filters( 'upgrader_pre_download', false, GQ_Support_Updater::package_url( '99.0.1', self::SHA256 ), null, self::ours() )->get_error_code() );
	}

	/** A disconnected or revoked report credential leaves updates working. */
	public function test_updates_do_not_need_the_report_credential(): void {
		GQ_Support_Signing_Key::delete();
		GQ_Support_State::update(
			array(
				'connection' => 'disconnected',
				'key_id'     => null,
			)
		);
		$bytes         = 'PK approved package bytes';
		$this->replies = array( self::offered( '99.0.0', hash( 'sha256', $bytes ) ), array( 200, $bytes, array( 'gq-update-package-sha256' => hash( 'sha256', $bytes ) ) ) );
		self::assertSame( '99.0.0', GQ_Support_Updater::refresh( time(), true )['version'] );
		$file = apply_filters( 'upgrader_pre_download', false, GQ_Support_Updater::package_url( '99.0.0', hash( 'sha256', $bytes ) ), null, self::ours() );
		self::assertIsString( $file );
		wp_delete_file( $file );
		foreach ( $this->calls as list( , $args ) ) {
			self::assertArrayNotHasKey( 'GQ-Support-Key-Id', $args['headers'] );
		}
	}

	/**
	 * The installed files' digest is the one the service computes from the package's
	 * own entries (worker/src/central-deployment.ts filesDigest): any added, missing or
	 * changed file differs, and a directory it cannot read exactly has none.
	 */
	public function test_installed_files_digest_matches_the_package_digest(): void {
		// Not `gq-support*`: package.sh treats those temporary files as the updater's leftovers.
		$directory = get_temp_dir() . 'gqs-files-test-' . wp_generate_password( 8, false );
		wp_mkdir_p( $directory . '/includes' );
		file_put_contents( $directory . '/gq-support.php', '<?php // main' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- Test fixture.
		file_put_contents( $directory . '/includes/b.php', '<?php // b' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- Test fixture.
		$expected = hash( 'sha256', "gq-support.php\0" . hash( 'sha256', '<?php // main' ) . "\nincludes/b.php\0" . hash( 'sha256', '<?php // b' ) . "\n" );
		self::assertSame( $expected, GQ_Support_Updater::installed_files( $directory ) );
		file_put_contents( $directory . '/extra.php', '' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- Test fixture.
		self::assertNotSame( $expected, GQ_Support_Updater::installed_files( $directory ) );
		symlink( $directory . '/gq-support.php', $directory . '/linked.php' );
		self::assertNull( GQ_Support_Updater::installed_files( $directory ) );
		self::assertNull( GQ_Support_Updater::installed_files( $directory . '/missing' ) );
		foreach ( array( 'linked.php', 'extra.php', 'includes/b.php', 'gq-support.php' ) as $file ) {
			unlink( $directory . '/' . $file ); // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink -- Test cleanup.
		}
		rmdir( $directory . '/includes' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- Test cleanup.
		rmdir( $directory ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- Test cleanup.
	}

	/** A metadata check signs its installed files' digest when it can read them exactly (gq-support-update-v2). */
	public function test_metadata_signs_the_installed_files(): void {
		$this->replies = array( self::offered( '99.0.0', self::SHA256 ) );
		GQ_Support_Updater::refresh( time(), true );
		$files   = GQ_Support_Updater::installed_files();
		$headers = $this->calls[0][1]['headers'];
		self::assertSame( $files, $headers['GQ-Update-Installed-Files'] ?? null );
		if ( null !== $files ) {
			self::assertMatchesRegularExpression( '/^[a-f0-9]{64}$/', $files );
		}
	}

	/** A recovery offer is cached with its kind and verified files, like any other. */
	public function test_recovery_offer_is_cached(): void {
		$this->replies = array( self::offered( '0.0.1', self::SHA256, 0, 'recovery' ) );
		$offer         = GQ_Support_Updater::refresh( time(), true );
		self::assertSame( array( 'recovery', str_repeat( 'c', 64 ) ), array( $offer['kind'], $offer['files'] ) );
		$this->replies = array( array( 200, str_replace( '"recovery"', '"rollback"', self::offered( '0.0.1', self::SHA256, 0, 'recovery' )[1] ) ) );
		self::assertSame( 'unavailable', GQ_Support_Updater::refresh( time(), true )['error'] );
	}

	/**
	 * Core never downgrades, so only an approved recovery offer older than the installed
	 * release runs the recovery installer, and never over a symlinked development checkout.
	 */
	public function test_recovery_runs_only_for_an_older_approved_recovery_release(): void {
		$cases = array(
			array( '99.0.0', 'recovery', 'not_needed' ),
			array( '0.0.1', 'production', 'not_needed' ),
			array( GQ_SUPPORT_VERSION, 'recovery', 'not_needed' ),
		);
		// run.sh links the plugin/ checkout into the site; an installed package's recovery is package.sh native's.
		if ( is_link( WP_PLUGIN_DIR . '/' . dirname( plugin_basename( GQ_SUPPORT_PLUGIN_FILE ) ) ) ) {
			$cases[] = array( '0.0.1', 'recovery', 'symlinked_plugin' );
		}
		foreach ( $cases as list( $version, $kind, $outcome ) ) {
			$this->calls   = array();
			$this->replies = array( self::offered( $version, self::SHA256, 0, $kind ) );
			GQ_Support_Updater::refresh( time(), true );
			self::assertSame( $outcome, GQ_Support_Updater::recover( time() ), "{$kind} {$version}" );
			// Nothing was downloaded for it.
			self::assertCount( 1, $this->calls );
		}
		delete_site_option( GQ_Support_Updater::RECOVERY_OPTION );
		delete_site_option( GQ_Support_Updater::KEY_OPTION );
		self::assertSame( 'not_provisioned', GQ_Support_Updater::recover( time() ) );
	}
}
