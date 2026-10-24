<?php
/**
 * The Operator's local support fail-safe and independent help contact
 * (docs/research/outage-draft-recovery.md, "Independent help and support fail-safe").
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Reads `wp-config.php` constants on every use. Nothing here is stored, fetched or cached.
 */
final class GQ_Support_Fail_Safe {

	/** Longest accepted contact URL, in bytes. */
	private const URL_BYTES = 2048;

	/** Longest accepted contact label, in characters. */
	private const LABEL_CHARACTERS = 120;

	/**
	 * Whether `GQ_SUPPORT_DISABLED` turns support off: no launcher or app assets
	 * and no service request. Credentials, local state and accepted work stay as they are.
	 */
	public static function disabled(): bool {
		return defined( 'GQ_SUPPORT_DISABLED' ) && true === filter_var( constant( 'GQ_SUPPORT_DISABLED' ), FILTER_VALIDATE_BOOLEAN );
	}

	/**
	 * Whether the Operator set a help contact at all, valid or not.
	 */
	public static function help_configured(): bool {
		return defined( 'GQ_SUPPORT_HELP_URL' );
	}

	/**
	 * The Operator-verified contact from `GQ_SUPPORT_HELP_URL` and `GQ_SUPPORT_HELP_LABEL`, if valid.
	 *
	 * @return array{url: string, label: string}|null
	 */
	public static function help(): ?array {
		return self::contact(
			defined( 'GQ_SUPPORT_HELP_URL' ) ? constant( 'GQ_SUPPORT_HELP_URL' ) : null,
			defined( 'GQ_SUPPORT_HELP_LABEL' ) ? constant( 'GQ_SUPPORT_HELP_LABEL' ) : null
		);
	}

	/**
	 * Validate a contact: an HTTPS page, `mailto:` address or `tel:` number with
	 * nothing prefilled (no query string) and no credentials. Without a label,
	 * the address, number or host names it.
	 *
	 * @param mixed $url   Contact URL.
	 * @param mixed $label Link text.
	 * @return array{url: string, label: string}|null
	 */
	public static function contact( $url, $label ): ?array {
		if ( ! is_string( $url ) || '' === $url || strlen( $url ) > self::URL_BYTES || preg_match( '/[\x00-\x20\x7f?]/', $url ) ) {
			return null;
		}
		if ( preg_match( '/^mailto:([^@\/#]+@[^@\/#]+\.[^@\/#]+)$/i', $url, $match ) || preg_match( '/^tel:(\+?[0-9][0-9().-]*)$/i', $url, $match ) ) {
			$name = $match[1];
		} else {
			$parts = wp_parse_url( $url );
			if ( ! is_array( $parts ) || 'https' !== strtolower( $parts['scheme'] ?? '' ) || empty( $parts['host'] ) || isset( $parts['user'] ) || isset( $parts['pass'] ) ) {
				return null;
			}
			$name = $parts['host'];
		}
		if ( null !== $label && ( ! is_string( $label ) || preg_match( '/[\x00-\x1f\x7f]/', $label ) || mb_strlen( trim( $label ) ) > self::LABEL_CHARACTERS ) ) {
			return null;
		}
		$label = null === $label ? '' : trim( $label );
		return array(
			'url'   => $url,
			'label' => '' === $label ? $name : $label,
		);
	}

	/**
	 * Print "For help, contact:" and the link, for Reporters whose support panel is unavailable.
	 *
	 * @param array{url: string, label: string} $help A valid contact.
	 */
	public static function render_contact( array $help ): void {
		echo esc_html__( 'For help, contact:', 'gq-support' ) . ' ';
		self::render_link( $help );
	}

	/**
	 * Print the contact as a plain link, for pages whose support assets did not or may not load.
	 *
	 * @param array{url: string, label: string} $help A valid contact.
	 */
	public static function render_link( array $help ): void {
		printf(
			'<a href="%1$s"%2$s>%3$s</a>',
			esc_url( $help['url'], array( 'https', 'mailto', 'tel' ) ),
			// A new tab keeps this page, and any draft in it, open.
			str_starts_with( strtolower( $help['url'] ), 'https:' ) ? ' target="_blank" rel="noopener noreferrer"' : '',
			esc_html( $help['label'] )
		);
	}
}
