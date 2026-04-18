/**
 * @flotrace/runtime
 *
 * Web adapter for FloTrace. Re-exports everything from `@flotrace/runtime-core`
 * and layers on the browser-only pieces: `FloTraceProvider`, the history-API
 * router tracker, and the DOM fetch/XHR network tracker.
 *
 * React Native consumers should install `@flotrace/runtime-native` instead.
 *
 * @example
 * ```tsx
 * import { FloTraceProvider } from '@flotrace/runtime';
 *
 * createRoot(document.getElementById('root')).render(
 *   <FloTraceProvider config={{ appName: 'My App' }}>
 *     <App />
 *   </FloTraceProvider>
 * );
 * ```
 */

// Re-export everything platform-agnostic from the core package
export * from '@flotrace/runtime-core';

// Web-only: the React provider users wrap their app with
export { FloTraceProvider, useFloTrace, withFloTrace, useTrackProps } from './FloTraceProvider';
export type { FloTraceProviderProps } from './FloTraceProvider';

// Web-only: History API patching for client-side navigation tracking
export { installRouterTracker, uninstallRouterTracker } from './routerTracker';

// Web-only: fetch + XMLHttpRequest patching (DOM APIs, request bodies,
// Response.json — all features that crash the React Native bridge and
// must live outside of runtime-core).
export { installNetworkTracker, uninstallNetworkTracker } from './networkTracker';
