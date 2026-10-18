<?php
/**
 * WordPress privacy tools: personal data export and erasure, deleted users
 * and the privacy-guide text (docs/support-privacy-design.md).
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Maps an email address to this site's Reporter subject and asks the service,
 * which scopes every call to the verified installation's Slot. The email
 * address never leaves WordPress.
 */
final class GQ_Support_Privacy {

	/** One retry of a deleted user's erasure, scheduled when the first call fails. Hooked by GQ_Support_Plugin. */
	public const RETRY_HOOK = 'gq_support_retry_erasure';

	/** Erasures this site recorded, listed until an Operator closes them. */
	public const ERASURES_OPTION = 'gq_support_erasures';

	private const GROUP = 'gq-support-requests';

	/*
	 * GQ_Support_Plugin::register_privacy() hooks these methods, loading this class on first use.
	 */

	/**
	 * Add the support exporter.
	 *
	 * @param array<string, array<string, mixed>> $exporters Registered exporters.
	 * @return array<string, array<string, mixed>>
	 */
	public static function register_exporter( array $exporters ): array {
		$exporters['gq-support'] = array(
			'exporter_friendly_name' => __( 'GETQUICK Support requests', 'gq-support' ),
			'callback'               => array( __CLASS__, 'export' ),
		);
		return $exporters;
	}

	/**
	 * Add the support eraser.
	 *
	 * @param array<string, array<string, mixed>> $erasers Registered erasers.
	 * @return array<string, array<string, mixed>>
	 */
	public static function register_eraser( array $erasers ): array {
		$erasers['gq-support'] = array(
			'eraser_friendly_name' => __( 'GETQUICK Support requests', 'gq-support' ),
			'callback'             => array( __CLASS__, 'erase' ),
		);
		return $erasers;
	}

	/**
	 * One page of the Reporter's own Support requests on this site. A user who
	 * never submitted gets "no data" without a service call.
	 *
	 * @param string $email WordPress privacy request email address.
	 * @param int    $page  1-based page.
	 * @return array{data: array<int, array<string, mixed>>, done: bool}|WP_Error
	 */
	public static function export( string $email, int $page = 1 ) {
		$subject = self::subject_for( $email );
		if ( null === $subject ) {
			return array(
				'data' => array(),
				'done' => true,
			);
		}
		// The service cursor for this page, left by the previous one.
		$cursor_key = 'gq_support_export_' . hash( 'sha256', $subject . ':' . $page );
		$cursor     = $page > 1 ? get_transient( $cursor_key ) : '';
		if ( false === $cursor ) {
			return new WP_Error( 'gq_support_export_expired', __( 'The support export expired. Start the export again.', 'gq-support' ) );
		}
		$query  = array( 'reporter_subject' => $subject ) + ( '' === $cursor ? array() : array( 'cursor' => $cursor ) );
		$result = self::send( 'GET', '/v1/export?' . http_build_query( $query, '', '&', PHP_QUERY_RFC3986 ), null );
		if ( is_wp_error( $result ) || 200 !== $result['status'] || ! isset( $result['body']['items'] ) || ! is_array( $result['body']['items'] ) ) {
			return new WP_Error( 'gq_support_unavailable', __( 'The support service is unavailable. Try the export again.', 'gq-support' ) );
		}
		$next = $result['body']['next_cursor'] ?? null;
		if ( is_string( $next ) ) {
			set_transient( 'gq_support_export_' . hash( 'sha256', $subject . ':' . ( $page + 1 ) ), $next, 10 * MINUTE_IN_SECONDS );
		}
		$data = array();
		foreach ( $result['body']['items'] as $item ) {
			if ( ! is_array( $item ) || ! isset( $item['id'] ) || ! is_string( $item['id'] ) ) {
				continue;
			}
			$fields = array(
				__( 'Request ID', 'gq-support' )     => $item['id'],
				__( 'Summary', 'gq-support' )        => $item['summary'] ?? '',
				__( 'Description', 'gq-support' )    => $item['description'] ?? '',
				__( 'Submitted', 'gq-support' )      => $item['created_at'] ?? '',
				__( 'Delivery', 'gq-support' )       => $item['delivery'] ?? '',
				__( 'Support status', 'gq-support' ) => $item['status'] ?? '',
			);
			$data[] = array(
				'group_id'    => self::GROUP,
				'group_label' => __( 'Support requests', 'gq-support' ),
				'item_id'     => 'gq-support-' . $item['id'],
				'data'        => array_map(
					static fn ( string $name, $value ): array => array(
						'name'  => $name,
						'value' => is_scalar( $value ) ? (string) $value : '',
					),
					array_keys( $fields ),
					array_values( $fields )
				),
			);
		}
		return array(
			'data' => $data,
			'done' => ! is_string( $next ),
		);
	}

