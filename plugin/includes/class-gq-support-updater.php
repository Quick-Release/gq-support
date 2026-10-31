<?php
/**
 * Native WordPress updates of approved GETQUICK Support releases.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Installs only approved, verified package bytes through WordPress's own
 * updater (#142, docs/support-operations-design.md#private-package-access).
 *
 * The plugin's `Update URI` keeps it off WordPress.org; core asks this class
 * through `update_plugins_support.getquick.io` and downloads through
 * `upgrader_pre_download`. Only scheduled or manual maintenance (cron, WP-CLI or
 * the Updates screen's "Check again") asks the service; every other caller,
 * including ordinary admin and public pages, gets the cached offer and makes no
 * remote request. Core's scheduling cannot promise prompt completion.
 *
 * Requests are signed with a separate update key, granted to this Slot by
 * GETQUICK and kept as the network option `gq_support_update_key`. It is not the
 * report Installation key, so neither `GQ_SUPPORT_DISABLED` nor a revoked or
 * disconnected report credential stops updates; and it authorizes nothing but
 * update reads. Download access is a 15-minute grant from an authenticated
 * metadata request, sent only in a header and renewed only by asking again.
 * The package comes only from the configured HTTPS service, without redirects,
 * bounded in time and size, and is installed only if its SHA-256 matches the
 * approved release's.
 */
final class GQ_Support_Updater {

	/** The plugin header's `Update URI`: its host names the update filter registered in gq-support.php. */
	public const UPDATE_URI = 'https://support.getquick.io/gq-support';

	/** The update key: never autoloaded, shown or exported. */
	public const KEY_OPTION = 'gq_support_update_key';

	/** The last authenticated offer and its download grant. */
	public const OFFER_OPTION = 'gq_support_update_offer';

	public const METADATA_PATH = '/v1/updates/gq-support';

	public const PACKAGE_PATH = '/v1/updates/gq-support/package';

	/** Maintenance asks the service at most this often, failures included. */
	public const REFRESH_SECONDS = 3600;

	/** The approved package is ~70 KB. */
	public const PACKAGE_BYTES = 8388608;

	private const METADATA_BYTES = 16384;

	private const VERSION = '/^[0-9][A-Za-z0-9.+_-]{0,63}\z/';

	private const ISO_TIME = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\z/';

	/**
	 * Core's update check for this plugin: the cached offer, refreshed only during maintenance.
	 *
	 * @param array<string, mixed>|false $update      Another filter's update, or false.
	 * @param array<string, mixed>       $plugin_data The plugin's headers.
	 * @param string                     $plugin_file The plugin's basename.
	 * @return array<string, mixed>|false
	 */
	public static function offer( $update, $plugin_data, $plugin_file ) {
		if ( self::basename() !== $plugin_file || null === self::secret() ) {
			return $update;
		}
		if ( self::maintenance() ) {
			self::refresh( time(), false );
		}
		$offer   = self::cached();
		$version = $offer['version'] ?? null;
		$package = null === $version ? null : self::package_url( $version, (string) $offer['sha256'] );
		return array(
			'id'           => self::UPDATE_URI,
			'slug'         => 'gq-support',
			'plugin'       => $plugin_file,
			// No approved release, or none newer: core files it under no update.
			'version'      => null === $package ? (string) ( $plugin_data['Version'] ?? GQ_SUPPORT_VERSION ) : $version,
			'url'          => 'https://getquick.io',
			'package'      => (string) $package,
			'autoupdate'   => ! empty( $offer['auto_update'] ),
			'requires'     => '6.5',
			'requires_php' => '8.0',
		);
	}

	/**
	 * Whether this request may ask the service: scheduled or manual maintenance only.
	 */
	public static function maintenance(): bool {
		if ( wp_doing_cron() || ( defined( 'WP_CLI' ) && WP_CLI ) ) {
			return true;
		}
		// Core's own "Check again" on the Updates screen, which also re-checks without a nonce.
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- A read-only, throttled check, as core's force-check.
		return doing_action( 'load-update-core.php' ) && ! empty( $_GET['force-check'] ) && current_user_can( 'update_plugins' );
	}

