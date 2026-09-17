<?php
/**
 * Core plugin bootstrap.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class GQ_Support_Plugin {

	private static ?GQ_Support_Plugin $instance = null;

	public static function instance(): GQ_Support_Plugin {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}

		return self::$instance;
	}

	private function __construct() {
		add_action( 'admin_enqueue_scripts', array( $this, 'maybe_enqueue_chat_widget' ) );
		add_action( 'admin_footer', array( $this, 'maybe_render_root' ) );
	}

	/**
	 * Only editors and administrators get the chat widget.
	 */
	private function current_user_can_report_bugs(): bool {
		return current_user_can( 'edit_others_posts' );
	}

	public function maybe_enqueue_chat_widget(): void {
		if ( ! is_user_logged_in() || ! $this->current_user_can_report_bugs() ) {
			return;
		}

		$script_path = GQ_SUPPORT_PLUGIN_DIR . 'assets/dist/app.js';

		if ( ! file_exists( $script_path ) ) {
			return;
		}

		wp_enqueue_script(
			'gq-support-app',
			GQ_SUPPORT_PLUGIN_URL . 'assets/dist/app.js',
			array(),
			GQ_SUPPORT_VERSION,
			true
		);

		wp_enqueue_style(
			'gq-support-app',
			GQ_SUPPORT_PLUGIN_URL . 'assets/dist/app.css',
			array(),
			GQ_SUPPORT_VERSION
		);
	}

	public function maybe_render_root(): void {
		if ( ! is_user_logged_in() || ! $this->current_user_can_report_bugs() ) {
			return;
		}

		echo '<div id="gq-support-root"></div>';
	}
}
