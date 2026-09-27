<?php
/**
 * Context gates for the WordPress plugin.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Registers only work that has a current consumer.
 */
final class GQ_Support_Plugin {

	/**
	 * Explain why an already-active plugin cannot initialize without its dependency.
	 */
	public static function missing_dependency_notice(): void {
		if ( ! current_user_can( 'activate_plugins' ) ) {
			return;
		}

		echo '<div class="notice notice-error"><p>';
		echo esc_html__( 'GETQUICK Support requires the active GETQUICK Design plugin.', 'gq-support' );
		echo '</p></div>';
	}

	/**
	 * Register lifecycle initialization in relevant WordPress contexts.
	 */
	public static function boot(): void {
		add_action( 'admin_init', array( __CLASS__, 'maybe_initialize_admin' ) );
		add_action( 'rest_api_init', array( GQ_Support_Lifecycle::class, 'ensure_site' ) );

		if ( defined( 'WP_CLI' ) && WP_CLI ) {
			GQ_Support_Lifecycle::ensure_site();
		}
	}

	/**
	 * AJAX, admin-post, and network admin are not site-admin screens.
	 */
	public static function maybe_initialize_admin(): void {
		global $pagenow;

		if ( is_network_admin() || wp_doing_ajax() || 'admin-post.php' === $pagenow ) {
			return;
		}

		GQ_Support_Lifecycle::ensure_site();
	}
}
