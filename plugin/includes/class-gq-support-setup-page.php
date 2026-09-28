<?php
/**
 * The `GETQUICK → Support` setup page.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Shows the redacted connection state and runs enroll, test and disconnect
 * through `admin-post.php`. Everything is gated by `gq_support_manage_settings`.
 */
final class GQ_Support_Setup_Page {

	private const SLUG = 'gq-support';

	/** GETQUICK Config's top-level menu. */
	private const GETQUICK_MENU = 'getquick-options';

	private const ACTIONS = array( 'enroll', 'test', 'disconnect' );

	/**
	 * Register the page and its handlers.
	 */
	public static function register(): void {
		// After GETQUICK Design's Design (20) and Elements (21) entries.
		add_action( 'admin_menu', array( __CLASS__, 'add_page' ), 22 );
		foreach ( self::ACTIONS as $action ) {
			add_action( "admin_post_gq_support_{$action}", array( __CLASS__, "handle_{$action}" ) );
		}
	}

	/**
	 * Under GETQUICK when GETQUICK Config provides the menu, otherwise under Settings.
	 */
	public static function add_page(): void {
		global $admin_page_hooks;

		$title = __( 'Support', 'gq-support' );
		if ( isset( $admin_page_hooks[ self::GETQUICK_MENU ] ) ) {
			add_submenu_page( self::GETQUICK_MENU, $title, $title, 'gq_support_manage_settings', self::SLUG, array( __CLASS__, 'render' ), 2 );
		} else {
			add_options_page( __( 'GETQUICK Support', 'gq-support' ), __( 'GETQUICK Support', 'gq-support' ), 'gq_support_manage_settings', self::SLUG, array( __CLASS__, 'render' ) );
		}
	}

	/**
	 * Render the page.
	 */
	public static function render(): void {
		if ( ! current_user_can( 'gq_support_manage_settings' ) ) {
			wp_die( esc_html__( 'Sorry, you are not allowed to manage GETQUICK Support.', 'gq-support' ), 403 );
		}

		$status    = GQ_Support_Connection::status();
		$connected = GQ_Support_State::holds_credential( $status );
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Display-only message key set by our own redirect.
		$notice = isset( $_GET['gq_support_notice'] ) ? sanitize_key( wp_unslash( $_GET['gq_support_notice'] ) ) : '';
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'GETQUICK Support', 'gq-support' ); ?></h1>
			<?php self::render_notice( $notice ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><?php esc_html_e( 'Connection', 'gq-support' ); ?></th>
					<td><?php echo esc_html( self::connection_label( $status['connection'] ) ); ?></td>
				</tr>
				<?php if ( $status['managed'] ) : ?>
					<tr>
						<th scope="row"><?php esc_html_e( 'Signing key', 'gq-support' ); ?></th>
						<td><?php esc_html_e( 'Managed by server configuration', 'gq-support' ); ?></td>
					</tr>
				<?php endif; ?>
				<?php if ( $connected ) : ?>
					<tr>
						<th scope="row"><?php esc_html_e( 'Environment', 'gq-support' ); ?></th>
						<td>
							<?php echo esc_html( (string) $status['environment'] ); ?>
							<?php if ( $status['environment_mismatch'] ) : ?>
								<p class="description">
									<?php
									/* translators: %s: the environment type WordPress reports, e.g. "production". */
									echo esc_html( sprintf( __( 'This site reports the "%s" environment. Ask GETQUICK to check that the connection is for the right environment.', 'gq-support' ), wp_get_environment_type() ) );
									?>
								</p>
							<?php endif; ?>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Connected', 'gq-support' ); ?></th>
						<td><?php echo esc_html( (string) $status['connected_at'] ); ?></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Key fingerprint', 'gq-support' ); ?></th>
						<td><code><?php echo esc_html( (string) $status['fingerprint'] ); ?></code></td>
					</tr>
					<?php if ( null !== $status['last_test'] ) : ?>
						<tr>
							<th scope="row"><?php esc_html_e( 'Last test', 'gq-support' ); ?></th>
							<td>
								<?php
								echo esc_html(
									sprintf(
										/* translators: 1: test result, 2: how long ago the test ran. */
										__( '%1$s, %2$s ago', 'gq-support' ),
										self::test_label( $status['last_test']['result'] ),
										human_time_diff( $status['last_test']['at'] )
									)
								);
								?>
							</td>
						</tr>
					<?php endif; ?>
				<?php endif; ?>
			</table>

			<?php if ( 'connected' !== $status['connection'] ) : ?>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<input type="hidden" name="action" value="gq_support_enroll" />
					<?php wp_nonce_field( 'gq_support_enroll' ); ?>
					<p>
						<label for="gq-support-code"><?php esc_html_e( 'Enrollment code', 'gq-support' ); ?></label><br />
						<input type="text" id="gq-support-code" name="code" class="regular-text code" autocomplete="off" spellcheck="false" required />
					</p>
					<p class="description"><?php esc_html_e( 'GETQUICK gives you a single-use code that is valid for 30 minutes.', 'gq-support' ); ?></p>
					<?php submit_button( __( 'Connect', 'gq-support' ) ); ?>
				</form>
			<?php endif; ?>

			<?php if ( $connected ) : ?>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block">
					<input type="hidden" name="action" value="gq_support_test" />
					<?php wp_nonce_field( 'gq_support_test' ); ?>
					<?php submit_button( __( 'Test connection', 'gq-support' ), 'secondary', 'submit', false ); ?>
				</form>
				<?php if ( ! $status['managed'] ) : ?>
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block">
						<input type="hidden" name="action" value="gq_support_disconnect" />
						<?php wp_nonce_field( 'gq_support_disconnect' ); ?>
						<?php submit_button( __( 'Disconnect', 'gq-support' ), 'delete', 'submit', false ); ?>
					</form>
				<?php endif; ?>
			<?php endif; ?>
		</div>
		<?php
	}

