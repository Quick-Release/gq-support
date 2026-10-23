<?php
/**
 * The site's one non-autoloaded state option.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Reads and writes `gq_support_state`. It never holds key material.
 *
 * @phpstan-type State array{
 *     schema_version: int,
 *     installation_id: string,
 *     origin: string,
 *     connection: 'not_connected'|'connected'|'copied_or_moved'|'rejected',
 *     key_id: string|null,
 *     fingerprint: string|null,
 *     environment: string|null,
 *     connected_at: string|null,
 *     last_test: array{result: string, at: int}|null,
 *     administrator_grants: array<int, string>
 * }
 */
final class GQ_Support_State {

	public const OPTION = 'gq_support_state';

	public const SCHEMA_VERSION = 4;

	/**
	 * The stored state, or null before migration 4 has run on this site.
	 *
	 * @return State|null
	 */
	public static function find(): ?array {
		$state = get_option( self::OPTION, null );
		return is_array( $state ) ? $state + self::defaults() : null;
	}

	/**
	 * The stored state. Callers run after `GQ_Support_Lifecycle::ensure_site()`.
	 *
	 * @return State
	 */
	public static function get(): array {
		return self::find() ?? self::defaults();
	}

	/**
	 * Merge fields into the stored state.
	 *
	 * @param array<string, mixed> $fields Fields to replace.
	 * @return State
	 */
	public static function update( array $fields ): array {
		/**
		 * The merged state.
		 *
		 * @var State $state
		 */
		$state = array_merge( self::get(), $fields );
		update_option( self::OPTION, $state, false );
		return $state;
	}

	/**
	 * Whether the site holds an enrolled credential: connected, or rejected and awaiting re-enrollment.
	 *
	 * @param array{connection: string} $state A state.
	 */
	public static function holds_credential( array $state ): bool {
		return in_array( $state['connection'], array( 'connected', 'rejected' ), true );
	}

	/**
	 * The key ID to sign with, or '' when there is none. `GQ_SUPPORT_KEY_ID`
	 * must name the key the service enrolled; on a mismatch nothing is signed.
	 *
	 * @param array{key_id: string|null} $state A state.
	 */
	public static function key_id( array $state ): string {
		return self::key_id_mismatch( $state ) ? '' : (string) $state['key_id'];
	}

	/**
	 * Whether `GQ_SUPPORT_KEY_ID` names a key other than the enrolled one.
	 *
	 * @param array{key_id: string|null} $state A state.
	 */
	public static function key_id_mismatch( array $state ): bool {
		return defined( 'GQ_SUPPORT_KEY_ID' ) && ! hash_equals( (string) $state['key_id'], (string) constant( 'GQ_SUPPORT_KEY_ID' ) );
	}

	/**
	 * Fields that describe a connection, reset whenever it ends.
	 *
	 * @param string $connection The new connection state.
	 * @return array<string, mixed>
	 */
	public static function disconnected( string $connection ): array {
		return array(
			'connection'   => $connection,
			'key_id'       => null,
			'fingerprint'  => null,
			'environment'  => null,
			'connected_at' => null,
			'last_test'    => null,
		);
	}

	/**
	 * A state with no identity yet.
	 *
	 * @return State
	 */
	public static function defaults(): array {
		return array(
			'schema_version'       => self::SCHEMA_VERSION,
			'installation_id'      => '',
			'origin'               => '',
			'connection'           => 'not_connected',
			'key_id'               => null,
			'fingerprint'          => null,
			'environment'          => null,
			'connected_at'         => null,
			'last_test'            => null,
			'administrator_grants' => array(),
		);
	}
}
