/**
 * @flotrace/runtime/jsx-runtime — production JSX runtime re-export shim (ESM).
 *
 * Lets consumers set `"jsxImportSource": "@flotrace/runtime"` (the package they
 * installed) instead of `@flotrace/runtime-core`. The canonical implementation
 * lives in runtime-core; this forwards to it so there is exactly one copy and
 * the instrumentation state (ring buffer, adoption sentinel) stays a singleton
 * shared with `FloTraceProvider`.
 *
 * Why this matters: `jsxImportSource` rewrites the consumer's own JSX to import
 * from this package. Pointing it at the adapter (a direct dependency) keeps it
 * resolvable under pnpm / Yarn PnP, where a transitive `@flotrace/runtime-core`
 * is NOT reachable from the consumer's files.
 */
export { Fragment, jsx, jsxs } from '@flotrace/runtime-core/jsx-runtime';
