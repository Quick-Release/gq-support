<?php
/**
 * Cookie-authenticated, installation-scoped support REST boundary.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** Native REST routes. No support I/O happens until a permitted callback runs. */
final class GQ_Support_REST {

	/** Register even when this installation is not connected. */
	public static function register(): void {
		$common = array(
			'permission_callback' => array( __CLASS__, 'permission' ),
			'callback'            => array( __CLASS__, 'dispatch' ),
		);
		register_rest_route(
			'gq-support/v1',
			'/requests',
			array(
				array(
					'methods' => WP_REST_Server::CREATABLE,
					'args'    => array(
						'submission_id' => array(
							'type'     => 'string',
							'required' => true,
							'format'   => 'uuid',
						),
						'summary'       => array(
							'type'              => 'string',
							'maxLength'         => GQ_Support_Limits::SUMMARY_CHARACTERS,
							'validate_callback' => array( __CLASS__, 'validate_text' ),
							'sanitize_callback' => array( __CLASS__, 'trim_text' ),
						),
						'description'   => array(
							'type'              => 'string',
							'required'          => true,
							'minLength'         => 1,
							'maxLength'         => GQ_Support_Limits::DESCRIPTION_CHARACTERS,
							'validate_callback' => array( __CLASS__, 'validate_text' ),
							'sanitize_callback' => array( __CLASS__, 'trim_text' ),
						),
					),
				) + $common,
				array(
					'methods' => WP_REST_Server::READABLE,
					'args'    => array(
						'scope'    => array(
							'type'    => 'string',
							'enum'    => array( 'mine', 'site' ),
							'default' => 'mine',
						),
						'per_page' => array(
							'type'    => 'integer',
							'minimum' => 1,
							'maximum' => 50,
							'default' => 20,
						),
						'cursor'   => array(
							'type'      => 'string',
							'maxLength' => 1024,
						),
					),
				) + $common,
			)
		);
		register_rest_route(
			'gq-support/v1',
			'/requests/(?P<id>[A-Za-z0-9_-]+)',
			array(
				'methods' => WP_REST_Server::READABLE,
				'args'    => array(
					'id' => array(
						'type'      => 'string',
						'maxLength' => 128,
					),
				),
			) + $common
		);
		add_filter( 'rest_post_dispatch', array( __CLASS__, 'no_store' ), 10, 3 );
	}

	/**
	 * Do not cache successes, authorization errors or unknown support paths.
	 *
	 * @param WP_REST_Response $response REST response.
	 * @param WP_REST_Server   $server REST server.
	 * @param WP_REST_Request  $request Browser request.
	 */
	public static function no_store( WP_REST_Response $response, WP_REST_Server $server, WP_REST_Request $request ): WP_REST_Response {
		if ( str_starts_with( $request->get_route(), '/gq-support/v1/' ) ) {
			$response->header( 'Cache-Control', 'private, no-store' );
		}
		return $response;
	}

	/**
	 * Require a real cookie session, nonce and fresh site capability.
	 *
	 * @param WP_REST_Request $request Browser request.
	 * @return true|WP_Error
	 */
	public static function permission( WP_REST_Request $request ) {
		if ( ! is_user_logged_in() ) {
			return self::error( 'rest_not_logged_in', 401 );
		}
		$cookie_user = wp_validate_auth_cookie( '', 'logged_in' );
		if ( ! $cookie_user || get_current_user_id() !== $cookie_user || ! wp_verify_nonce( $request->get_header( 'X-WP-Nonce' ), 'wp_rest' ) ) {
			return self::error( 'rest_cookie_invalid_nonce', 403 );
		}
		$site    = GQ_Support_Access::can( 'gq_support_view_site_requests' );
		$own     = GQ_Support_Access::can( 'gq_support_submit_requests' );
		$allowed = 'POST' === $request->get_method() ? $own : ( $request['id'] ? ( $own || $site ) : ( 'site' === ( $request['scope'] ?? 'mine' ) ? $site : $own ) );
		if ( ! $allowed ) {
			return self::error( 'gq_support_forbidden', 403 );
		}
		return true;
	}

