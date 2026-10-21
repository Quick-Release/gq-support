<?php
/**
 * The installation's Ed25519 signing key (ADR 0012).
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Keeps the private key in `gq_support_signing_key`, or reads it from
 * `GQ_SUPPORT_SIGNING_KEY`. The key is read only to sign a service request;
 * it is never shown, exported or logged. Uses WordPress's sodium_compat.
 */
final class GQ_Support_Signing_Key {

	public const OPTION = 'gq_support_signing_key';

	/**
	 * Whether `wp-config.php` manages the key.
	 */
	public static function managed(): bool {
		return defined( 'GQ_SUPPORT_SIGNING_KEY' );
	}

	/**
	 * Whether the database holds a key, active or pending.
	 */
	public static function stored(): bool {
		return false !== get_option( self::OPTION );
	}

	/**
	 * The key to enroll with this Enrollment code. A retry with the same code
	 * reuses its pending key, so the service sees the same public key; any
	 * other code replaces an abandoned pending key.
	 *
	 * @param string $code A normalized Enrollment code.
	 * @return string The secret key.
	 */
	public static function pending_for( string $code ): string {
		if ( self::managed() ) {
			return self::managed_secret();
		}
		$stored    = self::read();
		$code_hash = hash( 'sha256', $code );
		if ( isset( $stored['pending'] ) && hash_equals( $stored['pending']['code_hash'], $code_hash ) ) {
			return self::decode( $stored['pending']['secret'] );
		}
		$secret            = sodium_crypto_sign_secretkey( sodium_crypto_sign_keypair() );
		$stored['pending'] = array(
			'secret'    => self::encode( $secret ),
			'code_hash' => $code_hash,
		);
		self::write( $stored );
		return $secret;
	}

	/**
	 * Make the pending key the active one, after the service accepted it.
	 * A managed key replaces any key stored before it.
	 */
	public static function promote(): void {
		if ( self::managed() ) {
			self::delete();
			return;
		}
		$stored = self::read();
		if ( ! isset( $stored['pending'] ) ) {
			return;
		}
		self::write( array( 'active' => array( 'secret' => $stored['pending']['secret'] ) ) );
	}

	/**
	 * The active secret key, or null when there is none.
	 */
	public static function active(): ?string {
		if ( self::managed() ) {
			return self::managed_secret();
		}
		$stored = self::read();
		return isset( $stored['active'] ) ? self::decode( $stored['active']['secret'] ) : null;
	}

	/**
	 * Delete every stored key. A managed key stays in `wp-config.php`.
	 */
	public static function delete(): void {
		delete_option( self::OPTION );
	}

	/**
	 * The public half of a secret key.
	 *
	 * @param string $secret A secret key.
	 */
	public static function public_key( string $secret ): string {
		return sodium_crypto_sign_publickey_from_secretkey( $secret );
	}

	/**
	 * A short, shareable fingerprint of a secret key's public half.
	 *
	 * @param string $secret A secret key.
	 */
	public static function fingerprint( string $secret ): string {
		return 'SHA256:' . implode( ':', str_split( substr( hash( 'sha256', self::public_key( $secret ) ), 0, 16 ), 4 ) );
	}

	/**
	 * Base64 for storage and transport.
	 *
	 * @param string $bytes Raw bytes.
	 */
	public static function encode( string $bytes ): string {
		return sodium_bin2base64( $bytes, SODIUM_BASE64_VARIANT_ORIGINAL );
	}

	/**
	 * The stored record.
	 *
	 * @return array{active?: array{secret: string}, pending?: array{secret: string, code_hash: string}}
	 */
	private static function read(): array {
		$stored = get_option( self::OPTION, array() );
		return is_array( $stored ) ? $stored : array();
	}

	/**
	 * Store the record, never autoloaded.
	 *
	 * @param array<string, mixed> $stored The record.
	 */
	private static function write( array $stored ): void {
		if ( ! add_option( self::OPTION, $stored, '', false ) ) {
			update_option( self::OPTION, $stored, false );
		}
	}

	/**
	 * The `GQ_SUPPORT_SIGNING_KEY` constant: a base64 64-byte Ed25519 secret key.
	 */
	private static function managed_secret(): string {
		return self::decode( (string) constant( 'GQ_SUPPORT_SIGNING_KEY' ) );
	}

	/**
	 * Decode stored base64.
	 *
	 * @param string $encoded Base64 text.
	 */
	private static function decode( string $encoded ): string {
		return sodium_base642bin( $encoded, SODIUM_BASE64_VARIANT_ORIGINAL );
	}
}
