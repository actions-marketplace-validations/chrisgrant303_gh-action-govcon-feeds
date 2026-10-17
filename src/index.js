#!/usr/bin/env node
import { run } from './main.js';

run().then((r) => { if (!r.ok) process.exitCode = 1; }, () => {
    // run() never throws with secrets in it; keep the fallback message generic.
    process.stdout.write('::error::Unexpected failure in the action.\n');
    process.exitCode = 1;
});