	/**
	 * Ask the service for the approved release, unless asked within the last hour.
	 *
	 * @param int  $now   Epoch seconds.
	 * @param bool $force Ask even if asked recently: a download renewing its access.
	 * @return array<string, mixed> The offer now cached.
	 */
	public static function refresh( int $now, bool $force ): array {
		$cached = self::cached();
		$secret = self::secret();
		if ( null === $secret || ( ! $force && isset( $cached['checked_at'] ) && $now - (int) $cached['checked_at'] < self::REFRESH_SECONDS ) ) {
			return $cached;
		}
		$response = self::request( self::METADATA_PATH, '', $secret, self::METADATA_BYTES );
		$offer    = is_wp_error( $response ) ? null : self::parse( $response );
		if ( null !== $offer ) {
			$next = $offer;
		} elseif ( ! is_wp_error( $response ) && 401 === $response['status'] ) {
			// No longer authorized: forget the offer and its access.
			$next = array( 'error' => 'unauthorized' );
		} else {
			// Unreachable or unexpected: keep the last offer, but not its access, until the next check.
			$next = array_merge( array_diff_key( $cached, array_flip( array( 'grant', 'grant_expires' ) ) ), array( 'error' => 'unavailable' ) );
		}
		$next['checked_at'] = $now;
		update_site_option( self::OFFER_OPTION, $next );
		return $next;
	}

	/**
	 * Core's download of this plugin's update: only the approved package, from the
	 * configured service, verified before WordPress unpacks it.
	 *
	 * @param false|string|WP_Error $reply      Another filter's result, or false.
	 * @param mixed                 $package    The package URL from the update offer.
	 * @param WP_Upgrader|null      $upgrader   The upgrader.
	 * @param mixed                 $hook_extra Core's context; `plugin` for an update.
	 * @return false|string|WP_Error The verified local archive, an error, or false for another package.
	 */
	public static function download( $reply, $package, $upgrader = null, $hook_extra = array() ) {
		$ours      = is_array( $hook_extra ) && self::basename() === ( $hook_extra['plugin'] ?? null );
		$endpoint  = self::endpoint( self::PACKAGE_PATH );
		$addressed = null !== $endpoint && is_string( $package ) && str_starts_with( $package, $endpoint . '?' );
		if ( false !== $reply || ( ! $ours && ! $addressed ) ) {
			return $reply;
		}
		if ( ! $ours ) {
			return self::error( 'gq_support_update_refused' );
		}
		$offer = self::cached();
		// Only the exact package the last authenticated offer named, at the configured origin.
		if ( empty( $offer['version'] ) || ! is_string( $package ) || self::package_url( (string) $offer['version'], (string) $offer['sha256'] ) !== $package ) {
			return self::error( 'gq_support_update_refused' );
		}
		$version = (string) $offer['version'];
		$sha256  = (string) $offer['sha256'];
		// Expired access is renewed only by asking the service again, never from another URL:
		// a new grant for the same package, or why there is none.
		$renew  = static function () use ( $version, $sha256 ): string {
			$renewed = self::refresh( time(), true );
			if ( 'unauthorized' === ( $renewed['error'] ?? null ) ) {
				return 'gq_support_update_unauthorized';
			}
			if ( ( $renewed['version'] ?? null ) !== $version || ( $renewed['sha256'] ?? null ) !== $sha256 ) {
				return 'gq_support_update_withdrawn';
			}
			return empty( $renewed['grant'] ) ? 'gq_support_update_unavailable' : (string) $renewed['grant'];
		};
		$fetch  = static function ( string $grant ) use ( $version, $sha256 ): string {
			if ( str_starts_with( $grant, 'gq_support_update_' ) ) {
				return $grant;
			}
			$result = self::fetch( $version, $sha256, $grant );
			if ( 'gq_support_update_withdrawn' === $result ) {
				// Learn the release that replaced it, so core stops offering the withdrawn one.
				self::refresh( time(), true );
			}
			return $result;
		};
		$fresh  = ! empty( $offer['grant'] ) && (int) $offer['grant_expires'] > time() + 30;
		$result = $fetch( $fresh ? (string) $offer['grant'] : $renew() );
		if ( 'gq_support_update_grant_expired' === $result && $fresh ) {
			$result = $fetch( $renew() );
		}
		if ( 'gq_support_update_grant_expired' === $result ) {
			$result = 'gq_support_update_unauthorized';
		}
		return str_starts_with( $result, 'gq_support_update_' ) ? self::error( $result ) : $result;
	}

