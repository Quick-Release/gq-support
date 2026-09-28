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

	/**
	 * Activation only initializes the current site. Network sites initialize on first use.
	 *
	 * @param bool $network_wide Whether WordPress is activating for the network.
	 */
	public static function activate( bool $network_wide ): void {
		if ( ! $network_wide && defined( 'GETQUICK_DESIGN_VERSION' ) ) {
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
		if ( $version < 1 ) {
			// Migration 1: create a distinct, opaque installation reference per site.
			add_option( 'gq_support_installation_id', wp_generate_uuid4(), '', false );
			if ( false === get_option( 'gq_support_schema_version', false ) ) {
				add_option( 'gq_support_schema_version', 1, '', false );
			} else {
				update_option( 'gq_support_schema_version', 1, false );
			}
		}

		$origin = untrailingslashit( home_url( '/' ) );
		if ( $version < 2 ) {
			// Migration 2: bind the existing identity to this site's current URL.
			add_option( 'gq_support_installation_origin', $origin, '', false );
			update_option( 'gq_support_schema_version', 2, false );
		}

		if ( $version < 3 ) {
			// Migration 3: the initial Administrator grant, once; later revocations stick.
			// Record only what this migration added so uninstall leaves independent grants alone.
			$administrator = get_role( 'administrator' );
			$granted       = array();
			foreach ( array( 'gq_support_submit_requests', 'gq_support_manage_settings' ) as $capability ) {
				if ( $administrator && ! $administrator->has_cap( $capability ) ) {
					$administrator->add_cap( $capability );
					$granted[] = $capability;
				}
			}
			if ( $granted ) {
				add_option( 'gq_support_administrator_grants', $granted, '', false );
			}
			update_option( 'gq_support_schema_version', 3, false );
		}

		if ( get_option( 'gq_support_installation_origin' ) !== $origin ) {
			// A database copy at a new URL must not reuse the source installation's identity.
			// A deliberate domain move also requires the operator to reconnect the site.
			if ( update_option( 'gq_support_installation_id', wp_generate_uuid4(), false ) ) {
				update_option( 'gq_support_installation_origin', $origin, false );
			}
		}
	}
}
