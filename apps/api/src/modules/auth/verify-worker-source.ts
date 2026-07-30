/**
 * Source of the password-verification worker, as a string.
 *
 * It is a string, not a file, on purpose: the API is bundled by Next, and a
 * bundler rewrites or drops a `new Worker(new URL('./file.js', import.meta.url))`
 * target. A string is opaque to the bundler, which is also why the `require`
 * calls live in HERE rather than in the parent: resolving the path on the parent
 * side with `createRequire(import.meta.url).resolve('bcryptjs')` compiled down to
 * a numeric webpack module id, and the built app failed at runtime with `The
 * "id" argument must be of type string`. The Playwright login test against the
 * BUILT app is what caught that, and is what keeps it caught.
 *
 * `compareSync` INSIDE here is the correct call and the whole point: it blocks
 * this dedicated thread, which is exactly what stops it blocking the thread that
 * serves requests. This file is therefore the single documented exception to the
 * "no synchronous password primitive" rule, and a test asserts it is the only
 * one.
 */
export const VERIFY_WORKER_SOURCE = `
'use strict';
const { parentPort } = require('node:worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', (job) => {
  try {
    parentPort.postMessage({ id: job.id, matched: bcrypt.compareSync(job.password, job.hash) });
  } catch (error) {
    parentPort.postMessage({ id: job.id, failure: String((error && error.message) || error) });
  }
});
`;