	/**
	 * Core's automatic-update decision for this plugin: GETQUICK's authorization,
	 * from the last authenticated offer, for a provisioned native installation.
	 *
	 * @param bool|null $update Core's or another filter's decision.
	 * @param mixed     $item   The update offer.
	 * @return bool|null
	 */
	public static function auto_update( $update, $item ) {
		if ( ! is_object( $item ) || self::basename() !== ( $item->plugin ?? null ) || null === self::secret() ) {
			return $update;
		}
		return ! empty( self::cached()['auto_update'] ) ? true : $update;
	}

	/**
	 * This installation's update key ID and public key, generating the key if
	 * there is none or `$rotate`. GETQUICK grants it to this Slot; never the secret.
	 *
	 * @param bool $rotate Replace the current key; the old one stops at the new grant.
	 * @return array{key_id: string, public_key: string}
	 */
	public static function provision( bool $rotate ): array {
		$secret = self::secret();
		if ( null === $secret || $rotate ) {
			$secret = sodium_crypto_sign_secretkey( sodium_crypto_sign_keypair() );
			update_site_option( self::KEY_OPTION, array( 'secret' => GQ_Support_Signing_Key::encode( $secret ) ) );
			delete_site_option( self::OFFER_OPTION );
		}
		return array(
			'key_id'     => self::key_id( $secret ),
			'public_key' => GQ_Support_Signing_Key::encode( GQ_Support_Signing_Key::public_key( $secret ) ),
		);
	}

	/**
	 * What WP-CLI shows: never the key or a grant.
	 *
	 * @return array{provisioned: bool, key_id: string|null, checked_at: int|null, version: string|null, error: string|null, auto_update: bool}
	 */
	public static function status(): array {
		$secret = self::secret();
		$offer  = self::cached();
		return array(
			'provisioned' => null !== $secret,
			'key_id'      => null === $secret ? null : self::key_id( $secret ),
			'checked_at'  => isset( $offer['checked_at'] ) ? (int) $offer['checked_at'] : null,
			'version'     => isset( $offer['version'] ) ? (string) $offer['version'] : null,
			'error'       => isset( $offer['error'] ) ? (string) $offer['error'] : null,
			'auto_update' => ! empty( $offer['auto_update'] ),
		);
	}

	/**
	 * The signed update headers: the `gq-support-update-v1` string pinned by
	 * contract/fixtures/update-signing.json.
	 *
	 * @param string      $path       Path and query.
	 * @param string      $grant      The download grant, or '' for metadata.
	 * @param string      $secret     The update key's 64-byte Ed25519 secret.
	 * @param int|null    $timestamp  Epoch seconds; now, except in fixtures.
	 * @param string|null $request_id A single-use ID; a fresh UUID, except in fixtures.
	 * @param string      $version    The installed version the request claims.
	 * @return array<string, string>
	 */
	public static function headers( string $path, string $grant, string $secret, ?int $timestamp = null, ?string $request_id = null, string $version = GQ_SUPPORT_VERSION ): array {
		$headers                        = array(
			'GQ-Update-Key-Id'            => self::key_id( $secret ),
			'GQ-Update-Installed-Version' => $version,
			'GQ-Update-Grant'             => $grant,
			'GQ-Update-Timestamp'         => (string) ( $timestamp ?? time() ),
			'GQ-Update-Request-Id'        => $request_id ?? wp_generate_uuid4(),
			'Content-Digest'              => GQ_Support_Signer::digest( '' ),
		);
		$canonical                      = implode(
			"\n",
			array( 'gq-support-update-v1', 'GET', $path, $headers['GQ-Update-Key-Id'], $version, $grant, $headers['GQ-Update-Timestamp'], $headers['GQ-Update-Request-Id'], $headers['Content-Digest'] )
		);
		$headers['GQ-Update-Signature'] = GQ_Support_Signing_Key::encode( sodium_crypto_sign_detached( $canonical, $secret ) );
		return $headers;
	}

