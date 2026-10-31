<?php
/**
 * `wp gq-support` commands. Loaded only under WP-CLI.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Connects this site to GETQUICK Support. On multisite, pass `--url` for each site.
 */
final class GQ_Support_CLI {

	/**
	 * Connect this site with an Enrollment code from GETQUICK.
	 *
	 * ## OPTIONS
	 *
	 * <code>
	 * : The single-use Enrollment code.
	 *
	 * @param array<int, string> $args Positional arguments.
	 */
	public function connect( array $args ): void {
		$result = GQ_Support_Connection::enroll( $args[0] );
		if ( is_wp_error( $result ) ) {
			WP_CLI::error( $result->get_error_message() );
		}
		if ( $result['environment_mismatch'] ) {
			WP_CLI::warning( sprintf( 'Connected as "%s", but this site reports "%s".', $result['environment'], wp_get_environment_type() ) );
		}
		WP_CLI::success( sprintf( 'Connected. Key fingerprint: %s', $result['fingerprint'] ?? 'unknown' ) );
	}

	/**
	 * Show the connection state. Never the key.
	 *
	 * ## OPTIONS
	 *
	 * [--format=<format>]
	 * : Output format.
	 * ---
	 * default: table
	 * options:
	 *   - table
	 *   - json
	 * ---
	 *
	 * @param array<int, string>    $args       Positional arguments.
	 * @param array<string, string> $assoc_args Named arguments.
	 */
	public function status( array $args, array $assoc_args ): void {
		$status = GQ_Support_Connection::status();
		$row    = array(
			'connection'   => $status['connection'],
			'environment'  => (string) $status['environment'],
			'connected_at' => (string) $status['connected_at'],
			'fingerprint'  => (string) $status['fingerprint'],
			'managed'      => $status['managed'] ? 'yes' : 'no',
			'disabled'     => GQ_Support_Fail_Safe::disabled() ? 'yes' : 'no',
			'last_test'    => null === $status['last_test'] ? '' : $status['last_test']['result'] . ' at ' . gmdate( 'c', $status['last_test']['at'] ),
		);
		WP_CLI\Utils\format_items( $assoc_args['format'] ?? 'table', array( $row ), array_keys( $row ) );
	}

	/**
	 * Ask the service whether this site's connection works.
	 */
	public function test(): void {
		$result = GQ_Support_Connection::test();
		if ( is_wp_error( $result ) ) {
			WP_CLI::error( $result->get_error_message() );
		}
		$outcome = null === $result['last_test'] ? 'unreachable' : $result['last_test']['result'];
		if ( 'ok' !== $outcome ) {
			WP_CLI::error( sprintf( 'Connection test: %s.', $outcome ) );
		}
		WP_CLI::success( 'Connection works.' );
	}

	/**
	 * Revoke this site's key, as a best effort, and delete it locally.
	 */
	public function disconnect(): void {
		$result = GQ_Support_Connection::disconnect();
		if ( is_wp_error( $result ) ) {
			WP_CLI::error( $result->get_error_message() );
		}
		if ( ! $result['revoked'] ) {
			WP_CLI::warning( 'The service could not be told. Ask GETQUICK to revoke this site\'s key.' );
		}
		WP_CLI::success( 'Disconnected. Reconnecting needs a new Enrollment code.' );
	}
	/**
	 * Show this installation's native update key for GETQUICK to grant, generating it if needed.
	 * Prints the key ID and public key only; the key itself never leaves the site.
	 *
	 * ## OPTIONS
	 *
	 * [--rotate]
	 * : Replace the key. Updates stop until GETQUICK grants the new one.
	 *
	 * @param array<int, string>         $args       Positional arguments.
	 * @param array<string, bool|string> $assoc_args Named arguments.
	 *
	 * @subcommand update-key
	 */
	public function update_key( array $args, array $assoc_args ): void {
		$key = GQ_Support_Updater::provision( ! empty( $assoc_args['rotate'] ) );
		WP_CLI::line( 'Key ID: ' . $key['key_id'] );
		WP_CLI::line( 'Public key: ' . $key['public_key'] );
		WP_CLI::success( 'Send the public key to GETQUICK to grant native updates to this site.' );
	}

	/**
	 * Show the native update state. Never the key or download access.
	 *
	 * ## OPTIONS
	 *
	 * [--format=<format>]
	 * : Output format.
	 * ---
	 * default: table
	 * options:
	 *   - table
	 *   - json
	 * ---
	 *
	 * @param array<int, string>    $args       Positional arguments.
	 * @param array<string, string> $assoc_args Named arguments.
	 *
	 * @subcommand update-status
	 */
	public function update_status( array $args, array $assoc_args ): void {
		$status = GQ_Support_Updater::status();
		$row    = array(
			'provisioned' => $status['provisioned'] ? 'yes' : 'no',
			'key_id'      => (string) $status['key_id'],
			'checked_at'  => null === $status['checked_at'] ? '' : gmdate( 'c', $status['checked_at'] ),
			'approved'    => (string) $status['version'],
			'installed'   => GQ_SUPPORT_VERSION,
			'error'       => (string) $status['error'],
			'auto_update' => $status['auto_update'] ? 'yes' : 'no',
		);
		WP_CLI\Utils\format_items( $assoc_args['format'] ?? 'table', array( $row ), array_keys( $row ) );
	}

	/**
	 * Ask the service for the approved release now; `wp plugin update gq-support` then installs it.
	 *
	 * @subcommand update-check
	 */
	public function update_check(): void {
		if ( ! GQ_Support_Updater::status()['provisioned'] ) {
			WP_CLI::error( 'No update key. Run `wp gq-support update-key` and ask GETQUICK to grant it.' );
		}
		$offer = GQ_Support_Updater::refresh( time(), true );
		if ( isset( $offer['error'] ) ) {
			WP_CLI::error( sprintf( 'Update check: %s.', $offer['error'] ) );
		}
		// Core's next check files the offer; delete its cache so this one does it now.
		delete_site_transient( 'update_plugins' );
		wp_update_plugins();
		WP_CLI::success( isset( $offer['version'] ) ? sprintf( 'Approved release: %s.', $offer['version'] ) : 'No approved release is offered.' );
	}
}
