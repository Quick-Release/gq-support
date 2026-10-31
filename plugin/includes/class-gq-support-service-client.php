<?php
/**
 * The one adapter from WordPress to the support service.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Sends signed requests under the transport policy in docs/support-api-contract.md.
 */
final class GQ_Support_Service_Client {

	/** Production service. Only `GQ_SUPPORT_SERVICE_URL` in `wp-config.php` overrides it. */
	private const BASE_URL = 'https://support.getquick.io';

	/**
	 * Send one signed request.
	 *
	 * @param string                    $method  HTTP method.
	 * @param string                    $path    Worker path under `/v1`.
	 * @param array<string, mixed>|null $payload JSON body, or null for none.
	 * @param GQ_Support_Signer         $signer  Signs this request.
	 * @param int                       $timeout Seconds.
	 * @return array{status: int, body: array<string, mixed>, retry_after: string}|WP_Error
	 */
	public static function request( string $method, string $path, ?array $payload, GQ_Support_Signer $signer, int $timeout ) {
		// Data-subject requests keep working while the local support experience is disabled.
		// Match exact routes and methods so other support operations still fail closed.
		$privacy_request = ( 'GET' === $method && '/v1/export' === wp_parse_url( $path, PHP_URL_PATH ) )
			|| ( 'POST' === $method && '/v1/erasures' === $path );
		if ( GQ_Support_Fail_Safe::disabled() && ! $privacy_request ) {
			return new WP_Error( 'gq_support_disabled', 'Support is disabled by server configuration.' );
		}
		$base = defined( 'GQ_SUPPORT_SERVICE_URL' ) ? (string) constant( 'GQ_SUPPORT_SERVICE_URL' ) : self::BASE_URL;
		if ( 'https' !== wp_parse_url( $base, PHP_URL_SCHEME ) ) {
			return new WP_Error( 'gq_support_not_configured', 'The support service URL must use HTTPS.' );
		}

		$body     = null === $payload ? '' : self::encode( $payload );
		$response = wp_safe_remote_request(
			untrailingslashit( $base ) . $path,
			array(
				'method'              => $method,
				'headers'             => array(
					'Accept'       => 'application/json',
					'Content-Type' => 'application/json',
				) + $signer->headers( $method, $path, $body ),
				'body'                => '' === $body ? null : $body,
				'timeout'             => $timeout,
				'redirection'         => 0,
				'sslverify'           => true,
				'limit_response_size' => GQ_Support_Limits::RESPONSE_BYTES,
			)
		);
		if ( is_wp_error( $response ) ) {
			return new WP_Error( 'gq_support_unreachable', 'The support service could not be reached.' );
		}

		$status  = (int) wp_remote_retrieve_response_code( $response );
		$raw     = wp_remote_retrieve_body( $response );
		$decoded = json_decode( $raw, true );
		if ( strlen( $raw ) >= GQ_Support_Limits::RESPONSE_BYTES || ( $status >= 300 && $status < 400 ) || ! is_array( $decoded ) ) {
			return new WP_Error( 'gq_support_ambiguous_response', 'The support service sent an unexpected response.' );
		}
		return array(
			'status'      => $status,
			'body'        => $decoded,
			'retry_after' => (string) wp_remote_retrieve_header( $response, 'retry-after' ),
		);
	}

	/**
	 * The exact body sent: compact UTF-8, the same bytes the browser's JSON
	 * would take, so a forwarded create stays within the browser's 32 KiB cap.
	 *
	 * @param array<string, mixed> $payload JSON body.
	 */
	public static function encode( array $payload ): string {
		return (string) wp_json_encode( $payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS );
	}
}