	/**
	 * The key ID the service grants: the hex SHA-256 of the raw public key.
	 *
	 * @param string $secret A 64-byte Ed25519 secret key.
	 */
	public static function key_id( string $secret ): string {
		return hash( 'sha256', GQ_Support_Signing_Key::public_key( $secret ) );
	}

	/**
	 * The package URL core stores in its update offer: no credential, only the
	 * approved version and digest, at the configured service's origin.
	 *
	 * @param string $version The approved version.
	 * @param string $sha256  The approved package's SHA-256.
	 */
	public static function package_url( string $version, string $sha256 ): ?string {
		$endpoint = self::endpoint( self::PACKAGE_PATH );
		return null === $endpoint ? null : $endpoint . '?version=' . rawurlencode( $version ) . '&sha256=' . $sha256;
	}

	/**
	 * Download the package to a temporary file and verify it.
	 *
	 * @param string $version The approved version.
	 * @param string $sha256  Its SHA-256.
	 * @param string $grant   The download grant.
	 * @return string The verified file, or a `gq_support_update_*` code.
	 */
	private static function fetch( string $version, string $sha256, string $grant ): string {
		$secret = self::secret();
		if ( null === $secret ) {
			return 'gq_support_update_unauthorized';
		}
		$path = self::PACKAGE_PATH . '?version=' . rawurlencode( $version ) . '&sha256=' . $sha256;
		$file = wp_tempnam( 'gq-support.zip' );
		if ( ! $file ) {
			return 'gq_support_update_unavailable';
		}
		$response = self::request( $path, $grant, $secret, self::PACKAGE_BYTES, $file );
		$status   = is_wp_error( $response ) ? 0 : $response['status'];
		$verified = 200 === $status && $sha256 === $response['sha256']
			&& filesize( $file ) <= self::PACKAGE_BYTES && hash_equals( $sha256, (string) hash_file( 'sha256', $file ) );
		if ( $verified ) {
			return $file;
		}
		wp_delete_file( $file );
		if ( 200 === $status ) {
			return 'gq_support_update_corrupt';
		}
		$code = is_wp_error( $response ) ? '' : (string) ( json_decode( $response['body'], true )['code'] ?? '' );
		if ( 401 === $status ) {
			return 'gq_support_update_grant_expired' === $code ? $code : 'gq_support_update_unauthorized';
		}
		return 410 === $status ? 'gq_support_update_withdrawn' : 'gq_support_update_unavailable';
	}

