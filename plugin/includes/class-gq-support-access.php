<?php
/**
 * Fresh WordPress authority and installation-local Reporter identities.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** No role name or network privilege substitutes for an explicit support grant. */
final class GQ_Support_Access {

	/**
	 * Evaluate effective site grants without WordPress's Super Admin shortcut.
	 *
	 * @param string $capability Support capability.
	 */
	public static function can( string $capability ): bool {
		$user = wp_get_current_user();
		if ( ! $user->exists() || ( is_multisite() && ! is_user_member_of_blog( $user->ID, get_current_blog_id() ) ) ) {
			return false;
		}
		// WP_User::has_cap grants every primitive capability to Super Admins.
		// Require an actual site role/user grant as well as the normal capability filters.
		return ! empty( $user->allcaps[ $capability ] ) && current_user_can( $capability );
	}

	/**
	 * An opaque subject, never reused for a replacement account or another installation.
	 * Site-prefixed user metadata disappears with account deletion.
	 *
	 * @return string|WP_Error
	 */
	public static function subject() {
		global $wpdb;
		$user_id = get_current_user_id();
		$key     = $wpdb->get_blog_prefix() . 'gq_support_reporter_' . GQ_Support_State::get()['installation_id'];
		$subject = (string) get_user_meta( $user_id, $key, true );
		if ( '' !== $subject ) {
			return $subject;
		}
		// Usermeta has no unique (user_id, meta_key) index. Serialize first use
		// with a connection-owned database lock, automatically released on disconnect.
		$lock = hash( 'sha256', $wpdb->usermeta . ':' . $user_id . ':' . $key );
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- A database lock cannot be cached.
		$locked = $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, 1)', $lock ) );
		if ( '1' !== (string) $locked ) {
			return new WP_Error( 'gq_support_unavailable', __( 'Support is unavailable. Try again.', 'gq-support' ), array( 'status' => 503 ) );
		}
		try {
			// Another request may have populated metadata while this one waited.
			wp_cache_delete( $user_id, 'user_meta' );
			$subject = (string) get_user_meta( $user_id, $key, true );
			if ( '' === $subject ) {
				add_user_meta( $user_id, $key, wp_generate_uuid4(), true );
				$subject = (string) get_user_meta( $user_id, $key, true );
			}
		} finally {
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Release the connection-owned lock even on failure.
			$wpdb->get_var( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock ) );
		}
		if ( '' === $subject ) {
			return new WP_Error( 'gq_support_unavailable', __( 'Support is unavailable. Try again.', 'gq-support' ), array( 'status' => 503 ) );
		}
		return $subject;
	}

	/** Browser-safe binding to this account, login session and site; never a service credential. */
	public static function session(): string {
		return hash_hmac( 'sha256', get_current_blog_id() . ':' . get_current_user_id() . ':' . wp_get_session_token(), wp_salt( 'nonce' ) );
	}

	/**
	 * Whether a real cookie session is the one this binding names.
	 *
	 * @param string $binding The tab's session binding.
	 */
	public static function current_session( string $binding ): bool {
		return is_user_logged_in() && get_current_user_id() === wp_validate_auth_cookie( '', 'logged_in' ) && '' !== wp_get_session_token() && hash_equals( self::session(), $binding );
	}
}
