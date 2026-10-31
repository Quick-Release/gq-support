<?php
/**
 * A cheap local snapshot for Site Health, never a service health probe.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** Loaded only when core requests Site Health information. */
final class GQ_Support_Site_Health {

	/**
	 * Include only the plugin version and an allowlisted local connection label.
	 * No scans, key reads, live tests, raw stored errors or identity are needed.
	 *
	 * @param array<string, mixed> $information Core's Site Health sections.
	 * @return array<string, mixed>
	 */
	public static function information( array $information ): array {
		/**
		 * Local storage can contain an unrecognized state.
		 *
		 * @var array<string, string> $connections
		 */
		$connections               = array(
			'connected'       => __( 'Connected', 'gq-support' ),
			'not_connected'   => __( 'Not connected', 'gq-support' ),
			'copied_or_moved' => __( 'Copied or moved', 'gq-support' ),
			'rejected'        => __( 'Rejected', 'gq-support' ),
		);
		$information['gq-support'] = array(
			'label'       => __( 'GETQUICK Support', 'gq-support' ),
			'description' => __( 'Local connection state only. No live service check has been performed.', 'gq-support' ),
			'fields'      => array(
				'version'    => array(
					'label' => __( 'Support plugin version', 'gq-support' ),
					'value' => GQ_SUPPORT_VERSION,
				),
				'connection' => array(
					'label' => __( 'Local connection state', 'gq-support' ),
					'value' => $connections[ GQ_Support_State::get()['connection'] ] ?? __( 'Not connected', 'gq-support' ),
				),
			),
		);
		return $information;
	}
}
