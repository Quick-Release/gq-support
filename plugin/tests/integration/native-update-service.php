<?php
/**
 * Test-only must-use plugin for package.sh native: stands in for the support
 * service's native update routes (worker/src/update-access.ts) at the configured
 * service origin, and records every outgoing request the site makes. Never shipped.
 * WordPress.org is answered or refused unrecorded: core's own checks are not the plugin's.
 *
 * The network option `native_update_test` configures it: the next release's ZIP
 * (relative to ABSPATH), version and SHA-256, a `mode` (ok, corrupt, expired-once,
 * withdrawn, unauthorized) and `disabled`, which sets GQ_SUPPORT_DISABLED before
 * the plugin loads.
 *
 * @package GQ_Support
 */

$gq_support_native_update_test = get_site_option( 'native_update_test' );
if ( is_array( $gq_support_native_update_test ) && ! empty( $gq_support_native_update_test['disabled'] ) && ! defined( 'GQ_SUPPORT_DISABLED' ) ) {
	define( 'GQ_SUPPORT_DISABLED', true );
}

/**
 * The service's reply to one request, recorded first.
 *
 * @param false|array|WP_Error $pre  Short-circuit.
 * @param array                $args Request arguments.
 * @param string               $url  Request URL.
 * @return array|WP_Error
 */
function gq_support_native_update_test_service( $pre, $args, $url ) {
	// Core files Update URI offers only after its WordPress.org plugin check succeeds: answer it, offering nothing.
	if ( preg_match( '#^https?://api\.wordpress\.org/plugins/update-check/#i', $url ) ) { // phpcs:ignore WordPress.WP.CapitalPDangit.MisspelledInText -- A host name.
		return array(
			'response' => array( 'code' => 200 ),
			'headers'  => array(),
			'body'     => '{"plugins":[],"translations":[],"no_update":[]}',
		);
	}
	// Other WordPress.org requests and the site's own loopbacks (cron spawning, Site Health) are core's, not the plugin's.
	if ( preg_match( '#^https?://([a-z0-9-]+\.)*wordpress\.org/#i', $url ) || wp_parse_url( site_url(), PHP_URL_HOST ) === wp_parse_url( $url, PHP_URL_HOST ) ) { // phpcs:ignore WordPress.WP.CapitalPDangit.MisspelledInText -- A host name.
		return new WP_Error( 'http_request_failed', 'Offline test site.' );
	}
	$config            = (array) get_site_option( 'native_update_test', array() );
	$headers           = (array) ( $args['headers'] ?? array() );
	$config['calls'][] = array(
		'url'           => $url,
		'context'       => wp_doing_cron() ? 'cron' : ( defined( 'WP_CLI' ) && WP_CLI ? 'cli' : 'web' ),
		'key'           => $headers['GQ-Update-Key-Id'] ?? null,
		'grant'         => $headers['GQ-Update-Grant'] ?? null,
		'authorization' => isset( $headers['Authorization'] ),
		'report_key'    => isset( $headers['GQ-Support-Key-Id'] ),
		'redirection'   => $args['redirection'] ?? null,
	);
	$base              = class_exists( 'GQ_Support_Service_Client' ) ? GQ_Support_Service_Client::base_url() : null;
	$mode              = $config['mode'] ?? 'ok';
	$reply             = static function ( int $status, string $body, array $headers = array() ) use ( $args ): array {
		if ( ! empty( $args['stream'] ) ) {
			file_put_contents( $args['filename'], $body ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- The transport's own write.
		}
		return array(
			'response' => array( 'code' => $status ),
			'headers'  => $headers,
			'body'     => empty( $args['stream'] ) ? $body : '',
		);
	};
	$result            = new WP_Error( 'http_request_failed', 'Not the support service.' );
	if ( null !== $base && $base . GQ_Support_Updater::METADATA_PATH === $url ) {
		if ( 'unauthorized' === $mode || empty( $headers['GQ-Update-Key-Id'] ) ) {
			$result = $reply( 401, '{"code":"gq_support_update_unauthorized"}' );
		} else {
			$config['grant'] = rtrim( strtr( base64_encode( random_bytes( 32 ) ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- A test grant token.
			$result          = $reply(
				200,
				(string) wp_json_encode(
					array(
						'plugin'      => 'gq-support',
						'auto_update' => true,
						'release'     => array(
							'release_id'     => 7,
							'version'        => $config['version'],
							'package_sha256' => $config['sha256'],
							'package_path'   => GQ_Support_Updater::PACKAGE_PATH . '?version=' . rawurlencode( $config['version'] ) . '&sha256=' . $config['sha256'],
						),
						'grant'       => array(
							'token'      => $config['grant'],
							'expires_at' => gmdate( 'Y-m-d\TH:i:s\Z', time() + 900 ),
						),
					)
				)
			);
		}
	} elseif ( null !== $base && GQ_Support_Updater::package_url( $config['version'], $config['sha256'] ) === $url ) {
		$packages = count( array_filter( $config['calls'], static fn ( $call ) => $call['url'] === $url ) );
		if ( 'unauthorized' === $mode ) {
			$result = $reply( 401, '{"code":"gq_support_update_unauthorized"}' );
		} elseif ( ( $headers['GQ-Update-Grant'] ?? '' ) !== ( $config['grant'] ?? null ) || ( 'expired-once' === $mode && 1 === $packages ) ) {
			$result = $reply( 401, '{"code":"gq_support_update_grant_expired"}' );
		} elseif ( 'withdrawn' === $mode ) {
			$result = $reply( 410, '{"code":"gq_support_update_withdrawn"}' );
		} else {
			$bytes  = 'corrupt' === $mode ? 'PK not the approved bytes' : (string) file_get_contents( ABSPATH . $config['zip'] ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Local fixture.
			$result = $reply( 200, $bytes, array( 'gq-update-package-sha256' => $config['sha256'] ) );
		}
	}
	update_site_option( 'native_update_test', $config );
	return $result;
}
add_filter( 'pre_http_request', 'gq_support_native_update_test_service', 10, 3 );
