<?php
/**
 * Connecting this installation to the support service.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Enroll, test and disconnect, shared by the setup page and WP-CLI
 * (docs/support-onboarding-design.md). Callers check `gq_support_manage_settings`.
 */
final class GQ_Support_Connection {

	private const ENROLL_TIMEOUT = 8;

	private const READ_TIMEOUT = 5;

	/**
	 * Exchange an Enrollment code for an Installation credential.
	 *
	 * @param string $code The Enrollment code, as the Operator gave it.
	 * @return array<string, mixed>|WP_Error The redacted status, or why it failed.
	 */
	public static function enroll( string $code ) {
		$code = strtoupper( (string) preg_replace( '/[^A-Za-z0-9]/', '', $code ) );
		if ( '' === $code ) {
			return new WP_Error( 'gq_support_code_not_valid', __( 'Enter the Enrollment code GETQUICK gave you.', 'gq-support' ) );
		}

		$state  = GQ_Support_State::get();
		$secret = GQ_Support_Signing_Key::pending_for( $code );
		$result = GQ_Support_Service_Client::request(
			'POST',
			'/v1/enroll',
			array(
				'code'                => $code,
				'installation_id'     => $state['installation_id'],
				'origin'              => $state['origin'],
				'public_key'          => GQ_Support_Signing_Key::encode( GQ_Support_Signing_Key::public_key( $secret ) ),
				'wp_environment_type' => wp_get_environment_type(),
				'plugin_version'      => GQ_SUPPORT_VERSION,
			),
			new GQ_Support_Signer( $secret, '', $state['installation_id'] ),
			self::ENROLL_TIMEOUT
		);
		if ( is_wp_error( $result ) ) {
			return self::unreachable();
		}
		if ( 429 === $result['status'] ) {
			return new WP_Error( 'gq_support_rate_limited', __( 'Too many attempts. Wait a few minutes and try again.', 'gq-support' ) );
		}
		if ( in_array( $result['status'], array( 400, 404, 409, 410, 422 ), true ) ) {
			// Expired, unknown, used and other Slots' codes all get the same answer.
			return new WP_Error( 'gq_support_code_not_valid', __( 'This Enrollment code is not valid. Ask GETQUICK for a new one.', 'gq-support' ) );
		}
		$body = $result['body'];
		if ( $result['status'] >= 300 || ! isset( $body['key_id'] ) || ! is_string( $body['key_id'] ) ) {
			return self::unreachable();
		}

		GQ_Support_Signing_Key::promote();
		GQ_Support_State::update(
			array(
				'connection'   => 'connected',
				'key_id'       => $body['key_id'],
				'fingerprint'  => GQ_Support_Signing_Key::fingerprint( $secret ),
				'environment'  => isset( $body['environment'] ) ? (string) $body['environment'] : null,
				'connected_at' => isset( $body['connected_at'] ) ? (string) $body['connected_at'] : null,
				'last_test'    => null,
			)
		);
		return self::status();
	}

	/**
	 * Ask the service whether this installation's key and mapping are active.
	 * Runs only when an admin asks for it.
	 *
	 * @return array<string, mixed>|WP_Error The redacted status, or why the test could not run.
	 */
	public static function test() {
		$signer = self::signer();
		if ( null === $signer ) {
			return new WP_Error( 'gq_support_not_connected', __( 'This site is not connected.', 'gq-support' ) );
		}

		$result = GQ_Support_Service_Client::request( 'GET', '/v1/installation', null, $signer, self::READ_TIMEOUT );
		$fields = array();
		if ( is_wp_error( $result ) ) {
			$outcome = 'unreachable';
		} elseif ( in_array( $result['status'], array( 401, 403 ), true ) ) {
			$outcome = 'rejected';
			$fields  = array( 'connection' => 'rejected' );
		} elseif ( 200 === $result['status'] ) {
			$outcome = 'suspended' === ( $result['body']['mapping_state'] ?? '' ) ? 'suspended' : 'ok';
			$fields  = array( 'connection' => 'connected' );
			if ( isset( $result['body']['environment'] ) ) {
				$fields['environment'] = (string) $result['body']['environment'];
			}
		} else {
			$outcome = 'unreachable';
		}

		GQ_Support_State::update(
			$fields + array(
				'last_test' => array(
					'result' => $outcome,
					'at'     => time(),
				),
			)
		);
		return self::status();
	}

	/**
	 * Give up this installation's access: a best-effort signed self-revoke,
	 * then the local key is deleted whatever the result.
	 *
	 * @return array<string, mixed>|WP_Error The redacted status, or why the site cannot disconnect itself.
	 */
	public static function disconnect() {
		if ( GQ_Support_Signing_Key::managed() ) {
			return new WP_Error( 'gq_support_managed', __( 'This connection is managed by server configuration.', 'gq-support' ) );
		}

		$signer  = self::signer();
		$revoked = false;
		if ( null !== $signer ) {
			$result  = GQ_Support_Service_Client::request( 'DELETE', '/v1/installation', null, $signer, self::READ_TIMEOUT );
			$revoked = ! is_wp_error( $result ) && $result['status'] >= 200 && $result['status'] < 300;
		}

		GQ_Support_Signing_Key::delete();
		GQ_Support_State::update( GQ_Support_State::disconnected( 'not_connected' ) );
		return array( 'revoked' => $revoked ) + self::status();
	}

	/**
	 * What an admin may see about the connection. Never the key, the
	 * repository or the service URL. Reads only `gq_support_state`.
	 *
	 * @return array{connection: string, environment: string|null, environment_mismatch: bool, connected_at: string|null, fingerprint: string|null, managed: bool, last_test: array{result: string, at: int}|null}
	 */
	public static function status(): array {
		$state = GQ_Support_State::get();
		return array(
			'connection'           => $state['connection'],
			'environment'          => $state['environment'],
			'environment_mismatch' => null !== $state['environment'] && wp_get_environment_type() !== $state['environment'],
			'connected_at'         => $state['connected_at'],
			'fingerprint'          => GQ_Support_State::holds_credential( $state ) ? $state['fingerprint'] : null,
			'managed'              => GQ_Support_Signing_Key::managed(),
			'last_test'            => $state['last_test'],
		);
	}

	/**
	 * The signer for a connected installation, or null.
	 */
	private static function signer(): ?GQ_Support_Signer {
		$state  = GQ_Support_State::get();
		$secret = GQ_Support_Signing_Key::active();
		$key_id = defined( 'GQ_SUPPORT_KEY_ID' ) ? (string) constant( 'GQ_SUPPORT_KEY_ID' ) : (string) $state['key_id'];
		if ( null === $secret || '' === $key_id || ! GQ_Support_State::holds_credential( $state ) ) {
			return null;
		}
		return new GQ_Support_Signer( $secret, $key_id, $state['installation_id'] );
	}

	/**
	 * The service could not be reached, or answered unexpectedly.
	 */
	private static function unreachable(): WP_Error {
		return new WP_Error( 'gq_support_unreachable', __( 'The support service could not be reached. Try again.', 'gq-support' ) );
	}
}
