<?php
/**
 * Counter probe and fake Worker for the performance gate (plugin/tests/browser/performance.spec.ts).
 * The spec installs it as an mu-plugin on the disposable test site and removes it afterwards.
 *
 * - Every request: `GQ_SUPPORT_SERVICE_URL` points at a fake Worker that answers 503, so no
 *   plugin request can leave the machine.
 * - `?gq_probe=1`: the response carries an `X-GQ-Probe` header with the plugin's SQL, HTTP and
 *   cron counts for that request. Plugin SQL is attributed by the `gq_support` name in the query.
 * - `?gq_off=1`: the plugin is inactive for this request only, for on/off comparisons.
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
}

$gq_support_violation = isset( $_GET['gq_violate'] ) ? sanitize_key( wp_unslash( $_GET['gq_violate'] ) ) : '';
$gq_support_plugin    = static fn( string $file ): string => plugins_url( "gq-support/{$file}" );

switch ( $gq_support_violation ) {
	case 'sql':
		add_action(
			'init',
			static function (): void {
				global $wpdb;
				$wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", 'gq_support_probe' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			}
		);
		break;
	case 'http':
		add_action( 'init', static fn() => wp_remote_get( GQ_SUPPORT_SERVICE_URL . '/v1/installation' ) );
		break;
	case 'cron':
		add_action( 'init', static fn() => wp_schedule_single_event( time() + HOUR_IN_SECONDS, 'gq_support_probe' ) );
		break;
	case 'bytes':
		add_action(
			'wp_head',
			static function () use ( $gq_support_plugin ): void {
				// phpcs:ignore WordPress.WP.EnqueuedResources.NonEnqueuedStylesheet -- The violation is the point.
				printf( '<link rel="stylesheet" href="%s" />', esc_url( $gq_support_plugin( 'assets/launcher.css' ) ) );
			}
		);
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
	// Hold the whole response so the counts can go in a header after everything ran.
	ob_start();
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
		static function () use ( &$gq_support_probe, $gq_support_violation, $gq_support_cron_events, $gq_support_cron_before ): void {
			// Events this request scheduled.
			$gq_support_probe['cron'] = $gq_support_cron_events() - $gq_support_cron_before;
			if ( 'cron' === $gq_support_violation ) {
				wp_clear_scheduled_hook( 'gq_support_probe' );
			}
			header( 'X-GQ-Probe: ' . wp_json_encode( $gq_support_probe ) );
		},
		0
	);
}
