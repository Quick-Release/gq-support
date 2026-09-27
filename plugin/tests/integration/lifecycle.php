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

switch ( $gq_support_scenario ) {
	case 'active':
		if ( ! is_plugin_active( 'gq-support/gq-support.php' ) && ! is_plugin_active_for_network( 'gq-support/gq-support.php' ) ) {
			$gq_support_fail( 'Plugin not active.' );
		}
		if ( ! get_option( 'gq_support_installation_id' ) || 1 !== (int) get_option( 'gq_support_schema_version' ) ) {
			$gq_support_fail( 'Missing installation identity or schema marker.' );
		}
		if ( wp_next_scheduled( 'gq_support_reconcile' ) ) {
			$gq_support_fail( 'Unexpected scheduled work.' );
		}
		break;
	case 'upgrade':
		$gq_support_id = get_option( 'gq_support_installation_id' );
		update_option( 'gq_support_schema_version', 0, false );
		// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Simulate WordPress REST context.
		do_action( 'rest_api_init', rest_get_server() );
		if ( 1 !== (int) get_option( 'gq_support_schema_version' ) || get_option( 'gq_support_installation_id' ) !== $gq_support_id ) {
			$gq_support_fail( 'Upgrade failed or installation identity changed.' );
		}
		break;
	case 'uninstall':
		update_option( 'gq_support_external_record', 'unchanged', false );
		if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
			// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- WordPress uninstall guard.
			define( 'WP_UNINSTALL_PLUGIN', 'gq-support/gq-support.php' );
		}
		require dirname( __DIR__, 2 ) . '/uninstall.php';
		if ( false !== get_option( 'gq_support_installation_id' ) || false !== get_option( 'gq_support_schema_version' ) ) {
			$gq_support_fail( 'Uninstall failed to remove owned local markers.' );
		}
		if ( 'unchanged' !== get_option( 'gq_support_external_record' ) ) {
			$gq_support_fail( 'Uninstall removed unrelated data.' );
		}
		delete_option( 'gq_support_external_record' );
		break;
	case 'network':
		if ( ! is_multisite() ) {
			$gq_support_fail( 'Multisite required.' );
		}
		$gq_support_first = get_option( 'gq_support_installation_id' );
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
		if ( false !== get_option( 'gq_support_installation_id' ) ) {
			$gq_support_fail( 'New site was initialized eagerly.' );
		}
		// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Simulate WordPress REST context.
		do_action( 'rest_api_init', rest_get_server() );
		$gq_support_second = get_option( 'gq_support_installation_id' );
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
