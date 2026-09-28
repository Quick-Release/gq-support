<?php
/**
 * Disposable probe: per-request plugin A/B (?gq_off=1 removes gq-support from active_plugins)
 * and plugin-attributed SQL / HTTP / wall-time / memory recording.
 */
if ( ! isset( $_GET['gq_probe'] ) ) {
	return;
}
if ( isset( $_GET['gq_off'] ) ) {
	add_filter( 'option_active_plugins', static fn( $p ) => array_values( array_diff( (array) $p, array( 'gq-support/gq-support.php' ) ) ) );
}
$GLOBALS['gq_probe'] = array( 'q' => 0, 'gq_q' => array(), 'http' => 0 );
add_filter( 'query', static function ( $sql ) {
	++$GLOBALS['gq_probe']['q'];
	if ( str_contains( $sql, 'gq_support' ) ) {
		$GLOBALS['gq_probe']['gq_q'][] = preg_replace( '/\s+/', ' ', $sql );
	}
	return $sql;
} );
add_action( 'http_api_debug', static function () { ++$GLOBALS['gq_probe']['http']; } );
add_action( 'shutdown', static function () {
	$row = array(
		'wp'       => $GLOBALS['wp_version'],
		'php'      => PHP_VERSION,
		'off'      => isset( $_GET['gq_off'] ),
		'uri'      => strtok( $_SERVER['REQUEST_URI'], '?' ),
		'wall_ms'  => round( ( microtime( true ) - $_SERVER['REQUEST_TIME_FLOAT'] ) * 1000, 3 ),
		'mem'      => memory_get_peak_usage(),
		'queries'  => $GLOBALS['gq_probe']['q'],
		'gq_q'     => $GLOBALS['gq_probe']['gq_q'],
		'http'     => $GLOBALS['gq_probe']['http'],
		'enqueued' => function_exists( 'wp_script_is' ) && wp_script_is( 'gq-support-launcher', 'enqueued' ),
	);
	file_put_contents( WP_CONTENT_DIR . '/mu-plugins/probe.jsonl', json_encode( $row ) . "\n", FILE_APPEND | LOCK_EX );
} );
