<?php
/**
 * Counter probe and fake Worker for the performance gate (plugin/tests/browser/performance.spec.ts).
 * The spec installs it as an mu-plugin on the disposable test site and removes it afterwards.
 *
 * - Every request: `GQ_SUPPORT_SERVICE_URL` points at a fake Worker that answers 503, so no
 *   plugin request can leave the machine.
 * - `?gq_probe=1`: the response carries an `X-GQ-Probe` header with the plugin's SQL, HTTP and
 *   cron counts for that request. Plugin SQL is attributed by the `gq_support` name in the query.
 *   It also carries a `Server-Timing` header with the request's PHP wall time and peak memory.
 * - `?gq_off=1`: the plugin is inactive for this request only, for on/off comparisons.
 * - `?gq_variant=base`: load `plugins/gq-support-base/` (a PR's base tree) instead, for base/head comparisons.
 * - A `gq_worker` cookie takes the fake Worker down for every request that carries it: `down` refuses
 *   at once, `hang` times out after the caller's timeout, and `stall` (the outage negative control)
 *   overruns that timeout by 2 s.
 * - `?gq_violate=<kind>`: inject one budget violation, as the probe's negative control.
 *
 * @package GQ_Support
 */

// phpcs:disable WordPress.Security.NonceVerification.Recommended -- Test-only query flags.

if ( ! defined( 'GQ_SUPPORT_SERVICE_URL' ) ) {
	define( 'GQ_SUPPORT_SERVICE_URL', 'https://fake-worker.gq-support.test' );
}

$gq_support_probe = array(
	'sql'  => 0,
	'http' => 0,
);

add_filter(
	'pre_http_request',
	static function ( $pre, array $args, string $url ) use ( &$gq_support_probe ) {
		// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_debug_backtrace -- Attributes the call to its caller.
		$caller = implode( "\n", array_column( debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS ), 'file' ) );
		$worker = str_starts_with( $url, GQ_SUPPORT_SERVICE_URL );
		if ( $worker || str_contains( $caller, '/plugins/gq-support/' ) ) {
			++$gq_support_probe['http'];
		}
		if ( false !== $pre || ! $worker ) {
			return $pre;
		}
		$outage = isset( $_COOKIE['gq_worker'] ) ? sanitize_key( wp_unslash( $_COOKIE['gq_worker'] ) ) : '';
		if ( 'down' === $outage ) {
			return new WP_Error( 'http_request_failed', 'cURL error 7: Connection refused' );
		}
		if ( 'hang' === $outage || 'stall' === $outage ) {
			// Capped, so a missing or huge timeout still ends the request.
			$timeout = min( (float) ( $args['timeout'] ?? 5 ), 15 );
			$overrun = 'stall' === $outage ? 2 : 0;
			usleep( (int) ( ( $timeout + $overrun ) * 1000000 ) );
			return new WP_Error( 'http_request_failed', 'cURL error 28: Operation timed out' );
		}
		return array(
			'headers'  => array(),
			'body'     => '{"code":"gq_support_fake_worker"}',
			'response' => array(
				'code'    => 503,
				'message' => 'Fake Worker',
			),
			'cookies'  => array(),
			'filename' => null,
		);
	},
	PHP_INT_MIN,
	3
);

if ( isset( $_GET['gq_off'] ) ) {
	$gq_support_without = static fn( $plugins ) => array_diff_key( (array) $plugins, array( 'gq-support/gq-support.php' => true ) );
	add_filter( 'option_active_plugins', static fn( $plugins ) => array_values( array_diff( (array) $plugins, array( 'gq-support/gq-support.php' ) ) ) );
	add_filter( 'site_option_active_sitewide_plugins', $gq_support_without );
} elseif ( isset( $_GET['gq_variant'] ) && 'base' === $_GET['gq_variant'] ) {
	$gq_support_rename = static fn( string $plugin ): string => 'gq-support/gq-support.php' === $plugin ? 'gq-support-base/gq-support.php' : $plugin;
	add_filter( 'option_active_plugins', static fn( $plugins ) => array_map( $gq_support_rename, (array) $plugins ) );
	add_filter( 'site_option_active_sitewide_plugins', static fn( $plugins ) => array_combine( array_map( $gq_support_rename, array_keys( (array) $plugins ) ), (array) $plugins ) );
}

$gq_support_violation = isset( $_GET['gq_violate'] ) ? sanitize_key( wp_unslash( $_GET['gq_violate'] ) ) : '';
$gq_support_plugin    = static fn( string $file ): string => plugins_url( "gq-support/{$file}" );

