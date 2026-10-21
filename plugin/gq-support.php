<?php
/**
 * Plugin Name:       GETQUICK Support
 * Plugin URI:         https://github.com/Quick-Release/gq-support
 * Description:        Adds an in-dashboard support widget for authenticated users to submit reports and view their status.
 * Version:            0.1.8
 * Requires at least:  6.5
 * Requires PHP:       8.0
 * Requires Plugins:   gq-design
 * Author:             GETQUICK
 * Author URI:         https://getquick.io
 * License:            GPL-2.0-or-later
 * License URI:        https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:        gq-support
 * Domain Path:        /languages
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'GQ_SUPPORT_VERSION', '0.1.8' );
define( 'GQ_SUPPORT_PLUGIN_FILE', __FILE__ );
define( 'GQ_SUPPORT_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'GQ_SUPPORT_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

// Classes load on first use, so a public request pays only for the code it runs (B2 in
// docs/research/idle-performance-budgets.md).
spl_autoload_register(
	static function ( string $class_name ): void {
		if ( ! str_starts_with( $class_name, 'GQ_Support_' ) ) {
			return;
		}
		$file = GQ_SUPPORT_PLUGIN_DIR . 'includes/class-' . str_replace( '_', '-', strtolower( $class_name ) ) . '.php';
		if ( is_file( $file ) ) {
			require_once $file;
		}
	}
);

register_activation_hook( __FILE__, array( GQ_Support_Lifecycle::class, 'activate' ) );
register_deactivation_hook( __FILE__, array( GQ_Support_Lifecycle::class, 'deactivate' ) );

add_action(
	'plugins_loaded',
	static function (): void {
		if ( ! defined( 'GETQUICK_DESIGN_VERSION' ) ) {
			add_action( 'admin_notices', array( GQ_Support_Plugin::class, 'missing_dependency_notice' ) );
			add_action( 'network_admin_notices', array( GQ_Support_Plugin::class, 'missing_dependency_notice' ) );
			return;
		}

		GQ_Support_Plugin::boot();
	},
	20
);
