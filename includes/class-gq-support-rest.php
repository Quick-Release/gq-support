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
						'supersedes_id' => array(
							'type'    => 'string',
							'pattern' => '^req_[0-9A-HJKMNP-TV-Z]{26}$',
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
		register_rest_route(
			'gq-support/v1',
			'/requests/(?P<id>[A-Za-z0-9_-]+)/status',
			array(
				'methods' => WP_REST_Server::CREATABLE,
				'args'    => array(
					'id'        => array(
						'type'      => 'string',
						'maxLength' => 128,
					),
					'change_id' => array(
						'type'     => 'string',
						'required' => true,
						'format'   => 'uuid',
					),
					'status'    => array(
						'type'     => 'string',
						'required' => true,
						'enum'     => array( 'open', 'closed' ),
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
		$site = GQ_Support_Access::can( 'gq_support_view_site_requests' );
		$own  = GQ_Support_Access::can( 'gq_support_submit_requests' );
		// A close or reopen, like a read by ID, reaches own requests or a Support manager's installation scope.
		$allowed = self::is_change( $request ) || ( 'POST' !== $request->get_method() && $request['id'] )
			? ( $own || $site )
			: ( 'POST' === $request->get_method() ? $own : ( 'site' === ( $request['scope'] ?? 'mine' ) ? $site : $own ) );
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
		if ( GQ_Support_Fail_Safe::disabled() ) {
			return self::error( 'gq_support_disabled', 503 );
		}
		$change     = self::is_change( $request );
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
		$create  = 'POST' === $request->get_method() && ! $change;
		$write   = $create || $change;
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
		// The key an uncertain write is checked again with.
		$retry_key = array();
		// Whether the cached release policy closed new intake for this plugin (GQ_Support_Release).
		$locally_closed = $create && 'closed' === GQ_Support_Release::local_intake( time() );
		if ( $change ) {
			$body = self::validate_change( $request );
			if ( is_wp_error( $body ) ) {
				return $body;
			}
			$path     .= '/' . rawurlencode( $request['id'] ) . '/status';
			$payload   = $body + $identity;
			$retry_key = array( 'change_id' => $body['change_id'] );
		} elseif ( $create ) {
			$body = self::validate_create( $request );
			if ( is_wp_error( $body ) ) {
				return $body;
			}
			$payload = array_map( 'trim', array_intersect_key( $body, array_flip( array( 'submission_id', 'summary', 'description', 'supersedes_id' ) ) ) );
			if ( isset( $body['context'] ) ) {
				// Only reviewed values travel. The envelope itself stays here: it is not part of the intent.
				$review = GQ_Support_Report_Context::verify( $body['context_review'], $body['context'], $payload['submission_id'], $subject, time() );
				if ( 'invalid' === $review ) {
					return self::error( 'gq_support_invalid_request', 400 );
				}
				$payload['context'] = GQ_Support_Report_Context::json_value( $body['context'] );
				if ( 'expired' === $review ) {
					// An expired review still reconciles an accepted intent, but never authorizes a new one.
					$payload['reconcile_only'] = true;
				}
			}
			// This plugin may no longer start new intake: the service only returns an intent
			// it already accepted, so a retry is never falsely failed.
			if ( $locally_closed ) {
				$payload['reconcile_only'] = true;
			}
			$payload  += $identity;
			$retry_key = array( 'submission_id' => $payload['submission_id'] );
			if ( isset( $payload['context'] ) && strlen( GQ_Support_Service_Client::encode( $payload ) ) > GQ_Support_Limits::BODY_BYTES ) {
				return self::error( 'gq_support_payload_too_large', 413 );
			}
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
		$result = GQ_Support_Service_Client::request( $write ? 'POST' : 'GET', $path, $payload, new GQ_Support_Signer( $secret, $key_id, $state['installation_id'] ), $write ? 8 : 5 );
		if ( is_wp_error( $result ) ) {
			if ( 'gq_support_not_configured' === $result->get_error_code() ) {
				return self::error( 'gq_support_not_configured', 503 );
			}
			return self::error( $write ? 'gq_support_outcome_unknown' : 'gq_support_unavailable', $write ? 504 : 503, $retry_key );
		}
		if ( in_array( $result['status'], array( 401, 403 ), true ) ) {
			return self::error( 'gq_support_not_configured', 503 );
		}
		if ( 404 === $result['status'] ) {
			return self::error( 'gq_support_not_found', 404 );
		}
		if ( 426 === $result['status'] ) {
			// The service refused this version new intake: later executions stop it locally too.
			GQ_Support_Release::learn( $result['body']['release'] ?? null );
		}
		if ( $create && $locally_closed && 412 === $result['status'] ) {
			// Nothing was accepted under this Submission ID, and this plugin may not start it.
			return self::error( 'gq_support_plugin_outdated', 426 );
		}
		if ( ! in_array( $result['status'], $create ? array( 201, 202 ) : ( $change ? array( 200, 202 ) : array( 200 ) ), true ) ) {
			$codes = array(
				400 => 'gq_support_invalid_request',
				413 => 'gq_support_payload_too_large',
				500 => 'gq_support_internal',
				// A status change names why it waits; only these codes pass through.
				409 => $change && in_array( $result['body']['code'] ?? null, array( 'gq_support_change_pending', 'gq_support_change_not_allowed' ), true )
					? $result['body']['code'] : 'gq_support_idempotency_conflict',
				412 => 'gq_support_context_expired',
				426 => 'gq_support_plugin_outdated',
				429 => 'gq_support_rate_limited',
				503 => $write ? 'gq_support_not_accepted' : 'gq_support_unavailable',
			);
			$error = self::error( $codes[ $result['status'] ] ?? ( $write ? 'gq_support_outcome_unknown' : 'gq_support_unavailable' ), isset( $codes[ $result['status'] ] ) ? $result['status'] : ( $write ? 504 : 503 ), $retry_key );
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
				// Out-of-scope stays hidden; a malformed write reply proves nothing.
				return $create || ( $change && 'gq_support_not_found' !== $body->get_error_code() ) ? self::error( 'gq_support_outcome_unknown', 504, $retry_key ) : $body;
			}
			if ( ( $request['id'] && $body['id'] !== $request['id'] ) || ( $create && $body['submission_id'] !== $payload['submission_id'] ) ) {
				return self::error( $write ? 'gq_support_outcome_unknown' : 'gq_support_not_found', $write ? 504 : 404, $retry_key );
			}
		}
		if ( $create && ( ( 201 === $result['status'] ) !== ( 'delivered' === $body['delivery'] ) ) ) {
			return self::error( 'gq_support_outcome_unknown', 504, $retry_key );
		}
		// The reply must name this change, with 200 exactly when it was delivered.
		if ( $change && ( null === $body['status_change'] || $body['status_change']['change_id'] !== $payload['change_id'] || $body['status_change']['status'] !== $payload['status']
			|| ( 200 === $result['status'] ) !== ( 'delivered' === $body['status_change']['delivery'] ) ) ) {
			return self::error( 'gq_support_outcome_unknown', 504, $retry_key );
		}

		// Notify only after the complete response, ownership and create correlation are validated.
		foreach ( ( ! $create && ! $request['id'] ) ? $body['items'] : array( $body ) as $observed ) {
			self::observe( $observed, $create );
		}

		$response = new WP_REST_Response( $body, $result['status'] );
		if ( 201 === $result['status'] ) {
			$response->header( 'Location', rest_url( 'gq-support/v1/requests/' . rawurlencode( $body['id'] ) ) );
		}
		return $response;
	}

	/**
	 * Confirmed observations during explicit operations only. Terminal outcomes
	 * confirm a transition out of pending; independent observations may repeat.
	 * No local event ledger, background subscription or exactly-once guarantee.
	 *
	 * @param array{id: string, delivery: string} $observed Validated public resource.
	 * @param bool                                $create   Successful create/replay.
	 */
	private static function observe( array $observed, bool $create ): void {
		$id      = $observed['id'];
		$outcome = $observed['delivery'];
		if ( ! preg_match( '/^req_[0-9A-HJKMNP-TV-Z]{26}\z/', $id ) ) {
			return;
		}
		if ( $create && in_array( $outcome, array( 'accepted-pending', 'delivered', 'failed' ), true ) ) {
			try {
				/**
				 * A create or replay confirmed durable acceptance.
				 *
				 * @since 0.1.10
				 * @param string $id      Public opaque Support request ID, never the Submission ID.
				 * @param string $outcome Allowlisted confirmed delivery outcome.
				 */
				do_action( 'gq_support_report_accepted', $id, $outcome );
			} catch ( Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement.DetectedCatch -- Preserve the confirmed result; WordPress hook state may remain unclean.
				// Observer failures cannot undo acceptance; never log exception details.
			}
		}
		if ( in_array( $outcome, array( 'delivered', 'failed' ), true ) ) {
			try {
				/**
				 * An explicit support operation confirmed a terminal delivery transition.
				 * Repeated observations can repeat this notification; callbacks must be idempotent.
				 *
				 * @since 0.1.10
				 * @param string $id      Public opaque Support request ID.
				 * @param string $outcome Delivered or failed; never an ambiguous outcome.
				 */
				do_action( 'gq_support_report_delivery_changed', $id, $outcome );
			} catch ( Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement.DetectedCatch -- A callback cannot change the confirmed result.
				// Keep the confirmed result, without exposing callback output or raw errors.
			}
		}
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
	 * Reject authority overrides and enforce the v1 create schema. Report context
	 * and its review envelope travel together; the context is normalized here.
	 *
	 * @param WP_REST_Request $request Browser request.
	 * @return array<string, mixed>|WP_Error The decoded body.
	 */
	private static function validate_create( WP_REST_Request $request ) {
		if ( strlen( $request->get_body() ) > GQ_Support_Limits::BODY_BYTES ) {
			return self::error( 'gq_support_payload_too_large', 413 );
		}
		$body = json_decode( (string) $request->get_body(), true );
		if ( is_array( $body ) && ( array_key_exists( 'context', $body ) || array_key_exists( 'context_review', $body ) ) ) {
			// Decode objects as objects, so a JSON array never passes for one.
			$context = GQ_Support_Report_Context::parse( json_decode( (string) $request->get_body() )->context ?? null );
			if ( null === $context || ! is_string( $body['context_review'] ?? null ) ) {
				return self::error( 'gq_support_invalid_request', 400 );
			}
			$body['context'] = $context;
		}
		if ( ! is_array( $body ) || array_diff( array_keys( $body ), array( 'submission_id', 'summary', 'description', 'supersedes_id', 'context', 'context_review' ) )
			|| ! isset( $body['submission_id'], $body['description'] ) || ! is_string( $body['submission_id'] )
			|| ! preg_match( '/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i', $body['submission_id'] )
			|| ( array_key_exists( 'supersedes_id', $body ) && ( ! is_string( $body['supersedes_id'] ) || ! preg_match( '/^req_[0-9A-HJKMNP-TV-Z]{26}$/', $body['supersedes_id'] ) ) )
			|| ! is_string( $body['description'] ) || '' === trim( $body['description'] ) || mb_strlen( trim( $body['description'] ) ) > GQ_Support_Limits::DESCRIPTION_CHARACTERS
			|| ( array_key_exists( 'summary', $body ) && ( ! is_string( $body['summary'] ) || '' === trim( $body['summary'] ) || mb_strlen( trim( $body['summary'] ) ) > GQ_Support_Limits::SUMMARY_CHARACTERS || preg_match( '/[\r\n]/', trim( $body['summary'] ) ) ) ) ) {
			return self::error( 'gq_support_invalid_request', 400 );
		}
		return $body;
	}

	/**
	 * Whether this is a close or reopen: the only write on an existing request.
	 *
	 * @param WP_REST_Request $request Browser request.
	 */
	private static function is_change( WP_REST_Request $request ): bool {
		return 'POST' === $request->get_method() && (bool) preg_match( '#^/gq-support/v1/requests/[^/]+/status$#', $request->get_route() );
	}

	/**
	 * Exactly a UUIDv4 Change ID and a supported Support status, as JSON.
	 *
	 * @param WP_REST_Request $request Browser request.
	 * @return array{change_id: string, status: string}|WP_Error
	 */
	private static function validate_change( WP_REST_Request $request ) {
		$body = json_decode( (string) $request->get_body(), true );
		if ( ! is_array( $body ) || 2 !== count( $body ) || ! isset( $body['change_id'], $body['status'] ) || ! is_string( $body['change_id'] ) || ! preg_match( '/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i', $body['change_id'] )
			|| ! in_array( $body['status'], array( 'open', 'closed' ), true ) ) {
			return self::error( 'gq_support_invalid_request', 400 );
		}
		return array(
			'change_id' => $body['change_id'],
			'status'    => $body['status'],
		);
	}

	/**
	 * A latest close or reopen: its Change ID, requested status and delivery outcome only.
	 *
	 * @param mixed $change Service field.
	 */
	private static function valid_change( $change ): bool {
		return null === $change || ( is_array( $change ) && 3 === count( $change ) && isset( $change['change_id'], $change['status'], $change['delivery'] )
			&& is_string( $change['change_id'] ) && preg_match( '/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i', $change['change_id'] )
			&& in_array( $change['status'], array( 'open', 'closed' ), true )
			&& in_array( $change['delivery'], array( 'accepted-pending', 'delivered', 'failed', 'outcome-unknown' ), true ) );
	}

	/**
	 * Verify service-side ownership metadata, then expose only public fields and whether the request is the current Reporter's.
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
		// A service without status changes sends none; its delivery is separate from `status` (ADR 0020).
		$item += array( 'status_change' => null );
		if ( ! self::valid_change( $item['status_change'] ) ) {
			return self::error( 'gq_support_unavailable', 503 );
		}
		$fields[] = 'status_change';
		// Only WordPress decides `own`, from the metadata it just verified; a service-sent value is dropped.
		return array_intersect_key( $item, array_flip( $fields ) ) + array( 'own' => $item['reporter_subject'] === $subject );
	}

	/**
	 * A sanitized error; never include an upstream body or exception.
	 *
	 * @param string                $code Machine code.
	 * @param int                   $status HTTP status.
	 * @param array<string, string> $retry_key The Submission ID or Change ID an uncertain write is checked again with.
	 */
	private static function error( string $code, int $status, array $retry_key = array() ): WP_Error {
		return new WP_Error(
			$code,
			__( 'Support is unavailable. Reload the page to continue.', 'gq-support' ),
			array(
				'status'         => $status,
				'correlation_id' => wp_generate_uuid4(),
				'retryable'      => in_array( $code, array( 'gq_support_not_accepted', 'gq_support_unavailable', 'gq_support_outcome_unknown' ), true ),
			) + $retry_key
		);
	}
}