	/**
	 * Exchange an Enrollment code.
	 */
	public static function handle_enroll(): void {
		self::authorize( 'enroll' );
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- Verified in authorize().
		$code   = isset( $_POST['code'] ) ? sanitize_text_field( wp_unslash( $_POST['code'] ) ) : '';
		$result = GQ_Support_Connection::enroll( $code );
		if ( is_wp_error( $result ) ) {
			$notices = array(
				'gq_support_code_not_valid' => 'code_not_valid',
				'gq_support_rate_limited'   => 'rate_limited',
			);
			self::redirect( $notices[ $result->get_error_code() ] ?? 'unreachable' );
		}
		self::redirect( $result['environment_mismatch'] ? 'connected_mismatch' : 'connected' );
	}

	/**
	 * Test the connection.
	 */
	public static function handle_test(): void {
		self::authorize( 'test' );
		$result = GQ_Support_Connection::test();
		self::redirect( is_wp_error( $result ) ? 'not_connected' : 'tested' );
	}

	/**
	 * Disconnect this site.
	 */
	public static function handle_disconnect(): void {
		self::authorize( 'disconnect' );
		$result = GQ_Support_Connection::disconnect();
		if ( is_wp_error( $result ) ) {
			self::redirect( 'managed' );
		}
		self::redirect( $result['revoked'] ? 'disconnected' : 'disconnected_unrevoked' );
	}

	/**
	 * Only site admins with the capability, and only with this form's nonce.
	 *
	 * @param string $action The handler's action.
	 */
	private static function authorize( string $action ): void {
		if ( ! current_user_can( 'gq_support_manage_settings' ) ) {
			wp_die( esc_html__( 'Sorry, you are not allowed to manage GETQUICK Support.', 'gq-support' ), 403 );
		}
		check_admin_referer( "gq_support_{$action}" );
		GQ_Support_Lifecycle::ensure_site();
	}

	/**
	 * Back to the page with a message key. The key carries no data.
	 *
	 * @param string $notice A key from `render_notice()`.
	 * @return never
	 */
	private static function redirect( string $notice ): void {
		wp_safe_redirect( add_query_arg( 'gq_support_notice', $notice, admin_url( 'admin.php?page=' . self::SLUG ) ) );
		exit;
	}

	/**
	 * The message for a handler's result.
	 *
	 * @param string $notice A message key.
	 */
	private static function render_notice( string $notice ): void {
		$messages = array(
			'connected'              => array( 'success', __( 'Connected. Reporters on this site can now send Support requests.', 'gq-support' ) ),
			'connected_mismatch'     => array( 'warning', __( 'Connected, but the environment differs from the one this site reports.', 'gq-support' ) ),
			'code_not_valid'         => array( 'error', __( 'This Enrollment code is not valid. Ask GETQUICK for a new one.', 'gq-support' ) ),
			'rate_limited'           => array( 'error', __( 'Too many attempts. Wait a few minutes and try again.', 'gq-support' ) ),
			'unreachable'            => array( 'error', __( 'The support service could not be reached. Try again.', 'gq-support' ) ),
			'tested'                 => array( 'info', __( 'Connection tested.', 'gq-support' ) ),
			'not_connected'          => array( 'error', __( 'This site is not connected.', 'gq-support' ) ),
			'disconnected'           => array( 'success', __( 'Disconnected. Reconnecting needs a new Enrollment code.', 'gq-support' ) ),
			'disconnected_unrevoked' => array( 'warning', __( 'Disconnected locally, but the service could not be told. Ask GETQUICK to revoke this site\'s key.', 'gq-support' ) ),
			'managed'                => array( 'error', __( 'This connection is managed by server configuration.', 'gq-support' ) ),
		);
		if ( ! isset( $messages[ $notice ] ) ) {
			return;
		}
		[ $type, $message ] = $messages[ $notice ];
		printf( '<div class="notice notice-%1$s"><p>%2$s</p></div>', esc_attr( $type ), esc_html( $message ) );
	}

	/**
	 * A connection state for people.
	 *
	 * @param string $connection The stored state.
	 */
	private static function connection_label( string $connection ): string {
		switch ( $connection ) {
			case 'connected':
				return __( 'Connected', 'gq-support' );
			case 'copied_or_moved':
				return __( 'Disconnected: this site was copied or moved. Ask GETQUICK to reconnect.', 'gq-support' );
			case 'rejected':
				return __( 'Rejected by service', 'gq-support' );
			default:
				return __( 'Not connected', 'gq-support' );
		}
	}

	/**
	 * A test result for people.
	 *
	 * @param string $result The stored result.
	 */
	private static function test_label( string $result ): string {
		switch ( $result ) {
			case 'ok':
				return __( 'Working', 'gq-support' );
			case 'suspended':
				return __( 'Suspended by the service', 'gq-support' );
			case 'rejected':
				return __( 'Rejected by service', 'gq-support' );
			default:
				return __( 'Service unreachable', 'gq-support' );
		}
	}
}
