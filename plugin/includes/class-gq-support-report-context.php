<?php
/**
 * Report context: the reviewed, removable facts sent with a Support request
 * (docs/support-context-design.md).
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Collects the default Report context on explicit open, issues the review
 * envelope that lets a create carry exactly what the Reporter previewed, and
 * validates submitted context against the approved schema. The service
 * applies the same schema; contract/fixtures/context.json holds both to it.
 *
 * Context is never logged and never joins a Reporter projection.
 *
 * @phpstan-type Context array{schema: int, default: array<string, string>}
 */
final class GQ_Support_Report_Context {

	public const SCHEMA = 1;

	/** UTF-8 bytes of one value; each field's grammar may be tighter. */
	public const SCALAR_BYTES = 256;

	/** UTF-8 bytes of the normalized context, serialized compactly. */
	public const CONTEXT_BYTES = 6144;

	public const DEFAULT_KEYS = 3;

	/** Seconds a review envelope can authorize a first acceptance. Accepted intents reconcile after it. */
	public const REVIEW_SECONDS = 3600;

	/** The longest envelope: the base64url payload of the largest normalized context, with its bindings and MAC. */
	public const REVIEW_BYTES = 8448;

	/** The coarse screens a launcher can report; any other screen is omitted. */
	public const SCREENS = array( 'dashboard', 'post-list', 'post-editor', 'woocommerce' );

	/** Approved default fields and their grammar, in canonical order. Technical details are not approved here. */
	private const FIELDS = array(
		'wp_version'             => 'version',
		'support_plugin_version' => 'version',
		'originating_screen'     => 'screen',
	);

	/**
	 * Validate submitted context, decoded with JSON objects as `stdClass`, so an
	 * array never passes for an object. Nothing is dropped or truncated: a
	 * submitted value is either exactly valid or rejected.
	 *
	 * @param mixed $value Decoded JSON value.
	 * @return Context|null
	 */
	public static function parse( $value ): ?array {
		if ( ! $value instanceof stdClass ) {
			return null;
		}
		$fields = get_object_vars( $value );
		if ( array_diff( array_map( 'strval', array_keys( $fields ) ), array( 'schema', 'default' ) ) || ! ( $fields['default'] ?? null ) instanceof stdClass ) {
			return null;
		}
		return self::normalize(
			array(
				'schema'  => $fields['schema'] ?? null,
				'default' => get_object_vars( $fields['default'] ),
			)
		);
	}

	/**
	 * Validate a context built in PHP against keys, types, grammars and limits.
	 *
	 * @param array<mixed> $candidate Context-shaped array.
	 * @return Context|null
	 */
	public static function normalize( array $candidate ): ?array {
		if ( array_diff( array_map( 'strval', array_keys( $candidate ) ), array( 'schema', 'default' ) ) || self::SCHEMA !== ( $candidate['schema'] ?? null ) || ! is_array( $candidate['default'] ?? null ) ) {
			return null;
		}
		$fields = $candidate['default'];
		if ( count( $fields ) > self::DEFAULT_KEYS || array_diff( array_map( 'strval', array_keys( $fields ) ), array_keys( self::FIELDS ) ) ) {
			return null;
		}
		$normalized = array();
		foreach ( self::FIELDS as $key => $grammar ) {
			if ( ! array_key_exists( $key, $fields ) ) {
				continue;
			}
			$field = $fields[ $key ];
			if ( ! is_string( $field ) || strlen( $field ) > self::SCALAR_BYTES || ! self::matches( $grammar, $field ) ) {
				return null;
			}
			$normalized[ $key ] = $field;
		}
		$context = array(
			'schema'  => self::SCHEMA,
			'default' => $normalized,
		);
		return strlen( self::encode( $context ) ) <= self::CONTEXT_BYTES ? $context : null;
	}

	/**
	 * The JSON value to send: `default` stays an object even when empty.
	 *
	 * @param array $context Normalized context.
	 * @phpstan-param Context $context
	 * @return array{schema: int, default: object}
	 */
	public static function json_value( array $context ): array {
		return array(
			'schema'  => $context['schema'],
			'default' => (object) $context['default'],
		);
	}

