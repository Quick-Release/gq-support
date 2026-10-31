<?php
/**
 * Installed native update checks for package.sh native, run with `wp eval-file`
 * on the installed release copy, with native-update-service.php standing in for
 * the support service. Runs WordPress's real update check, Plugin_Upgrader and
 * package installer.
 *
 * @package GQ_Support
 */

$gq_support_scenario = $args[0] ?? '';
$gq_support_fail     = static function ( string $message ): void {
	// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- CLI-only diagnostic.
	throw new RuntimeException( $message );
};
$gq_support_config   = (array) get_site_option( 'native_update_test', array() );
$gq_support_calls    = (array) ( $gq_support_config['calls'] ?? array() );
$gq_support_basename = 'gq-support/gq-support.php';
// Temporary download files the updater or core left behind.
$gq_support_leftovers = static fn (): array => glob( trailingslashit( get_temp_dir() ) . 'gq-support*' ) ? glob( trailingslashit( get_temp_dir() ) . 'gq-support*' ) : array();
$gq_support_upgrade   = static function () use ( $gq_support_basename ) {
	require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
	require_once ABSPATH . 'wp-admin/includes/plugin.php';
	// Core reports a download error to its skin, not as upgrade()'s result: keep what the download filters returned.
	$download = null;
	$capture  = static function ( $reply ) use ( &$download ) {
		$download = $reply;
		return $reply;
	};
	add_filter( 'upgrader_pre_download', $capture, PHP_INT_MAX );
	$upgrader = new Plugin_Upgrader( new Automatic_Upgrader_Skin() );
	$result   = $upgrader->upgrade( $gq_support_basename );
	remove_filter( 'upgrader_pre_download', $capture, PHP_INT_MAX );
	return is_wp_error( $download ) ? $download : $result;
};

