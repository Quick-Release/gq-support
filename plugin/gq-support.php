<?php
/**
 * Plugin Name:       GETQUICK Support
 * Plugin URI:         https://github.com/Quick-Release/gq-support
 * Description:        Adds an in-dashboard support widget for authorized users to submit reports and view their status.
 * Version:            0.2.0
 * Requires at least:  6.5
 * Requires PHP:       8.0
 * Requires Plugins:   gq-design
 * Update URI:         https://support.getquick.io/gq-support
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

define( 'GQ_SUPPORT_VERSION', '0.2.0' );
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

// Native updates of approved releases (GQ_Support_Updater) are registered before the dependency
// check and never consult GQ_SUPPORT_DISABLED, so neither strands an installation's recovery path.
// Class-name callbacks: the class loads only when core's update check, download or auto-update runs.
add_filter( 'update_plugins_support.getquick.io', array( GQ_Support_Updater::class, 'offer' ), 10, 3 );
add_filter( 'upgrader_pre_download', array( GQ_Support_Updater::class, 'download' ), 10, 4 );
add_filter( 'auto_update_plugin', array( GQ_Support_Updater::class, 'auto_update' ), 10, 2 );
// Core's scheduled update event, after its own check: refreshes the offer and installs an approved recovery release.
add_action( 'wp_update_plugins', array( GQ_Support_Updater::class, 'maintain' ), 20 );

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