	/**
	 * One signed GET to the configured service: HTTPS, no redirects, bounded.
	 *
	 * @param string      $path   Path and query.
	 * @param string      $grant  The download grant, or ''.
	 * @param string      $secret The update key.
	 * @param int         $limit  Response bytes.
	 * @param string|null $file   Stream the body to this file instead.
	 * @return array{status: int, body: string, sha256: string}|WP_Error
	 */
	private static function request( string $path, string $grant, string $secret, int $limit, ?string $file = null ) {
		$base = GQ_Support_Service_Client::base_url();
		if ( null === $base ) {
			return new WP_Error( 'gq_support_not_configured' );
		}
		$response = wp_safe_remote_get(
			$base . $path,
			array(
				'headers'             => array( 'Accept' => null === $file ? 'application/json' : 'application/zip' ) + self::headers( $path, $grant, $secret ),
				'timeout'             => null === $file ? 10 : 60,
				'redirection'         => 0,
				'sslverify'           => true,
				'limit_response_size' => $limit,
				'stream'              => null !== $file,
				'filename'            => $file,
			)
		);
		if ( is_wp_error( $response ) ) {
			return $response;
		}
		$status = (int) wp_remote_retrieve_response_code( $response );
		$body   = null === $file || 200 !== $status ? wp_remote_retrieve_body( $response ) : '';
		if ( null !== $file && 200 !== $status && '' === $body && is_file( $file ) ) {
			$body = (string) file_get_contents( $file, false, null, 0, self::METADATA_BYTES ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- A bounded local error body.
		}
		return array(
			'status' => $status,
			'body'   => $body,
			'sha256' => (string) wp_remote_retrieve_header( $response, 'gq-update-package-sha256' ),
		);
	}

	/**
	 * Validate an authenticated metadata response; null if it is not one.
	 *
	 * @param array{status: int, body: string, sha256: string} $response The response.
	 * @return array<string, mixed>|null
	 */
	private static function parse( array $response ): ?array {
		$data = json_decode( $response['body'], true );
		if ( 200 !== $response['status'] || strlen( $response['body'] ) >= self::METADATA_BYTES || ! is_array( $data )
			|| 'gq-support' !== ( $data['plugin'] ?? null ) || ! is_bool( $data['auto_update'] ?? null ) ) {
			return null;
		}
		$release = $data['release'] ?? null;
		$grant   = $data['grant'] ?? null;
		if ( null === $release ) {
			return null === $grant ? array( 'auto_update' => $data['auto_update'] ) : null;
		}
		if ( ! is_array( $release ) || ! is_array( $grant ) || ! is_int( $release['release_id'] ?? null )
			|| ! is_string( $release['version'] ?? null ) || ! preg_match( self::VERSION, $release['version'] )
			|| ! is_string( $release['package_sha256'] ?? null ) || ! preg_match( '/^[a-f0-9]{64}\z/', $release['package_sha256'] )
			|| ( $release['package_path'] ?? null ) !== self::PACKAGE_PATH . '?version=' . rawurlencode( $release['version'] ) . '&sha256=' . $release['package_sha256']
			|| ! is_string( $grant['token'] ?? null ) || ! preg_match( '/^[A-Za-z0-9_-]{43}\z/', $grant['token'] )
			|| ! is_string( $grant['expires_at'] ?? null ) || ! preg_match( self::ISO_TIME, $grant['expires_at'] ) ) {
			return null;
		}
		return array(
			'release_id'    => $release['release_id'],
			'version'       => $release['version'],
			'sha256'        => $release['package_sha256'],
			'grant'         => $grant['token'],
			'grant_expires' => (int) strtotime( $grant['expires_at'] ),
			'auto_update'   => $data['auto_update'],
		);
	}

	/**
	 * A failed update, as core reports it: bounded codes and messages, never a URL or credential.
	 *
	 * @param string $code A `gq_support_update_*` code.
	 */
	private static function error( string $code ): WP_Error {
		$messages = array(
			'gq_support_update_refused'      => __( 'GETQUICK Support installs only its approved update package, from the GETQUICK Support service.', 'gq-support' ),
			'gq_support_update_unauthorized' => __( 'This site is not authorized to download GETQUICK Support updates. Contact GETQUICK.', 'gq-support' ),
			'gq_support_update_withdrawn'    => __( 'This GETQUICK Support update was withdrawn. Check for updates again.', 'gq-support' ),
			'gq_support_update_corrupt'      => __( 'The GETQUICK Support update package did not match the approved release and was not installed.', 'gq-support' ),
			'gq_support_update_unavailable'  => __( 'The GETQUICK Support update could not be downloaded. Try again later.', 'gq-support' ),
		);
		return new WP_Error( $code, $messages[ $code ] ?? $messages['gq_support_update_unavailable'] );
	}

	/**
	 * The cached offer.
	 *
	 * @return array<string, mixed>
	 */
	private static function cached(): array {
		$offer = get_site_option( self::OFFER_OPTION, array() );
		return is_array( $offer ) ? $offer : array();
	}

	/**
	 * The update key's secret, or null when this installation has none.
	 */
	private static function secret(): ?string {
		$stored = get_site_option( self::KEY_OPTION );
		if ( ! is_array( $stored ) || ! is_string( $stored['secret'] ?? null ) ) {
			return null;
		}
		try {
			$secret = sodium_base642bin( $stored['secret'], SODIUM_BASE64_VARIANT_ORIGINAL );
		} catch ( SodiumException $e ) {
			return null;
		}
		return SODIUM_CRYPTO_SIGN_SECRETKEYBYTES === strlen( $secret ) ? $secret : null;
	}

	/**
	 * A service URL, or null without an HTTPS service.
	 *
	 * @param string $path Path under the service.
	 */
	private static function endpoint( string $path ): ?string {
		$base = GQ_Support_Service_Client::base_url();
		return null === $base ? null : $base . $path;
	}

	/** This plugin's basename. */
	private static function basename(): string {
		return plugin_basename( GQ_SUPPORT_PLUGIN_FILE );
	}
}
