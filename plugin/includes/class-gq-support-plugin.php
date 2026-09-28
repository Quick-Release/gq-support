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
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue_launcher' ) );
		add_action( 'admin_footer', array( __CLASS__, 'render_launcher' ) );
		add_action( 'admin_print_footer_scripts', array( __CLASS__, 'render_deferred_assets' ), 20 );

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

	/**
	 * Only site-admin Reporters on configured installations get the widget.
	 * The connection record must be issued by the future operator flow, not by a browser field.
	 */
	private static function eligible(): bool {
		// phpcs:ignore WordPress.WP.Capabilities.Unknown -- Granted on the Administrator role in schema migration 3; other grants are explicit.
		if ( ! is_admin() || is_network_admin() || is_user_admin() || wp_doing_ajax() || ! is_user_logged_in() || ! current_user_can( 'gq_support_submit_requests' ) ) {
			return false;
		}

		$screen = get_current_screen();
		if ( ! $screen || ( ! in_array( $screen->id, array( 'dashboard', 'post', 'edit-post' ), true ) && ! str_starts_with( $screen->id, 'woocommerce' ) ) ) {
			return false;
		}

		$connection = get_option( 'gq_support_connection' );
		return is_array( $connection )
			&& isset( $connection['installation_id'], $connection['status'] )
			&& 'connected' === $connection['status']
			&& get_option( 'gq_support_installation_id' ) === $connection['installation_id'];
	}

	/** Register the app without enqueueing it; only the tiny launcher is sent initially. */
	public static function enqueue_launcher(): void {
		if ( ! self::eligible() ) {
			return;
		}

		$manifest = GQ_SUPPORT_PLUGIN_DIR . 'assets/dist/index.asset.php';
		if ( ! is_file( $manifest ) ) {
			return;
		}
		$asset = require $manifest;
		wp_register_script( 'gq-support-app', GQ_SUPPORT_PLUGIN_URL . 'assets/dist/index.js', $asset['dependencies'], $asset['version'], true );
		wp_set_script_translations( 'gq-support-app', 'gq-support', GQ_SUPPORT_PLUGIN_DIR . 'languages' );
		wp_register_style( 'gq-support-app', GQ_SUPPORT_PLUGIN_URL . 'assets/dist/index.css', array(), $asset['version'] );
		wp_style_add_data( 'gq-support-app', 'rtl', 'replace' );
		wp_enqueue_style( 'gq-support-launcher', GQ_SUPPORT_PLUGIN_URL . 'assets/launcher.css', array(), GQ_SUPPORT_VERSION );
		wp_enqueue_script( 'gq-support-launcher', GQ_SUPPORT_PLUGIN_URL . 'assets/launcher.js', array(), GQ_SUPPORT_VERSION, true );
		$bootstrap = array(
			'loading' => __( 'Loading support…', 'gq-support' ),
			'error'   => __( 'Support could not load. Press to retry.', 'gq-support' ),
		);
		wp_add_inline_script( 'gq-support-launcher', 'window.gqSupportLauncher=' . wp_json_encode( $bootstrap ) . ';', 'before' );
	}

	/** Render only if the launcher was registered for this request. */
	public static function render_launcher(): void {
		if ( ! wp_script_is( 'gq-support-launcher', 'enqueued' ) ) {
			return;
		}
		?>
		<div id="gq-support-root" class="gq-support-root">
			<button type="button" class="gq-support-launcher" aria-expanded="false" aria-controls="gq-support-panel">
				<?php echo esc_html__( 'Support', 'gq-support' ); ?>
				<span class="gq-support-draft-indicator" hidden aria-label="<?php echo esc_attr__( 'Unsent draft', 'gq-support' ); ?>"></span>
			</button>
			<span class="gq-support-launcher-status gq-support-sr-only" role="status" aria-live="polite"></span>
		</div>
		<?php
	}

	/** Let core generate dependency, REST middleware, and translation tags inside an inert template. */
	public static function render_deferred_assets(): void {
		if ( ! wp_script_is( 'gq-support-launcher', 'enqueued' ) ) {
			return;
		}
		$scripts            = wp_scripts();
		$styles             = wp_styles();
		$script_concat      = $scripts->do_concat;
		$style_concat       = $styles->do_concat;
		$scripts->do_concat = false;
		$styles->do_concat  = false;
		ob_start();
		$styles->do_items( 'gq-support-app' );
		$scripts->do_items( 'gq-support-app' );
		$tags               = ob_get_clean();
		$scripts->do_concat = $script_concat;
		$styles->do_concat  = $style_concat;
		echo '<template id="gq-support-app-assets">';
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Core-generated script/style tags, including inline middleware and translations.
		echo $tags;
		echo '</template>';
	}
}
