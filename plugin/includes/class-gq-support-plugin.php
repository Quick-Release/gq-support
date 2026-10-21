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
	 * Approved site-admin screens, each with its coarse Report context screen.
	 * WooCommerce screens match by the `woocommerce` prefix.
	 */
	private const SCREENS = array(
		'dashboard' => 'dashboard',
		'edit-post' => 'post-list',
		'post'      => 'post-editor',
	);

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
		add_action( 'init', array( __CLASS__, 'load_textdomain' ) );
		add_action( 'admin_init', array( __CLASS__, 'maybe_initialize_admin' ) );
		add_action( 'rest_api_init', array( __CLASS__, 'register_rest' ) );
		add_action( 'wp_ajax_gq_support_session', array( __CLASS__, 'check_session' ) );
		add_action( 'wp_ajax_nopriv_gq_support_session', array( __CLASS__, 'check_session' ) );
		add_action( 'wp_ajax_gq_support_context', array( GQ_Support_Report_Context::class, 'preview' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue_launcher' ) );
		add_action( 'admin_footer', array( __CLASS__, 'render_launcher' ) );
		add_action( 'admin_notices', array( __CLASS__, 'render_disabled_notice' ) );
		add_action( 'admin_print_footer_scripts', array( __CLASS__, 'render_deferred_assets' ), 20 );
		self::register_privacy();

		if ( is_admin() ) {
			GQ_Support_Setup_Page::register();
		}

		if ( defined( 'WP_CLI' ) && WP_CLI ) {
			GQ_Support_Lifecycle::ensure_site();
			WP_CLI::add_command( 'gq-support', GQ_Support_CLI::class );
		}
	}

	/**
	 * Privacy tools, user deletion and the privacy guide fire rarely: the autoloader
	 * loads their class only when one of these hooks does.
	 */
	private static function register_privacy(): void {
		add_filter( 'wp_privacy_personal_data_exporters', array( GQ_Support_Privacy::class, 'register_exporter' ) );
		add_filter( 'wp_privacy_personal_data_erasers', array( GQ_Support_Privacy::class, 'register_eraser' ) );
		add_action( 'admin_init', array( GQ_Support_Privacy::class, 'add_policy_content' ) );
		add_action( 'delete_user', array( GQ_Support_Privacy::class, 'erase_deleted_user' ) );
		add_action( 'wpmu_delete_user', array( GQ_Support_Privacy::class, 'erase_deleted_network_user' ) );
		add_action( 'gq_support_retry_erasure', array( GQ_Support_Privacy::class, 'retry_erasure' ), 10, 2 );
	}

	/** Load support controllers only when WordPress initializes REST. */
	public static function register_rest(): void {
		GQ_Support_Lifecycle::ensure_site();
		GQ_Support_REST::register();
	}

	/**
	 * Refresh a nonce only for the exact session that opened this tab.
	 * This read-only AJAX operation also works when a REST nonce has expired.
	 */
	public static function check_session(): void {
		nocache_headers();
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- The session binding authorizes only a same-session nonce refresh; no mutation.
		$expected = isset( $_GET['session'] ) && is_string( $_GET['session'] ) ? sanitize_text_field( wp_unslash( $_GET['session'] ) ) : '';
		if ( ! GQ_Support_Access::current_session( $expected ) ) {
			wp_send_json( array( 'state' => 'changed' ) );
		}
		if ( ! GQ_Support_Access::can( 'gq_support_submit_requests' ) ) {
			wp_send_json( array( 'state' => 'forbidden' ) );
		}
		// Re-evaluated on every check, so a revoked Support manager grant drops the installation scope.
		wp_send_json(
			array(
				'state' => 'current',
				'nonce' => wp_create_nonce( 'wp_rest' ),
				'site'  => GQ_Support_Access::can( 'gq_support_view_site_requests' ),
			)
		);
	}

	/**
	 * The launcher's own strings are printed by PHP; the app loads its JSON translations separately.
	 * Releases ship outside WordPress.org, so core's just-in-time loading never finds the bundled `.mo`.
	 */
	public static function load_textdomain(): void {
		load_plugin_textdomain( 'gq-support', false, dirname( plugin_basename( GQ_SUPPORT_PLUGIN_FILE ) ) . '/languages' );
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
	 * Only site-admin Reporters on connected installations get the widget.
	 * Only an Enrollment exchange with the service connects a site.
	 */
	private static function eligible(): bool {
		if ( ! is_admin() || is_network_admin() || is_user_admin() || wp_doing_ajax() || ! is_user_logged_in() || ! GQ_Support_Access::can( 'gq_support_submit_requests' ) ) {
			return false;
		}

		if ( null === self::originating_screen() ) {
			return false;
		}

		return 'connected' === GQ_Support_State::get()['connection'];
	}

	/**
	 * The coarse screen this admin page reports as Report context, from the
	 * already-built admin screen and never the request URL; null when the page
	 * is not an approved one.
	 */
	private static function originating_screen(): ?string {
		$id = (string) get_current_screen()?->id;
		return self::SCREENS[ $id ] ?? ( str_starts_with( $id, 'woocommerce' ) ? 'woocommerce' : null );
	}

	/** Register the app without enqueueing it; only the tiny launcher is sent initially. */
	public static function enqueue_launcher(): void {
		if ( GQ_Support_Fail_Safe::disabled() || ! self::eligible() ) {
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
			'session'  => GQ_Support_Access::session(),
			'ajaxUrl'  => admin_url( 'admin-ajax.php' ),
			'timezone' => wp_timezone_string(),
			'loading'  => __( 'Loading support…', 'gq-support' ),
			'error'    => __( 'Support could not load. Press to retry.', 'gq-support' ),
			'help'     => GQ_Support_Fail_Safe::help(),
			// Kept only in launcher memory until the Reporter opens the panel.
			'screen'   => self::originating_screen(),
		);
		wp_add_inline_script( 'gq-support-launcher', 'window.gqSupportLauncher=' . wp_json_encode( $bootstrap ) . ';', 'before' );
	}

	/**
	 * While `GQ_SUPPORT_DISABLED` is set, a Reporter who would have the launcher
	 * sees why it is missing and the independent contact, from server-rendered core markup only.
	 */
	public static function render_disabled_notice(): void {
		if ( ! GQ_Support_Fail_Safe::disabled() || ! self::eligible() ) {
			return;
		}
		$help = GQ_Support_Fail_Safe::help();
		echo '<div class="notice notice-info gq-support-disabled"><p>';
		echo esc_html__( 'Support is temporarily disabled on this site.', 'gq-support' );
		if ( null !== $help ) {
			echo ' ';
			GQ_Support_Fail_Safe::render_contact( $help );
		}
		echo '</p></div>';
	}

	/** Later hooks render only when `enqueue_launcher()` accepted this request. */
	private static function launcher_enqueued(): bool {
		return wp_script_is( 'gq-support-launcher', 'enqueued' );
	}

	/** Render only if the launcher was registered for this request. */
	public static function render_launcher(): void {
		if ( ! self::launcher_enqueued() ) {
			return;
		}
		?>
		<div id="gq-support-root" class="gq-support-root">
			<button type="button" class="gq-support-launcher" aria-expanded="false">
				<?php echo esc_html__( 'Support', 'gq-support' ); ?>
				<span class="gq-support-draft-indicator" hidden><span class="gq-support-sr-only"><?php echo esc_html__( 'Unsent draft', 'gq-support' ); ?></span></span>
			</button>
			<div class="gq-support-launcher-notice">
				<span class="gq-support-launcher-status gq-support-sr-only" role="status" aria-live="polite"></span>
				<?php $help = GQ_Support_Fail_Safe::help(); ?>
				<?php if ( null !== $help ) : ?>
					<?php // Server-rendered, so it works when the app assets do not. ?>
					<p class="gq-support-launcher-help" hidden><?php GQ_Support_Fail_Safe::render_contact( $help ); ?></p>
				<?php endif; ?>
			</div>
		</div>
		<?php
	}

	/** Let core generate dependency, REST middleware, and translation tags inside an inert template. */
	public static function render_deferred_assets(): void {
		if ( ! self::launcher_enqueued() ) {
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
