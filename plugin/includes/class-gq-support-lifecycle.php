<?php
/**
 * Local, reversible WordPress lifecycle state.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Manages per-site installation identity and schema upgrades.
 */
final class GQ_Support_Lifecycle {

	/** The current local schema, independent of the display version. */
	private const SCHEMA_VERSION = 1;

	/**
	 * Activation only initializes the current site. Network sites initialize on first use.
	 *
	 * @param bool $network_wide Whether WordPress is activating for the network.
	 */
	public static function activate( bool $network_wide ): void {
		if ( ! $network_wide ) {
			self::ensure_site();
		}
	}

	/**
	 * Deactivation is intentionally reversible; no temporary state is owned yet.
	 *
	 * @param bool $network_wide Whether WordPress is deactivating for the network.
	 */
	public static function deactivate( bool $network_wide ): void {
		// No plugin-owned schedules or temporary state in the MVP.
	}

	/**
	 * Initialize or upgrade a site's local state, only in a relevant context.
	 */
	public static function ensure_site(): void {
		$version = (int) get_option( 'gq_support_schema_version', 0 );
		if ( $version >= self::SCHEMA_VERSION ) {
			return;
		}

		// Migration 1: create a distinct, opaque installation reference per site.
		add_option( 'gq_support_installation_id', wp_generate_uuid4(), '', false );
		if ( false === get_option( 'gq_support_schema_version', false ) ) {
			add_option( 'gq_support_schema_version', 1, '', false );
		} else {
			update_option( 'gq_support_schema_version', 1, false );
		}
	}
}
