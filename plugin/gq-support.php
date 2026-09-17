<?php
/**
 * Plugin Name:       GQ Support
 * Plugin URI:         https://github.com/Quick-Release/gq-support
 * Description:        Adds an in-dashboard chat window for logged-in editors and administrators to report bugs.
 * Version:            0.0.1
 * Requires at least:  6.0
 * Requires PHP:       8.0
 * Author:             GetQuick
 * License:            GPL-2.0-or-later
 * License URI:        https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:        gq-support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'GQ_SUPPORT_VERSION', '0.0.1' );
define( 'GQ_SUPPORT_PLUGIN_FILE', __FILE__ );
define( 'GQ_SUPPORT_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'GQ_SUPPORT_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

require_once GQ_SUPPORT_PLUGIN_DIR . 'includes/class-gq-support-plugin.php';

GQ_Support_Plugin::instance();