	/**
	 * The canonical serialization.
	 *
	 * @param array $context Normalized context.
	 * @phpstan-param Context $context
	 */
	public static function encode( array $context ): string {
		return GQ_Support_Service_Client::encode( self::json_value( $context ) );
	}

	/**
	 * The default context, read on explicit open. Versions come from this
	 * server; the screen is the launcher's coarse hint, and anything else is
	 * omitted. A value that fails validation is left out and reported.
	 *
	 * @param string $screen The launcher's screen hint, untrusted.
	 * @return array{context: Context, omitted: bool}
	 */
	public static function collect( string $screen ): array {
		$candidate = array(
			'wp_version'             => get_bloginfo( 'version' ),
			'support_plugin_version' => GQ_SUPPORT_VERSION,
		) + ( in_array( $screen, self::SCREENS, true ) ? array( 'originating_screen' => $screen ) : array() );
		// The Report context filter (#72) runs here, before every value is validated again.
		$fields = array();
		foreach ( $candidate as $key => $value ) {
			if ( null !== self::normalize(
				array(
					'schema'  => self::SCHEMA,
					'default' => array( $key => $value ),
				)
			) ) {
				$fields[ $key ] = $value;
			}
		}
		$context = self::normalize(
			array(
				'schema'  => self::SCHEMA,
				'default' => $fields,
			)
		);
		return array(
			'context' => $context ?? array(
				'schema'  => self::SCHEMA,
				'default' => array(),
			),
			'omitted' => null === $context || count( $fields ) < count( $candidate ),
		);
	}

	/**
	 * A review envelope: `v1.<payload>.<MAC>`, both base64url. The payload holds
	 * the Submission ID, the expiry and the reviewed context. The MAC also binds
	 * this installation and the Reporter subject, which the browser never sees.
	 *
	 * @param array  $context       Reviewed context.
	 * @param string $submission_id The draft's Submission ID.
	 * @param string $subject       Reporter subject.
	 * @param int    $now           Epoch seconds.
	 * @phpstan-param Context $context
	 */
	public static function envelope( array $context, string $submission_id, string $subject, int $now ): string {
		$payload = self::base64url(
			GQ_Support_Service_Client::encode(
				array(
					'sid'     => $submission_id,
					'exp'     => $now + self::REVIEW_SECONDS,
					'context' => self::json_value( $context ),
				)
			)
		);
		return 'v1.' . $payload . '.' . self::mac( $payload, $subject );
	}

	/**
	 * Whether a create may carry this context: every selected value must be the
	 * one reviewed for this Submission ID, Reporter and installation. Removing
	 * reviewed values is the Reporter's choice; adding or changing one is not.
	 *
	 * @param mixed  $review        The browser's envelope.
	 * @param array  $context       Submitted, normalized context.
	 * @param string $submission_id The create's Submission ID.
	 * @param string $subject       Reporter subject.
	 * @param int    $now           Epoch seconds.
	 * @phpstan-param Context $context
	 * @return 'valid'|'expired'|'invalid'
	 */
	public static function verify( $review, array $context, string $submission_id, string $subject, int $now ): string {
		if ( ! is_string( $review ) || strlen( $review ) > self::REVIEW_BYTES || ! preg_match( '/^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})\z/', $review, $parts )
			|| ! hash_equals( self::mac( $parts[1], $subject ), $parts[2] ) ) {
			return 'invalid';
		}
		try {
			$payload = json_decode( sodium_base642bin( $parts[1], SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING ) );
		} catch ( SodiumException $e ) {
			return 'invalid';
		}
		$reviewed = $payload instanceof stdClass ? self::parse( $payload->context ?? null ) : null;
		if ( null === $reviewed || ( $payload->sid ?? null ) !== $submission_id || ! is_int( $payload->exp ?? null ) || $reviewed['schema'] !== $context['schema'] ) {
			return 'invalid';
		}
		foreach ( $context['default'] as $key => $value ) {
			if ( ( $reviewed['default'][ $key ] ?? null ) !== $value ) {
				return 'invalid';
			}
		}
		return $now < $payload->exp ? 'valid' : 'expired';
	}

