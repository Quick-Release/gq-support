<?php
/**
 * Run with `wp eval-file` on a real WordPress installation.
 *
 * @package GQ_Support
 */

$gq_support_scenario = $args[0] ?? '';
$gq_support_fail     = static function ( string $message ): void {
	// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- CLI-only diagnostic.
	throw new RuntimeException( $message );
};

/**
 * Replace the migrated state with a site at an earlier schema.
 *
 * @param array<string, mixed> $legacy Legacy options to write.
 */
$gq_support_legacy_site = static function ( array $legacy ): void {
	delete_option( 'gq_support_state' );
	foreach ( $legacy as $gq_support_name => $gq_support_value ) {
		add_option( $gq_support_name, $gq_support_value, '', false );
	}
	// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Simulate WordPress REST context.
	do_action( 'rest_api_init', rest_get_server() );
};

switch ( $gq_support_scenario ) {
	case 'active':
		if ( ! is_plugin_active( 'gq-support/gq-support.php' ) && ! is_plugin_active_for_network( 'gq-support/gq-support.php' ) ) {
			$gq_support_fail( 'Plugin not active.' );
		}
		$gq_support_state = get_option( 'gq_support_state' );
		if ( ! is_array( $gq_support_state ) || empty( $gq_support_state['installation_id'] ) || GQ_Support_State::SCHEMA_VERSION !== $gq_support_state['schema_version'] ) {
			$gq_support_fail( 'Missing installation identity or schema marker.' );
		}
		if ( wp_next_scheduled( 'gq_support_reconcile' ) ) {
			$gq_support_fail( 'Unexpected scheduled work.' );
		}
		break;
	case 'upgrade':
		$gq_support_state         = GQ_Support_State::get();
		$gq_support_capabilities  = array( 'gq_support_submit_requests', 'gq_support_manage_settings' );
		$gq_support_administrator = get_role( 'administrator' );

		// Schema 1: identity only. The upgrade keeps it and binds the current URL.
		$gq_support_legacy_site(
			array(
				'gq_support_installation_id' => 'schema-1-id',
				'gq_support_schema_version'  => 1,
			)
		);
		$gq_support_upgraded = GQ_Support_State::get();
		if ( 'schema-1-id' !== $gq_support_upgraded['installation_id'] || $gq_support_state['origin'] !== $gq_support_upgraded['origin'] ) {
			$gq_support_fail( 'Schema-1 upgrade did not preserve identity and bind the URL.' );
		}

		// Schema 2 without grants: the upgrade makes the initial Administrator grant.
		array_map( array( $gq_support_administrator, 'remove_cap' ), $gq_support_capabilities );
		$gq_support_legacy_site(
			array(
				'gq_support_installation_id'     => 'schema-2-id',
				'gq_support_installation_origin' => $gq_support_state['origin'],
				'gq_support_schema_version'      => 2,
			)
		);
		$gq_support_administrator = get_role( 'administrator' );
		if ( ! $gq_support_administrator->has_cap( 'gq_support_submit_requests' )
			|| ! $gq_support_administrator->has_cap( 'gq_support_manage_settings' )
			|| GQ_Support_State::get()['administrator_grants'] !== $gq_support_capabilities ) {
			$gq_support_fail( 'Schema-2 upgrade did not make the initial Administrator grant.' );
		}

		// A migrated site never grants again, so a revocation sticks.
		$gq_support_administrator->remove_cap( 'gq_support_submit_requests' );
		// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Simulate WordPress REST context.
		do_action( 'rest_api_init', rest_get_server() );
		$gq_support_regranted = get_role( 'administrator' )->has_cap( 'gq_support_submit_requests' );
		get_role( 'administrator' )->add_cap( 'gq_support_submit_requests' );
		if ( $gq_support_regranted ) {
			$gq_support_fail( 'A current-schema request re-granted a revoked capability.' );
		}
		update_option( 'gq_support_state', $gq_support_state, false );
		break;
	case 'network':
		if ( ! is_multisite() ) {
			$gq_support_fail( 'Multisite required.' );
		}
		$gq_support_first = GQ_Support_State::get()['installation_id'];
		$gq_support_site  = wp_insert_site(
			array(
				'domain' => wp_parse_url( home_url(), PHP_URL_HOST ),
				'path'   => '/gq-support-lifecycle/',
			)
		);
		if ( is_wp_error( $gq_support_site ) ) {
			$gq_support_fail( $gq_support_site->get_error_message() );
		}
		switch_to_blog( $gq_support_site );
		if ( false !== get_option( 'gq_support_state' ) ) {
			$gq_support_fail( 'New site was initialized eagerly.' );
		}
		// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Simulate WordPress REST context.
		do_action( 'rest_api_init', rest_get_server() );
		$gq_support_second = GQ_Support_State::get()['installation_id'];
		if ( ! $gq_support_second || $gq_support_first === $gq_support_second ) {
			$gq_support_fail( 'Site identities are not distinct.' );
		}
		restore_current_blog();
		wp_delete_site( $gq_support_site );
		break;
	default:
		$gq_support_fail( 'Unknown lifecycle scenario.' );
}

WP_CLI::success( $gq_support_scenario );
