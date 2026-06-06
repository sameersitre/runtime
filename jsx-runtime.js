/**
 * @flotrace/runtime/jsx-runtime — production JSX runtime re-export shim (CJS).
 *
 * CommonJS counterpart of jsx-runtime.mjs for the `require` condition (Jest,
 * node require). Forwards verbatim to runtime-core's canonical entry. See
 * jsx-runtime.mjs for why this shim exists.
 */
'use strict';

module.exports = require('@flotrace/runtime-core/jsx-runtime');
