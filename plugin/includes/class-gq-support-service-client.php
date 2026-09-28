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

	private const MAX_RESPONSE_BYTES = 65536;

	/**
	 * Send one signed request.
	 *
	 * @param string                    $method  HTTP method.
	 * @param string                    $path    Worker path under `/v1`.
	 * @param array<string, mixed>|null $payload JSON body, or null for none.
	 * @param GQ_Support_Signer         $signer  Signs this request.
	 * @param int                       $timeout Seconds.
	 * @return array{status: int, body: array<string, mixed>}|WP_Error
	 */
	public static function request( string $method, string $path, ?array $payload, GQ_Support_Signer $signer, int $timeout ) {
		$base = defined( 'GQ_SUPPORT_SERVICE_URL' ) ? (string) constant( 'GQ_SUPPORT_SERVICE_URL' ) : self::BASE_URL;
		if ( 'https' !== wp_parse_url( $base, PHP_URL_SCHEME ) ) {
			return new WP_Error( 'gq_support_not_configured', 'The support service URL must use HTTPS.' );
		}

		$body     = null === $payload ? '' : (string) wp_json_encode( $payload );
		$response = wp_safe_remote_request(
			untrailingslashit( $base ) . $path,
			array(
				'method'              => $method,
				'headers'             => array(
					'Accept'                    => 'application/json',
					'Content-Type'              => 'application/json',
					'GQ-Support-Plugin-Version' => GQ_SUPPORT_VERSION,
				) + $signer->headers( $method, $path, $body ),
				'body'                => '' === $body ? null : $body,
				'timeout'             => $timeout,
				'redirection'         => 0,
				'sslverify'           => true,
				'limit_response_size' => self::MAX_RESPONSE_BYTES,
			)
		);
		if ( is_wp_error( $response ) ) {
			return new WP_Error( 'gq_support_unreachable', 'The support service could not be reached.' );
		}

		$status  = (int) wp_remote_retrieve_response_code( $response );
		$decoded = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( ( $status >= 300 && $status < 400 ) || ! is_array( $decoded ) ) {
			return new WP_Error( 'gq_support_ambiguous_response', 'The support service sent an unexpected response.' );
		}
		return array(
			'status' => $status,
			'body'   => $decoded,
		);
	}
}
