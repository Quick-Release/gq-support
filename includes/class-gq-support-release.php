<?php
/**
 * The service's release policy for this plugin version, as last learned.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Caches the policy the support service returns during explicit support or
 * settings interactions (ADR 0021), so local controls never need a remote
 * check while a page renders. The service enforces the same policy at intake;
 * this only stops new submissions earlier, including once a previous release's
 * window ends while the service cannot be asked.
 */
final class GQ_Support_Release {

	private const FIELDS = array( 'enforcement', 'intake', 'reason', 'plugin_version', 'approved_version', 'compatible_until' );

	/**
	 * Cache a policy the service returned for this plugin. Anything malformed,
	 * or for another version, is ignored and the last known policy stays.
	 *
	 * @param mixed $policy The service's `release` value.
	 */
	public static function learn( $policy ): void {
		if ( ! is_array( $policy ) || count( $policy ) !== count( self::FIELDS ) || array_diff( self::FIELDS, array_keys( $policy ) )
			|| ! in_array( $policy['enforcement'], array( 'enforced', 'staged', 'unconfigured' ), true )
			|| ! in_array( $policy['intake'], array( 'open', 'closed' ), true )
			|| ! in_array( $policy['reason'], array( 'current', 'previous', 'unsupported', 'expired', 'unavailable' ), true )
			|| GQ_SUPPORT_VERSION !== $policy['plugin_version'] ) {
			return;
		}
		$until = $policy['compatible_until'];
		if ( null !== $until && ( ! is_string( $until ) || ! preg_match( '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\z/', $until ) ) ) {
			return;
		}
		GQ_Support_State::update(
			array(
				'release' => array(
					'plugin_version'   => GQ_SUPPORT_VERSION,
					'enforcement'      => $policy['enforcement'],
					'intake'           => $policy['intake'],
					'reason'           => $policy['reason'],
					'compatible_until' => null === $until ? null : (int) strtotime( $until ),
				),
			)
		);
	}

	/**
	 * Whether this installation may start new submissions, from the cached policy
	 * alone: never a remote call. `unknown` until the service has been asked for
	 * this version; the service still decides then. Only an outdated plugin closes
	 * intake here: a service-side outage or a staged policy does not.
	 *
	 * @param int $now Epoch seconds.
	 * @return 'open'|'closed'|'unknown'
	 */
	public static function local_intake( int $now ): string {
		$release = GQ_Support_State::get()['release'];
		if ( ! is_array( $release ) || GQ_SUPPORT_VERSION !== $release['plugin_version'] ) {
			return 'unknown';
		}
		if ( 'closed' === $release['intake'] && in_array( $release['reason'], array( 'unsupported', 'expired' ), true ) ) {
			return 'closed';
		}
		return null !== $release['compatible_until'] && $now >= $release['compatible_until'] ? 'closed' : 'open';
	}
}
