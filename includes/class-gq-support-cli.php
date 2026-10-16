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
}
