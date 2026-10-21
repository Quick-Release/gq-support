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

	/**
	 * Erasures this site recorded, with their last known state, listed until an
	 * Operator closes them with no remote outcome left unresolved.
	 */
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
			// Context the service still holds: the Reporter's projection never shows it, but export does.
			$context = is_array( $item['context'] ?? null ) ? GQ_Support_Report_Context::normalize( $item['context'] ) : null;
			if ( null !== $context && array() !== $context['default'] ) {
				$fields[ __( 'Report context', 'gq-support' ) ] = GQ_Support_Report_Context::describe( $context );
			}
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
	 * service is still working, needs review or could not be reached, nor
	 * reports nothing retained while a residual copy is known, even once an
	 * Operator has closed the erasure.
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
			return new WP_Error( 'gq_support_unavailable', __( 'The support service could not record the erasure. Try again.', 'gq-support' ) );
		}
		$counts  = is_array( $status['counts'] ?? null ) ? $status['counts'] : array();
		$removed = (int) ( $counts['purged'] ?? 0 ) + (int) ( $counts['redacted'] ?? 0 ) + (int) ( $counts['pending'] ?? 0 ) > 0;
		$state   = $status['state'] ?? '';
		if ( 'completed' === $state || ( 'closed' === $state && array() === self::residual( $status ) ) ) {
			return array(
				'items_removed'  => $removed,
				'items_retained' => false,
				'messages'       => array(),
				'done'           => true,
			);
		}
		if ( 'closed' === $state && self::unresolved( $status ) ) {
			$message = __( 'Support request text was erased, but GETQUICK could not confirm whether a copy reached GitHub, so the erasure is incomplete. The Support settings page shows it.', 'gq-support' );
		} elseif ( 'closed' === $state ) {
			$message = __( 'Support request text was erased. GETQUICK has reviewed the copies that could not be removed automatically, such as earlier versions kept in GitHub.', 'gq-support' );
		} elseif ( 'needs_review' === $state ) {
			$message = __( 'Support request text was erased. Some copies need review by GETQUICK, such as earlier versions kept in GitHub; the Support settings page shows the erasure until it is closed.', 'gq-support' );
		} else {
			$message = __( 'Support request erasure is continuing. The Support settings page shows its progress.', 'gq-support' );
		}
		return array(
			'items_removed'  => $removed,
			'items_retained' => true,
			'messages'       => array( $message ),
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
		$content .= '<p>' . esc_html__( 'Unless you remove them before sending, your request also includes the WordPress version, the support plugin version, and the kind of admin screen you opened support from (the dashboard, the posts list, the post editor or WooCommerce). These appear in the GitHub issue, not in your list of requests on this site. GETQUICK deletes its copy once the request reaches GitHub or fails. The address of the page you were on is never sent.', 'gq-support' ) . '</p>';
		$content .= '<p>' . esc_html__( 'Support requests are kept by GETQUICK for 12 months after they are closed; requests that never reached GitHub are kept for at most 12 months. The issue in GitHub stays part of this project\'s engineering history. If you ask this site to erase your personal data, your requests are deleted from GETQUICK\'s service and the text of your requests and the information sent with them are removed from the GitHub issues, including older issues found by their pseudonymous reference. Copies that cannot be removed automatically, such as notification emails and earlier versions kept in GitHub\'s edit history, are reviewed and deleted by hand where possible.', 'gq-support' ) . '</p>';
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
		$erasures                          = self::erasures();
		$erasures[ $result['body']['id'] ] = self::listed( $result['body'] );
		update_option( self::ERASURES_OPTION, $erasures, false );
		return $result['body'];
	}

	/**
	 * The residual-copy kinds an erasure status reports.
	 *
	 * @param array<string, mixed> $status The service's erasure status.
	 * @return array<int|string, mixed>
	 */
	private static function residual( array $status ): array {
		return is_array( $status['residual'] ?? null ) ? $status['residual'] : array();
	}

	/**
	 * Whether a possible GitHub copy is still unresolved: the erasure stays
	 * incomplete even after an Operator closes it.
	 *
	 * @param array<string, mixed> $status The service's erasure status.
	 */
	private static function unresolved( array $status ): bool {
		return in_array( 'remote_outcome', self::residual( $status ), true );
	}

	/**
	 * The listed form of an erasure status; one without a state is still in progress.
	 *
	 * @param array<string, mixed> $status The service's erasure status.
	 * @return array{state: string, checked_at: int, unresolved: bool}
	 */
	private static function listed( array $status ): array {
		return array(
			'state'      => is_string( $status['state'] ?? null ) ? $status['state'] : 'in_progress',
			'checked_at' => time(),
			'unresolved' => self::unresolved( $status ),
		);
	}

	/**
	 * This site's open erasures and their last known state, by erasure ID.
	 *
	 * @return array<string, array{state: string, checked_at: int, unresolved: bool}>
	 */
	public static function erasures(): array {
		$stored   = get_option( self::ERASURES_OPTION, array() );
		$erasures = array();
		foreach ( is_array( $stored ) ? $stored : array() as $id => $erasure ) {
			if ( is_string( $id ) && preg_match( '/^era_[0-9A-HJKMNP-TV-Z]{26}$/', $id ) && is_array( $erasure ) ) {
				$erasures[ $id ] = array(
					'state'      => (string) ( $erasure['state'] ?? '' ),
					'checked_at' => (int) ( $erasure['checked_at'] ?? 0 ),
					'unresolved' => ! empty( $erasure['unresolved'] ),
				);
			}
		}
		return $erasures;
	}

	/**
	 * Ask the service for each open erasure's state, on a site admin's request.
	 * A no longer known erasure leaves the list, as does a closed one with no
	 * unresolved remote outcome. An unexpected reply keeps the last known state.
	 *
	 * @return bool Whether the service answered for every erasure.
	 */
	public static function refresh_erasures(): bool {
		$answers  = array();
		$complete = true;
		foreach ( array_keys( self::erasures() ) as $id ) {
			$result = self::send( 'GET', '/v1/erasures/' . $id, null );
			if ( ! is_wp_error( $result ) && 404 === $result['status'] ) {
				$answers[ $id ] = null;
			} elseif ( ! is_wp_error( $result ) && 200 === $result['status'] && is_string( $result['body']['state'] ?? null ) ) {
				$closed         = 'closed' === $result['body']['state'] && ! self::unresolved( $result['body'] );
				$answers[ $id ] = $closed ? null : self::listed( $result['body'] );
			} else {
				$complete = false;
			}
		}
		// Read again, so an erasure recorded during the calls is kept.
		$erasures = self::erasures();
		foreach ( $answers as $id => $answer ) {
			if ( null === $answer ) {
				unset( $erasures[ $id ] );
			} elseif ( isset( $erasures[ $id ] ) ) {
				$erasures[ $id ] = $answer;
			}
		}
		update_option( self::ERASURES_OPTION, $erasures, false );
		return $complete;
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
