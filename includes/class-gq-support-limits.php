<?php
/**
 * Limits for the v1 support boundary.
 *
 * @package GQ_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** Contract limits; shared fixtures guard drift between implementations. */
final class GQ_Support_Limits {
	public const SUMMARY_CHARACTERS     = 120;
	public const DESCRIPTION_CHARACTERS = 10000;
	public const BODY_BYTES             = 32768;
	public const RESPONSE_BYTES         = 65536;
}
