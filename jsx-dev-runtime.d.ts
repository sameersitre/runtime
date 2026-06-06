/**
 * Type declarations for `@flotrace/runtime/jsx-dev-runtime`.
 *
 * Re-exports the canonical dev runtime + the `JSX` namespace from
 * `@flotrace/runtime-core/jsx-dev-runtime`. See jsx-runtime.d.ts for why the
 * explicit `export type { JSX }` is required.
 */
export * from '@flotrace/runtime-core/jsx-dev-runtime';
export type { JSX } from '@flotrace/runtime-core/jsx-dev-runtime';