	/**
	 * Record an erasure for the Reporter. Never reports complete while the
	 * service is still working, needs review, or could not be reached.
	 *
	 * @param string $email WordPress privacy request email address.
	 * @param int    $page  1-based page; the service handles the whole erasure at once.
	 * @return array{items_removed: bool, items_retained: bool, messages: array<int, string>, done: bool}|WP_Error
	 */
	public static function erase( string $email, int $page = 1 ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter.FoundAfterLastUsed -- WordPress eraser signature.
		$subject = self::subject_for( $email );
		if ( null === $subject ) {
			return array(
				'items_removed'  => false,
				'items_retained' => false,
				'messages'       => array(),
				'done'           => true,
			);
		}
		$status = self::record_erasure( $subject );
		if ( null === $status ) {
			return new WP_Error( 'gq_support_unavailable', __( 'The support service could not record the erasure. Nothing was recorded; try again.', 'gq-support' ) );
		}
		$counts  = is_array( $status['counts'] ?? null ) ? $status['counts'] : array();
		$removed = (int) ( $counts['purged'] ?? 0 ) + (int) ( $counts['redacted'] ?? 0 ) + (int) ( $counts['pending'] ?? 0 ) > 0;
		$state   = $status['state'] ?? '';
		if ( 'completed' === $state || 'closed' === $state ) {
			return array(
				'items_removed'  => $removed,
				'items_retained' => false,
				'messages'       => array(),
				'done'           => true,
			);
		}
		return array(
			'items_removed'  => $removed,
			'items_retained' => true,
			'messages'       => array(
				'needs_review' === $state
					? __( 'Support request text was erased. Some copies need review by GETQUICK, such as earlier versions kept in GitHub; the Support settings page shows the erasure until it is closed.', 'gq-support' )
					: __( 'Support request erasure is continuing. The Support settings page shows its progress.', 'gq-support' ),
			),
			'done'           => true,
		);
	}

	/**
	 * Read the subject before WordPress deletes the user and its metadata. On
	 * multisite this action only removes the user from one site, who may be
	 * added back, so it erases nothing: network deletion does.
	 *
	 * @param int $user_id User being deleted from this site.
	 */
	public static function erase_deleted_user( int $user_id ): void {
		if ( ! is_multisite() ) {
			self::erase_subject_of( $user_id );
		}
	}

	/**
	 * Erase this site's subject for the user, retrying once later if the service cannot record it now.
	 * A disconnected site has nothing to call; its records stay under retention.
	 *
	 * @param int $user_id User about to be deleted.
	 */
	private static function erase_subject_of( int $user_id ): void {
		$subject = self::subject_of( $user_id );
		if ( null !== $subject && 'connected' === GQ_Support_State::get()['connection'] && null === self::record_erasure( $subject ) ) {
			self::schedule_retry( $subject );
		}
	}

	/**
	 * A network deletion removes the user from every site: erase on each site with a connected installation.
	 *
	 * @param int $user_id User being deleted from the network.
	 */
	public static function erase_deleted_network_user( int $user_id ): void {
		foreach ( array_keys( get_blogs_of_user( $user_id ) ) as $blog_id ) {
			switch_to_blog( (int) $blog_id );
			try {
				self::erase_subject_of( $user_id );
			} finally {
				restore_current_blog();
			}
		}
	}

	/**
	 * The one retry of a failed deleted-user erasure. After it, the records fall under retention.
	 *
	 * @param string $subject Reporter subject read before deletion.
	 * @param int    $blog_id Site whose installation recorded it.
	 */
	public static function retry_erasure( string $subject, int $blog_id = 0 ): void {
		$switched = $blog_id > 0 && is_multisite() && get_current_blog_id() !== $blog_id;
		if ( $switched ) {
			switch_to_blog( $blog_id );
		}
		try {
			self::record_erasure( $subject );
		} finally {
			if ( $switched ) {
				restore_current_blog();
			}
		}
	}

