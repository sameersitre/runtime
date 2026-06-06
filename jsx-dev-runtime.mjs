/**
 * @flotrace/runtime/jsx-dev-runtime — dev JSX runtime re-export shim (ESM).
 *
 * Forwards to runtime-core's instrumented dev runtime (source attribution +
 * Hot Call Sites + inline-literal + duplicate-key detection). Forwarding (not
 * bundling) keeps runtime-core's per-callsite ring buffer / adoption sentinel a
 * singleton shared with `FloTraceProvider`. See jsx-runtime.mjs for the pnpm
 * rationale.
 */
export { Fragment, jsxDEV, jsxsDEV } from '@flotrace/runtime-core/jsx-dev-runtime';