	/**
	 * Forward an authorized operation.
	 *
	 * @param WP_REST_Request $request Browser request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function dispatch( WP_REST_Request $request ) {
		$query_keys = 'POST' === $request->get_method() || $request['id'] ? array() : array( 'scope', 'per_page', 'cursor' );
		if ( array_diff( array_keys( $request->get_query_params() ), array_merge( $query_keys, array( 'rest_route' ) ) ) || $request->get_body_params() || ( 'POST' !== $request->get_method() && '' !== (string) $request->get_body() ) ) {
			return self::error( 'gq_support_invalid_request', 400 );
		}
		$state  = GQ_Support_State::get();
		$secret = GQ_Support_Signing_Key::active();
		$key_id = GQ_Support_State::key_id( $state );
		if ( 'connected' !== $state['connection'] || null === $secret || '' === $key_id ) {
			return self::error( 'gq_support_not_configured', 503 );
		}
		$create  = 'POST' === $request->get_method();
		$subject = GQ_Support_Access::subject();
		if ( is_wp_error( $subject ) ) {
			return self::error( 'gq_support_unavailable', 503 );
		}
		$site     = ! $create && GQ_Support_Access::can( 'gq_support_view_site_requests' ) && ( $request['id'] || 'site' === ( $request['scope'] ?? 'mine' ) );
		$identity = array(
			'reporter_subject' => $subject,
			'scope'            => $site ? 'site' : 'mine',
		);
		$path     = '/v1/requests';
		$payload  = null;
		if ( $create ) {
			$payload = $request->get_json_params();
			$invalid = self::validate_create( $request );
			if ( is_wp_error( $invalid ) ) {
				return $invalid;
			}
			$payload = array_map( 'trim', $payload ) + $identity;
		} else {
			if ( $request['id'] ) {
				$path .= '/' . rawurlencode( $request['id'] );
			} else {
				$identity['per_page'] = $request['per_page'] ?? 20;
				if ( isset( $request['cursor'] ) ) {
					$identity['cursor'] = $request['cursor'];
				}
			}
			$path .= '?' . http_build_query( $identity, '', '&', PHP_QUERY_RFC3986 );
		}
		$result = GQ_Support_Service_Client::request( $create ? 'POST' : 'GET', $path, $payload, new GQ_Support_Signer( $secret, $key_id, $state['installation_id'] ), $create ? 8 : 5 );
		if ( is_wp_error( $result ) ) {
			if ( 'gq_support_not_configured' === $result->get_error_code() ) {
				return self::error( 'gq_support_not_configured', 503 );
			}
			return self::error( $create ? 'gq_support_outcome_unknown' : 'gq_support_unavailable', $create ? 504 : 503, $create ? $payload['submission_id'] : null );
		}
		if ( in_array( $result['status'], array( 401, 403 ), true ) ) {
			return self::error( 'gq_support_not_configured', 503 );
		}
		if ( 404 === $result['status'] ) {
			return self::error( 'gq_support_not_found', 404 );
		}
		if ( ! in_array( $result['status'], $create ? array( 201, 202 ) : array( 200 ), true ) ) {
			$codes = array(
				400 => 'gq_support_invalid_request',
				413 => 'gq_support_payload_too_large',
				500 => 'gq_support_internal',
				409 => 'gq_support_idempotency_conflict',
				426 => 'gq_support_plugin_outdated',
				429 => 'gq_support_rate_limited',
				503 => $create ? 'gq_support_not_accepted' : 'gq_support_unavailable',
			);
			$error = self::error( $codes[ $result['status'] ] ?? ( $create ? 'gq_support_outcome_unknown' : 'gq_support_unavailable' ), isset( $codes[ $result['status'] ] ) ? $result['status'] : ( $create ? 504 : 503 ), $create ? $payload['submission_id'] : null );
			if ( preg_match( '/^[0-9]{1,8}$/', $result['retry_after'] ) || preg_match( '/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/', $result['retry_after'] ) ) {
				$response = rest_convert_error_to_response( $error );
				$response->header( 'Retry-After', $result['retry_after'] );
				return $response;
			}
			return $error;
		}
		$body = $result['body'];
		if ( ! $create && ! $request['id'] ) {
			if ( ! isset( $body['items'] ) || ! is_array( $body['items'] ) || ! array_key_exists( 'next_cursor', $body ) || ( null !== $body['next_cursor'] && ! is_string( $body['next_cursor'] ) ) ) {
				return self::error( 'gq_support_unavailable', 503 );
			}
			$items = array();
			foreach ( $body['items'] as $item ) {
				$resource = self::resource( $item, $subject, $site );
				if ( is_wp_error( $resource ) ) {
					return $resource;
				}
				$items[] = $resource;
			}
			$body = array(
				'items'       => $items,
				'next_cursor' => $body['next_cursor'],
			);
		} else {
			$body = self::resource( $body, $subject, $site );
			if ( is_wp_error( $body ) ) {
				return $create ? self::error( 'gq_support_outcome_unknown', 504, $payload['submission_id'] ) : $body;
			}
			if ( ( $request['id'] && $body['id'] !== $request['id'] ) || ( $create && $body['submission_id'] !== $payload['submission_id'] ) ) {
				return self::error( $create ? 'gq_support_outcome_unknown' : 'gq_support_not_found', $create ? 504 : 404, $create ? $payload['submission_id'] : null );
			}
		}
		if ( $create && ( ( 201 === $result['status'] ) !== ( 'delivered' === $body['delivery'] ) ) ) {
			return self::error( 'gq_support_outcome_unknown', 504, $payload['submission_id'] );
		}

		$response = new WP_REST_Response( $body, $result['status'] );
		if ( 201 === $result['status'] ) {
			$response->header( 'Location', rest_url( 'gq-support/v1/requests/' . rawurlencode( $body['id'] ) ) );
		}
		return $response;
	}

	/**
	 * Apply REST field schemas after trimming, as the contract requires.
	 *
	 * @param mixed           $value Field value.
	 * @param WP_REST_Request $request Browser request.
	 * @param string          $param Field name.
	 * @return true|WP_Error
	 */
	public static function validate_text( $value, WP_REST_Request $request, string $param ) {
		$schema = $request->get_attributes()['args'][ $param ];
		return rest_validate_value_from_schema( is_string( $value ) ? trim( $value ) : $value, $schema, $param );
	}