	/**
	 * `admin-ajax.php?action=gq_support_context`: the default context and its
	 * envelope, for the panel that just opened. Same session, nonce, membership
	 * and capability rules as the support routes; never contacts the service.
	 * Every refusal discloses nothing.
	 */
	public static function preview(): void {
		nocache_headers();
		if ( ! headers_sent() ) {
			header( 'Cache-Control: private, no-store' );
		}
		// Bounded input: each field is exactly its pattern, or empty. Nothing else is read.
		$input = static function ( string $name, string $pattern ): string {
			// phpcs:ignore WordPress.Security.NonceVerification.Missing, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- Validated against a strict pattern; the wp_rest nonce is verified below.
			$value = isset( $_POST[ $name ] ) && is_string( $_POST[ $name ] ) ? wp_unslash( $_POST[ $name ] ) : '';
			return preg_match( $pattern, $value ) ? $value : '';
		};
		if ( ! GQ_Support_Access::current_session( $input( 'session', '/^[a-f0-9]{64}\z/' ) ) ) {
			wp_send_json( array( 'state' => 'changed' ) );
		}
		if ( ! wp_verify_nonce( $input( 'nonce', '/^[A-Za-z0-9]{1,64}\z/' ), 'wp_rest' ) || ! GQ_Support_Access::can( 'gq_support_submit_requests' ) ) {
			wp_send_json( array( 'state' => 'forbidden' ) );
		}
		if ( GQ_Support_Fail_Safe::disabled() ) {
			wp_send_json( array( 'state' => 'disabled' ) );
		}
		$submission_id = $input( 'submission_id', '/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\z/i' );
		if ( '' === $submission_id ) {
			wp_send_json( array( 'state' => 'invalid' ) );
		}
		// Like the support routes, a site without a connection has no Reporter subject to bind.
		$subject = 'connected' === GQ_Support_State::get()['connection'] ? GQ_Support_Access::subject() : null;
		if ( ! is_string( $subject ) ) {
			wp_send_json( array( 'state' => 'unavailable' ) );
		}
		$collected = self::collect( $input( 'screen', '/^[a-z-]{1,32}\z/' ) );
		wp_send_json(
			array(
				'state'      => 'current',
				'context'    => self::json_value( $collected['context'] ),
				'review'     => self::envelope( $collected['context'], $submission_id, $subject, time() ),
				'expires_in' => self::REVIEW_SECONDS,
				'omitted'    => $collected['omitted'],
			)
		);
	}

	/**
	 * Context as export text, one labelled value per line.
	 *
	 * @param array $context Normalized context.
	 * @phpstan-param Context $context
	 */
	public static function describe( array $context ): string {
		$labels = array(
			'wp_version'             => __( 'WordPress version', 'gq-support' ),
			'support_plugin_version' => __( 'Support plugin version', 'gq-support' ),
			'originating_screen'     => __( 'Screen you opened support from', 'gq-support' ),
		);
		$lines  = array();
		foreach ( $context['default'] as $key => $value ) {
			$lines[] = $labels[ $key ] . ': ' . $value;
		}
		return implode( "\n", $lines );
	}

	/**
	 * Whether a value matches its field's grammar. `\z`, unlike `$`, refuses a trailing newline.
	 *
	 * @param string $grammar Grammar name.
	 * @param string $value   Candidate value.
	 */
	private static function matches( string $grammar, string $value ): bool {
		return 'screen' === $grammar ? in_array( $value, self::SCREENS, true ) : 1 === preg_match( '/^[0-9][A-Za-z0-9.+_-]{0,63}\z/', $value );
	}

	/**
	 * The envelope MAC, keyed by a site secret, over this installation, the subject and the payload.
	 *
	 * @param string $payload Base64url payload.
	 * @param string $subject Reporter subject.
	 */
	private static function mac( string $payload, string $subject ): string {
		$key = hash_hmac( 'sha256', 'gq-support review envelope v1', wp_salt( 'auth' ), true );
		return self::base64url( hash_hmac( 'sha256', implode( "\n", array( 'gq-support-review-v1', GQ_Support_State::get()['installation_id'], $subject, $payload ) ), $key, true ) );
	}

	/**
	 * Unpadded base64url.
	 *
	 * @param string $bytes Raw bytes.
	 */
	private static function base64url( string $bytes ): string {
		return sodium_bin2base64( $bytes, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING );
	}
}