switch ( $gq_support_violation ) {
	case 'sql':
		// One query more than the largest plugin SQL budget (B6: 4), so it breaks every SQL budget from any baseline.
		add_action(
			'init',
			static function (): void {
				global $wpdb;
				for ( $repeat = 0; $repeat < 5; $repeat++ ) {
					$wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", 'gq_support_probe' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
				}
			}
		);
		break;
	case 'memory':
		// Held from init to shutdown, and more than the largest memory budget (B6: 64 KB).
		add_action(
			'init',
			static function (): void {
				$GLOBALS['gq_support_probe_ballast'] = str_repeat( 'x', 96 * KB_IN_BYTES );
			}
		);
		break;
	case 'http':
		// A short timeout, so the call costs 1 s with the Worker hung.
		add_action( 'init', static fn() => wp_remote_get( GQ_SUPPORT_SERVICE_URL . '/v1/installation', array( 'timeout' => 1 ) ) );
		break;
	case 'cron':
		add_action( 'init', static fn() => wp_schedule_single_event( time() + HOUR_IN_SECONDS, 'gq_support_probe' ) );
		break;
	case 'bytes':
		$gq_support_stylesheet = static function () use ( $gq_support_plugin ): void {
			// phpcs:ignore WordPress.WP.EnqueuedResources.NonEnqueuedStylesheet -- The violation is the point.
			printf( '<link rel="stylesheet" href="%s" />', esc_url( $gq_support_plugin( 'assets/launcher.css' ) ) );
		};
		add_action( 'wp_head', $gq_support_stylesheet );
		add_action( 'admin_head', $gq_support_stylesheet );
		break;
	case 'request':
		add_action(
			'admin_enqueue_scripts',
			static function () use ( $gq_support_plugin ): void {
				if ( wp_script_is( 'gq-support-launcher', 'enqueued' ) ) {
					wp_enqueue_style( 'gq-support-probe', $gq_support_plugin( 'assets/dist/index.css' ), array(), (string) time() );
				}
			},
			20
		);
		break;
	case 'rest':
		// A REST call on every launcher click: the first open and each reopen.
		add_action(
			'admin_enqueue_scripts',
			static fn() => wp_add_inline_script(
				'gq-support-launcher',
				sprintf( 'document.addEventListener("click", function (event) { if (event.target.closest(".gq-support-launcher")) fetch(%s); }, true);', wp_json_encode( rest_url( 'gq-support/v1/requests' ) ) )
			),
			20
		);
		break;
	case 'list':
		// A second list call whenever My requests is shown.
		add_action(
			'admin_enqueue_scripts',
			static fn() => wp_add_inline_script(
				'gq-support-launcher',
				sprintf( 'document.addEventListener("click", function (event) { if (event.target.closest("#gq-support-requests-tab")) fetch(%s); }, true);', wp_json_encode( add_query_arg( 'scope', 'mine', rest_url( 'gq-support/v1/requests' ) ) ) )
			),
			20
		);
		break;
	case 'timer':
		add_action( 'admin_enqueue_scripts', static fn() => wp_add_inline_script( 'gq-support-launcher', 'setInterval(function () {}, 30000);' ), 20 );
		break;
	case 'idle':
		add_action(
			'admin_enqueue_scripts',
			static fn() => wp_add_inline_script(
				'gq-support-launcher',
				sprintf( 'window.addEventListener("focus", function () { fetch(%s); });', wp_json_encode( $gq_support_plugin( 'assets/launcher.css?idle' ) ) )
			),
			20
		);
		break;
}

/**
 * Plugin-owned cron events currently scheduled.
 */
$gq_support_cron_events = static function (): int {
	$count = 0;
	foreach ( (array) _get_cron_array() as $events ) {
		foreach ( array_keys( (array) $events ) as $hook ) {
			$count += str_starts_with( (string) $hook, 'gq_support' ) ? 1 : 0;
		}
	}
	return $count;
};

if ( isset( $_GET['gq_probe'] ) ) {
	$gq_support_cron_before = $gq_support_cron_events();
	// Hold the whole response so the counts can go in a header after everything ran. It waits in a
	// temporary file, not in memory, because an unprobed request never holds its page: buffering it
	// would add the page, and each reallocation of a growing buffer, to the peak memory reported.
	$gq_support_held     = fopen( 'php://temp/maxmemory:0', 'w+b' ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen
	$gq_support_released = false;
	ob_start(
		static function ( string $buffer, int $phase ) use ( $gq_support_held, &$gq_support_released ): string {
			if ( $phase & PHP_OUTPUT_HANDLER_CLEAN ) {
				return '';
			}
			// A buffer ended before shutdown sends the page without the counters, which the spec reports.
			if ( ! $gq_support_released && ! ( $phase & PHP_OUTPUT_HANDLER_FINAL ) ) {
				fwrite( $gq_support_held, $buffer ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite
				return '';
			}
			rewind( $gq_support_held );
			$held = (string) stream_get_contents( $gq_support_held );
			ftruncate( $gq_support_held, 0 );
			return $held . $buffer;
		},
		4096
	);
	add_filter(
		'query',
		static function ( string $query ) use ( &$gq_support_probe ): string {
			if ( str_contains( $query, 'gq_support' ) ) {
				++$gq_support_probe['sql'];
			}
			return $query;
		}
	);
	add_action(
		'shutdown',
		static function () use ( &$gq_support_probe, &$gq_support_released, $gq_support_violation, $gq_support_cron_events, $gq_support_cron_before ): void {
			// Events this request scheduled.
			$gq_support_probe['cron'] = $gq_support_cron_events() - $gq_support_cron_before;
			if ( 'cron' === $gq_support_violation ) {
				wp_clear_scheduled_hook( 'gq_support_probe' );
			}
			header( 'X-GQ-Probe: ' . wp_json_encode( $gq_support_probe ) );
			// The same names as core's performance-test mu-plugin; memory is in bytes.
			header( sprintf( 'Server-Timing: wp-total;dur=%.3F, wp-memory-usage;dur=%d', timer_float() * 1000, memory_get_peak_usage() ) );
			// The held response goes out when the buffers flush, after these headers.
			$gq_support_released = true;
		},
		0
	);
}