	/**
	 * Preserve plain text while normalizing the contract's surrounding whitespace.
	 *
	 * @param string|null $value Validated field value.
	 */
	public static function trim_text( ?string $value ): ?string {
		return null === $value ? null : trim( $value );
	}

	/**
	 * Reject authority overrides and enforce the v1 plain-text create schema.
	 *
	 * @param WP_REST_Request $request Browser request.
	 * @return true|WP_Error
	 */
	private static function validate_create( WP_REST_Request $request ) {
		if ( strlen( $request->get_body() ) > GQ_Support_Limits::BODY_BYTES ) {
			return self::error( 'gq_support_payload_too_large', 413 );
		}
		$body = json_decode( (string) $request->get_body(), true );
		if ( ! is_array( $body ) || array_diff( array_keys( $body ), array( 'submission_id', 'summary', 'description' ) )
			|| ! isset( $body['submission_id'], $body['description'] ) || ! is_string( $body['submission_id'] )
			|| ! preg_match( '/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i', $body['submission_id'] )
			|| ! is_string( $body['description'] ) || '' === trim( $body['description'] ) || mb_strlen( trim( $body['description'] ) ) > GQ_Support_Limits::DESCRIPTION_CHARACTERS
			|| ( array_key_exists( 'summary', $body ) && ( ! is_string( $body['summary'] ) || '' === trim( $body['summary'] ) || mb_strlen( trim( $body['summary'] ) ) > GQ_Support_Limits::SUMMARY_CHARACTERS || preg_match( '/[\r\n]/', trim( $body['summary'] ) ) ) ) ) {
			return self::error( 'gq_support_invalid_request', 400 );
		}
		return true;
	}

	/**
	 * Verify service-side ownership metadata, then expose only public fields.
	 * The Worker must independently enforce this same scope before returning data.
	 *
	 * @param mixed  $item Service resource, including trusted ownership metadata.
	 * @param string $subject Current Reporter subject.
	 * @param bool   $site Fresh site-wide read grant.
	 * @return array<string, mixed>|WP_Error
	 */
	private static function resource( $item, string $subject, bool $site ) {
		if ( ! is_array( $item ) || ( $item['installation_id'] ?? null ) !== GQ_Support_State::get()['installation_id'] || ( ! $site && ( $item['reporter_subject'] ?? null ) !== $subject ) ) {
			return self::error( 'gq_support_not_found', 404 );
		}
		$fields = array( 'id', 'submission_id', 'title', 'summary', 'description', 'created_at', 'delivery', 'status' );
		foreach ( $fields as $field ) {
			if ( ! array_key_exists( $field, $item ) || ( ! is_string( $item[ $field ] ) && ! ( null === $item[ $field ] && in_array( $field, array( 'summary', 'status' ), true ) ) ) ) {
				return self::error( 'gq_support_unavailable', 503 );
			}
		}
		if ( ! in_array( $item['delivery'], array( 'accepted-pending', 'delivered', 'failed', 'outcome-unknown' ), true ) || ( 'delivered' === $item['delivery'] ? ! in_array( $item['status'], array( 'open', 'closed' ), true ) : null !== $item['status'] ) ) {
			return self::error( 'gq_support_unavailable', 503 );
		}
		return array_intersect_key( $item, array_flip( $fields ) );
	}

	/**
	 * A sanitized error; never include an upstream body or exception.
	 *
	 * @param string      $code Machine code.
	 * @param int         $status HTTP status.
	 * @param string|null $submission_id Submission ID for ambiguous creates.
	 */
	private static function error( string $code, int $status, ?string $submission_id = null ): WP_Error {
		return new WP_Error(
			$code,
			__( 'Support is unavailable. Reload the page to continue.', 'gq-support' ),
			array(
				'status'         => $status,
				'correlation_id' => wp_generate_uuid4(),
				'retryable'      => in_array( $code, array( 'gq_support_not_accepted', 'gq_support_unavailable', 'gq_support_outcome_unknown' ), true ),
			) + ( null !== $submission_id ? array( 'submission_id' => $submission_id ) : array() )
		);
	}
}
