/**
 * @flotrace/runtime/babel-plugin
 *
 * Thin re-export shim. The FloTrace source-attribution Babel plugin is
 * implemented once in `@flotrace/runtime-core` (its reader side lives there
 * too). Web consumers reference it through this adapter — the package they
 * actually install — so they never depend on runtime-core directly.
 *
 *   // babel.config.js (or babel section of your bundler config)
 *   env: { development: { plugins: ['@flotrace/runtime/babel-plugin'] } }
 *
 * Most web setups don't need this — Next.js (SWC) and Vite get attribution
 * from `jsxImportSource: '@flotrace/runtime-core'` + React's debug routes
 * with zero config. The plugin adds value for Babel-only setups (CRA) and
 * for components instantiated via `React.createElement(C)` from a library
 * (react-router v5 `component={X}`, HOCs) — the definition-site attribution
 * that `jsxImportSource` cannot provide.
 *
 * CommonJS so Babel can `require()` it without a build step. `module.exports`
 * is the core module object verbatim, so the plugin function AND its static
 * `FLOTRACE_ATTR_NAME` property both pass through unchanged.
 */
'use strict';

module.exports = require('@flotrace/runtime-core/babel-plugin');
