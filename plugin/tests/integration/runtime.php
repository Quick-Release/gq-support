<?php
/**
 * Prints the disposable site's actual runtime as JSON, so each CI matrix cell proves the PHP,
 * WordPress, database, topology and WordPress-provided React it ran (scripts/ci/runtime-matrix.mjs verify).
 * Also resolves the built app's extracted script dependencies against this WordPress's registered handles.
 *
 * @package GQ_Support
 */

global $wpdb, $wp_version;

$gq_support_scripts  = wp_scripts();
$gq_support_manifest = GQ_SUPPORT_PLUGIN_DIR . 'assets/dist/index.asset.php';
$gq_support_assets   = null;
if ( is_readable( $gq_support_manifest ) ) {
	$gq_support_dependencies = ( require $gq_support_manifest )['dependencies'];
	$gq_support_unresolved   = array();
	$gq_support_queue        = $gq_support_dependencies;
	$gq_support_seen         = array();
	// Walk the whole graph: a registered handle with an unregistered dependency still fails to print.
	while ( $gq_support_queue ) {
		$gq_support_handle = array_shift( $gq_support_queue );
		if ( isset( $gq_support_seen[ $gq_support_handle ] ) ) {
			continue;
		}
		$gq_support_seen[ $gq_support_handle ] = true;
		if ( ! isset( $gq_support_scripts->registered[ $gq_support_handle ] ) ) {
			$gq_support_unresolved[] = $gq_support_handle;
			continue;
		}
		array_push( $gq_support_queue, ...$gq_support_scripts->registered[ $gq_support_handle ]->deps );
	}
	$gq_support_assets = array(
		'dependencies' => $gq_support_dependencies,
		'unresolved'   => $gq_support_unresolved,
		'forbidden'    => array_values( array_intersect( $gq_support_dependencies, array( 'react-jsx-runtime' ) ) ),
	);
}

if ( ! function_exists( 'get_plugins' ) ) {
	require_once ABSPATH . 'wp-admin/includes/plugin.php';
}
$gq_support_woocommerce = get_plugins()['woocommerce/woocommerce.php']['Version'] ?? null;

WP_CLI::line(
	(string) wp_json_encode(
		array(
			'php'              => PHP_VERSION,
			'wordpress'        => $wp_version,
			'database'         => array(
				'server'  => $wpdb->db_server_info(),
				'version' => $wpdb->db_version(),
			),
			'multisite'        => is_multisite(),
			'subdomainInstall' => is_multisite() && is_subdomain_install(),
			'objectCache'      => (bool) wp_using_ext_object_cache(),
			'react'            => $gq_support_scripts->registered['react']->ver ?? null,
			'woocommerce'      => $gq_support_woocommerce,
			'plugin'           => GQ_SUPPORT_PLUGIN_DIR,
			'assets'           => $gq_support_assets,
		)
	)
);
