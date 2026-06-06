/**
 * @flotrace/runtime/jsx-dev-runtime — dev JSX runtime re-export shim (CJS).
 *
 * CommonJS counterpart of jsx-dev-runtime.mjs for the `require` condition.
 * Forwards verbatim to runtime-core's canonical entry.
 */
'use strict';

module.exports = require('@flotrace/runtime-core/jsx-dev-runtime');
