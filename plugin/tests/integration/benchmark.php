<?php
/**
 * Disposable DDEV instrumentation: equal overhead with plugin active or inactive.
 *
 * @package GQ_Support
 */

$gq_support_start = $_SERVER['REQUEST_TIME_FLOAT'];
$gq_support_http  = 0;
add_action(
	'http_api_debug',
	static function () use ( &$gq_support_http ): void {
		++$gq_support_http;
	}
);
add_action(
	'shutdown',
	static function () use ( &$gq_support_http, $gq_support_start ): void {
		global $wpdb;
		if ( ! isset( $_GET['gq_probe'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Local measurement only.
			return;
		}
		$record = array(
			'wall_ms'    => round( ( microtime( true ) - $gq_support_start ) * 1000, 3 ),
			'memory'     => memory_get_peak_usage( true ),
			'queries'    => $wpdb->num_queries,
			'query_ms'   => array_sum( array_column( $wpdb->queries ?? array(), 1 ) ) * 1000,
			'http_calls' => $gq_support_http,
		);
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- Disposable local measurement.
		file_put_contents( '/tmp/gq-lifecycle-probe.jsonl', wp_json_encode( $record ) . "\n", FILE_APPEND | LOCK_EX );
	}
);
