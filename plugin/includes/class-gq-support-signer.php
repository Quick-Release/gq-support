<?php
/**
 * Signs service requests with the installation's Ed25519 key.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Produces the signing headers from the API contract. The canonical string,
 * clock window and replay rules belong to #32; this version is provisional
 * and must match the Worker's verifier before either side ships.
 */
final class GQ_Support_Signer {

	/**
	 * The secret key.
	 *
	 * @var string
	 */
	private string $secret;

	/**
	 * The key ID the service issued, or '' while enrolling.
	 *
	 * @var string
	 */
	private string $key_id;

	/**
	 * The installation the key is bound to; the service rejects the key with any other.
	 *
	 * @var string
	 */
	private string $installation_id;

	/**
	 * Sign with a secret key and its service key ID.
	 *
	 * @param string $secret A 64-byte Ed25519 secret key.
	 * @param string $key_id          The key ID, or '' for `POST /v1/enroll`, which proves possession of the key in its body.
	 * @param string $installation_id This installation's ID.
	 */
	public function __construct( string $secret, string $key_id, string $installation_id ) {
		$this->secret          = $secret;
		$this->key_id          = $key_id;
		$this->installation_id = $installation_id;
	}

	/**
	 * Headers that authenticate one request.
	 *
	 * @param string $method HTTP method.
	 * @param string $path   Path and query, e.g. `/v1/installation`.
	 * @param string $body   Exact request body.
	 * @return array<string, string>
	 */
	public function headers( string $method, string $path, string $body ): array {
		$headers = array(
			'GQ-Support-Key-Id'          => $this->key_id,
			'GQ-Support-Installation-Id' => $this->installation_id,
			'GQ-Support-Timestamp'       => (string) time(),
			'GQ-Support-Request-Id'      => wp_generate_uuid4(),
			'Content-Digest'             => self::digest( $body ),
		);

		$headers['GQ-Support-Signature'] = GQ_Support_Signing_Key::encode(
			sodium_crypto_sign_detached( self::canonical( $method, $path, $body, $headers ), $this->secret )
		);
		return $headers;
	}

	/**
	 * The string that is signed.
	 *
	 * @param string                $method  HTTP method.
	 * @param string                $path    Path and query.
	 * @param string                $body    Exact request body.
	 * @param array<string, string> $headers The key ID, installation ID, timestamp and request ID headers.
	 */
	public static function canonical( string $method, string $path, string $body, array $headers ): string {
		return implode(
			"\n",
			array(
				'gq-support-v1',
				strtoupper( $method ),
				$path,
				$headers['GQ-Support-Key-Id'],
				$headers['GQ-Support-Installation-Id'],
				$headers['GQ-Support-Timestamp'],
				$headers['GQ-Support-Request-Id'],
				self::digest( $body ),
			)
		);
	}

	/**
	 * RFC 9530 `Content-Digest` with SHA-256.
	 *
	 * @param string $body Exact request body.
	 */
	public static function digest( string $body ): string {
		return 'sha-256=:' . GQ_Support_Signing_Key::encode( hash( 'sha256', $body, true ) ) . ':';
	}
}