	/** Suggested privacy-guide text, for the site owner to adapt. */
	public static function add_policy_content(): void {
		if ( ! function_exists( 'wp_add_privacy_policy_content' ) ) {
			return;
		}
		$content  = '<p class="privacy-policy-tutorial">' . esc_html__( 'Suggested text for your privacy policy. Adapt it to your agreement with GETQUICK; it is not legal advice.', 'gq-support' ) . '</p>';
		$content .= '<p>' . esc_html__( 'When you send a support request from this site\'s admin area, the summary and description you write are sent to our support provider, GETQUICK, which stores them on Cloudflare (database in the EU) and creates an issue in this project\'s private GitHub repository so that the development team can work on it. Your name, email address and username are not sent. The request is linked to you through a random identifier that is kept on this site. GitHub may email notifications of new issues to members of the development team.', 'gq-support' ) . '</p>';
		$content .= '<p>' . esc_html__( 'Support requests are kept by GETQUICK for 12 months after they are closed; requests that never reached GitHub are kept for at most 12 months. The issue in GitHub stays part of this project\'s engineering history. If you ask this site to erase your personal data, your requests are deleted from GETQUICK\'s service and the text of your requests is removed from the GitHub issues, including older issues found by their pseudonymous reference. Copies that cannot be removed automatically, such as notification emails and earlier versions kept in GitHub\'s edit history, are reviewed and deleted by hand where possible.', 'gq-support' ) . '</p>';
		wp_add_privacy_policy_content( __( 'GETQUICK Support', 'gq-support' ), wp_kses_post( $content ) );
	}

	/**
	 * This site's Reporter subject for the user with that email, if any.
	 *
	 * @param string $email Email address from the privacy request.
	 */
	private static function subject_for( string $email ): ?string {
		$user = get_user_by( 'email', $email );
		return $user instanceof WP_User ? self::subject_of( $user->ID ) : null;
	}

	/**
	 * The subject stored for this site's installation, without creating one.
	 *
	 * @param int $user_id WordPress user ID.
	 */
	private static function subject_of( int $user_id ): ?string {
		global $wpdb;
		$subject = (string) get_user_meta( $user_id, $wpdb->get_blog_prefix() . 'gq_support_reporter_' . GQ_Support_State::get()['installation_id'], true );
		return '' === $subject ? null : $subject;
	}

	/**
	 * Ask the service to erase the subject's records, and remember the erasure.
	 *
	 * @param string $subject Reporter subject.
	 * @return array<string, mixed>|null The erasure's status, or null when nothing was recorded.
	 */
	private static function record_erasure( string $subject ): ?array {
		$result = self::send( 'POST', '/v1/erasures', array( 'reporter_subject' => $subject ) );
		if ( is_wp_error( $result ) || 202 !== $result['status'] || ! isset( $result['body']['id'] ) || ! is_string( $result['body']['id'] ) ) {
			return null;
		}
		$erasures = get_option( self::ERASURES_OPTION, array() );
		$erasures = is_array( $erasures ) ? $erasures : array();
		if ( ! in_array( $result['body']['id'], $erasures, true ) ) {
			$erasures[] = $result['body']['id'];
			update_option( self::ERASURES_OPTION, $erasures, false );
		}
		return $result['body'];
	}

	/**
	 * Retry once, on this site, from cron.
	 *
	 * @param string $subject Reporter subject read before deletion.
	 */
	private static function schedule_retry( string $subject ): void {
		$args = array( $subject, get_current_blog_id() );
		if ( ! wp_next_scheduled( self::RETRY_HOOK, $args ) ) {
			wp_schedule_single_event( time() + 5 * MINUTE_IN_SECONDS, self::RETRY_HOOK, $args );
		}
	}

	/**
	 * One signed call as this installation, or an error when it is not connected.
	 *
	 * @param string                    $method  HTTP method.
	 * @param string                    $path    Worker path.
	 * @param array<string, mixed>|null $payload JSON body.
	 * @return array{status: int, body: array<string, mixed>, retry_after: string}|WP_Error
	 */
	private static function send( string $method, string $path, ?array $payload ) {
		$state  = GQ_Support_State::get();
		$secret = GQ_Support_Signing_Key::active();
		$key_id = GQ_Support_State::key_id( $state );
		if ( 'connected' !== $state['connection'] || null === $secret || '' === $key_id ) {
			return new WP_Error( 'gq_support_not_configured', 'Support is not connected.' );
		}
		return GQ_Support_Service_Client::request( $method, $path, $payload, new GQ_Support_Signer( $secret, $key_id, $state['installation_id'] ), 8 );
	}
}
