<?php
/**
 * The WP-CLI API the plugin uses. `php-stubs/wp-cli-stubs` does not yet
 * support `php-stubs/wordpress-stubs` 7.
 *
 * @package GQ_Support
 */

namespace {
	class WP_CLI {
		/**
		 * @param string       $name     Command name.
		 * @param class-string $callable Command class.
		 */
		public static function add_command( string $name, string $callable ): bool {}

		/** @return never */
		public static function error( string $message ): void {}

		public static function warning( string $message ): void {}

		public static function success( string $message ): void {}
	}
}

namespace WP_CLI\Utils {
	/**
	 * @param array<int, array<string, string>> $items  Rows.
	 * @param array<int, string>                $fields Columns.
	 */
	function format_items( string $format, array $items, array $fields ): void {}
}
