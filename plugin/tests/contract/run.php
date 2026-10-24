<?php
/**
 * Run PHPUnit in the disposable WordPress loaded by wp eval-file.
 *
 * @package GQ_Support
 */

// WordPress has already bootstrapped this CLI-only test entry point.
require_once __DIR__ . '/../../vendor/autoload.php';
$gq_support_runner = new PHPUnit\TextUI\TestRunner();
$gq_support_suite  = new PHPUnit\Framework\TestSuite();
$gq_support_suite->addTestFile( __DIR__ . '/SupportContractTest.php' );
$gq_support_suite->addTestFile( __DIR__ . '/ReportContextTest.php' );
$gq_support_result = $gq_support_runner->run(
	$gq_support_suite,
	array(
		'colors'      => 'always',
		'extensions'  => array(),
		'cacheResult' => false,
	)
);
exit( $gq_support_result->wasSuccessful() ? 0 : 1 );