switch ( $gq_support_scenario ) {
	case 'serve':
		// The next release ZIP (relative to ABSPATH) and its version: what the service would offer.
		update_site_option(
			'native_update_test',
			array(
				'zip'     => $args[1],
				'version' => $args[2],
				'sha256'  => hash_file( 'sha256', ABSPATH . $args[1] ),
				'mode'    => 'ok',
				'calls'   => array(),
			)
		);
		delete_site_option( GQ_Support_Updater::OFFER_OPTION );
		delete_site_transient( 'update_plugins' );
		break;

	case 'mode':
		// A mode, optionally `disabled`; recorded calls start over, and with `fresh` the cached offer too.
		update_site_option(
			'native_update_test',
			array(
				'mode'     => $args[1],
				'disabled' => 'disabled' === ( $args[2] ?? '' ),
				'calls'    => array(),
			) + $gq_support_config
		);
		if ( in_array( 'fresh', $args, true ) ) {
			delete_site_option( GQ_Support_Updater::OFFER_OPTION );
			delete_site_transient( 'update_plugins' );
		}
		break;

	case 'provision':
		$gq_support_key = GQ_Support_Updater::provision( false );
		if ( ! GQ_Support_Updater::status()['provisioned'] || ! preg_match( '/^[a-f0-9]{64}$/', $gq_support_key['key_id'] ) ) {
			$gq_support_fail( 'No update key was provisioned.' );
		}
		break;

	case 'quiet':
		// Page renders, including core's own update screens, asked nothing remote.
		if ( $gq_support_calls ) {
			$gq_support_fail( 'A page render made an outgoing request: ' . implode( ', ', array_column( $gq_support_calls, 'url' ) ) );
		}
		break;

	case 'checked':
		// One signed metadata request from maintenance, in a header and without any report or broad credential.
		$gq_support_expected = $args[1] ?? 'cli';
		if ( count( $gq_support_calls ) !== 1 || GQ_Support_Service_Client::base_url() . GQ_Support_Updater::METADATA_PATH !== $gq_support_calls[0]['url']
			|| ! in_array( $gq_support_calls[0]['context'], explode( '|', $gq_support_expected ), true ) || ! $gq_support_calls[0]['key'] || '' !== $gq_support_calls[0]['grant']
			|| $gq_support_calls[0]['authorization'] || $gq_support_calls[0]['report_key'] || 0 !== $gq_support_calls[0]['redirection'] ) {
			$gq_support_fail( 'Expected one signed metadata request from ' . $gq_support_expected . ': ' . wp_json_encode( $gq_support_calls ) );
		}
		$gq_support_offer = get_site_transient( 'update_plugins' )->response[ $gq_support_basename ] ?? null;
		if ( ! $gq_support_offer || $gq_support_config['version'] !== $gq_support_offer->new_version
			|| GQ_Support_Updater::package_url( $gq_support_config['version'], $gq_support_config['sha256'] ) !== $gq_support_offer->package
			|| str_contains( (string) wp_json_encode( get_site_transient( 'update_plugins' ) ), (string) $gq_support_config['grant'] ) ) {
			$gq_support_fail( 'Core did not file the approved, credential-free offer.' );
		}
		if ( true !== apply_filters( 'auto_update_plugin', false, $gq_support_offer ) ) { // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- Core's hook.
			$gq_support_fail( 'GETQUICK\'s authorization did not enable the automatic update.' );
		}
		break;

	case 'refused':
		// Core's real upgrader, on a package the updater must not install.
		$gq_support_expected = $args[1];
		if ( 'wrong-origin' === $gq_support_expected ) {
			$gq_support_updates = get_site_transient( 'update_plugins' );
			$gq_support_updates->response[ $gq_support_basename ]->package = 'https://attacker.example/gq-support.zip';
			set_site_transient( 'update_plugins', $gq_support_updates );
			$gq_support_expected = 'gq_support_update_refused';
		}
		$gq_support_result = $gq_support_upgrade();
		$gq_support_errors = is_wp_error( $gq_support_result ) ? $gq_support_result->get_error_codes() : array();
		if ( ! in_array( $gq_support_expected, $gq_support_errors, true ) ) {
			$gq_support_fail( "Expected {$gq_support_expected}, got " . wp_json_encode( $gq_support_errors ? $gq_support_errors : $gq_support_result ) );
		}
		$gq_support_calls = (array) get_site_option( 'native_update_test' )['calls'];
		foreach ( $gq_support_calls as $gq_support_call ) {
			if ( str_contains( $gq_support_call['url'], 'attacker.example' ) || $gq_support_call['authorization'] || $gq_support_call['report_key']
				|| ( '' !== $gq_support_call['grant'] && str_contains( $gq_support_call['url'], (string) $gq_support_call['grant'] ) ) ) {
				$gq_support_fail( 'A refused update sent a request it must not: ' . wp_json_encode( $gq_support_call ) );
			}
		}
		if ( $gq_support_leftovers() ) {
			$gq_support_fail( 'A refused download left temporary files: ' . implode( ', ', $gq_support_leftovers() ) );
		}
		break;

	case 'unchanged':
		if ( GQ_SUPPORT_VERSION !== $args[1] || ! is_plugin_active( $gq_support_basename ) ) {
			$gq_support_fail( 'A refused update changed or deactivated the installed plugin.' );
		}
		break;

	case 'disconnect':
		// The report credential is gone, as after a revocation; the update key stays. Cleanup restores it.
		update_site_option(
			'native_update_test',
			array(
				'saved_key'   => get_option( GQ_Support_Signing_Key::OPTION ),
				'saved_state' => get_option( GQ_Support_State::OPTION ),
			) + $gq_support_config
		);
		GQ_Support_Signing_Key::delete();
		GQ_Support_State::update(
			array(
				'connection' => 'disconnected',
				'key_id'     => null,
			)
		);
		break;

	case 'recovering':
		// Support disabled and the report credential gone, before `wp plugin update` installs the release.
		if ( ! GQ_Support_Fail_Safe::disabled() || null !== GQ_Support_Signing_Key::active() || 'connected' === GQ_Support_State::get()['connection'] ) {
			$gq_support_fail( 'The recovery scenario needs support disabled and no report key.' );
		}
		break;

	case 'renewed':
		// The installed update's download access expired once and was renewed through signed metadata.
		$gq_support_urls = array_map( static fn ( $call ) => wp_parse_url( $call['url'], PHP_URL_PATH ), $gq_support_calls );
		// Download, refused for expired access, renewed by metadata, downloaded again.
		$gq_support_route = array( GQ_Support_Updater::PACKAGE_PATH, GQ_Support_Updater::METADATA_PATH, GQ_Support_Updater::PACKAGE_PATH );
		if ( array_slice( $gq_support_urls, -3 ) !== $gq_support_route ) {
			$gq_support_fail( 'Expected the expired download to renew through metadata: ' . wp_json_encode( $gq_support_urls ) );
		}
		if ( $gq_support_leftovers() ) {
			$gq_support_fail( 'The installed update left temporary files: ' . implode( ', ', $gq_support_leftovers() ) );
		}
		break;

	case 'upgraded':
		// A new process: the installed files are the approved release's.
		if ( GQ_SUPPORT_VERSION !== $args[1] || hash_file( 'sha256', GQ_SUPPORT_PLUGIN_FILE ) !== $args[2] ) {
			$gq_support_fail( 'The running plugin is not the approved package.' );
		}
		if ( is_link( WP_PLUGIN_DIR . '/gq-support' ) || ! is_plugin_active( $gq_support_basename ) ) {
			$gq_support_fail( 'The update did not leave the installed copy active.' );
		}
		if ( ! GQ_Support_Updater::status()['provisioned'] ) {
			$gq_support_fail( 'The update lost the update key.' );
		}
		break;

	case 'cleanup':
		if ( isset( $gq_support_config['saved_state'] ) ) {
			update_option( GQ_Support_State::OPTION, $gq_support_config['saved_state'], false );
			if ( false !== $gq_support_config['saved_key'] ) {
				update_option( GQ_Support_Signing_Key::OPTION, $gq_support_config['saved_key'], false );
			}
		}
		delete_site_option( 'native_update_test' );
		delete_site_option( GQ_Support_Updater::OFFER_OPTION );
		delete_site_option( GQ_Support_Updater::KEY_OPTION );
		delete_site_transient( 'update_plugins' );
		break;

	default:
		$gq_support_fail( 'Unknown native update scenario.' );
}

WP_CLI::success( $gq_support_scenario );
