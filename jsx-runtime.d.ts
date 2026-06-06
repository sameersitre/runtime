/**
 * Type declarations for `@flotrace/runtime/jsx-runtime`.
 *
 * Re-exports the canonical runtime + the `JSX` namespace from
 * `@flotrace/runtime-core/jsx-runtime` so TypeScript resolves
 * `JSX.IntrinsicElements` etc. when `jsxImportSource` points at this package.
 * The explicit `export type { JSX }` is required — `export *` alone does not
 * reliably re-propagate the namespace.
 */
export * from '@flotrace/runtime-core/jsx-runtime';
export type { JSX } from '@flotrace/runtime-core/jsx-runtime';
