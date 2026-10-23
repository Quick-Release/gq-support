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
	 * A migrated site reads exactly one option here.
	 */
	public static function ensure_site(): void {
		$origin = untrailingslashit( home_url( '/' ) );
		$state  = GQ_Support_State::find() ?? self::migrate( $origin );

		if ( $state['origin'] !== $origin ) {
			// A database copy at a new URL must not reuse the source installation's identity or key.
			// A deliberate domain move also requires the Operator to reconnect the site.
			$connected = 'not_connected' !== $state['connection'] || GQ_Support_Signing_Key::stored();
			GQ_Support_Signing_Key::delete();
			GQ_Support_State::update(
				array(
					'installation_id' => wp_generate_uuid4(),
					'origin'          => $origin,
				) + ( $connected ? GQ_Support_State::disconnected( 'copied_or_moved' ) : array() )
			);
		}
	}

	/**
	 * Migration 4 folds the schema 1–3 options into `gq_support_state`,
	 * running any earlier step a site has not reached on the way.
	 *
	 * @param string $origin The site's current URL.
	 * @return array<string, mixed>
	 */
	private static function migrate( string $origin ): array {
		$version = (int) get_option( 'gq_support_schema_version', 0 );
		$state   = GQ_Support_State::defaults();

		// Migration 1: a distinct, opaque installation reference per site.
		$state['installation_id'] = (string) ( $version >= 1 ? get_option( 'gq_support_installation_id', '' ) : '' );
		if ( '' === $state['installation_id'] ) {
			$state['installation_id'] = wp_generate_uuid4();
		}

		// Migration 2: bind the identity to the URL it was created at.
		$state['origin'] = (string) ( $version >= 2 ? get_option( 'gq_support_installation_origin', $origin ) : $origin );

		if ( $version >= 3 ) {
			$state['administrator_grants'] = array_values( (array) get_option( 'gq_support_administrator_grants', array() ) );
		} else {
			// Migration 3: the initial Administrator grant, once; later revocations stick.
			// Record only what this migration added so uninstall leaves independent grants alone.
			$administrator = get_role( 'administrator' );
			foreach ( array( 'gq_support_submit_requests', 'gq_support_manage_settings' ) as $capability ) {
				if ( $administrator && ! $administrator->has_cap( $capability ) ) {
					$administrator->add_cap( $capability );
					$state['administrator_grants'][] = $capability;
				}
			}
		}

		if ( add_option( GQ_Support_State::OPTION, $state, '', false ) ) {
			foreach ( array( 'gq_support_installation_id', 'gq_support_installation_origin', 'gq_support_schema_version', 'gq_support_administrator_grants', 'gq_support_connection' ) as $legacy ) {
				delete_option( $legacy );
			}
		}
		return GQ_Support_State::get();
	}
}
