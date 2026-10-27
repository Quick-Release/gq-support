// Fixed public output only, after the same guard/loader used by native fixtures.
import '../../deploy/planning-runtime-guard.mjs';
import * as Plan from 'alchemy/Plan';
import { DatabaseSync } from 'node:sqlite';
import { writeSync } from 'node:fs';

const started: boolean = typeof Plan.make === 'function' && typeof DatabaseSync === 'function';
if (!started) process.exit(1);
writeSync(3, '{"status":"started"}');
