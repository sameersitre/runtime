/**
 * @flotrace/runtime
 *
 * Runtime package for FloTrace - enables real-time render tracking in your React app.
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

// Main provider component
export { FloTraceProvider, useFloTrace, withFloTrace, useTrackProps } from './FloTraceProvider';
export type { FloTraceProviderProps } from './FloTraceProvider';

// Configuration types
export type { FloTraceConfig, TrackingOptions, SerializedValue, LiveTreeNode } from './types';
export { DEFAULT_CONFIG } from './types';

// Console-Free Debugging types
export type {
  DetailedRenderReason, DetailedRenderReasonType, PropChange,
  HookType, HookInfo, EffectInfo,
  TimelineEventType, TimelineEvent,
  ConsoleLevel, ConsoleCaptureEntry,
} from './types';

// Fiber tree walker for advanced usage
export { installFiberTreeWalker, uninstallFiberTreeWalker, requestTreeSnapshot, getNodeHooks, getNodeEffects, getDetailedRenderReason, getFiberRefMap } from './fiberTreeWalker';
export type { Fiber, FiberHookState, FiberEffect } from './fiberTreeWalker';

// Hook inspector
export { inspectHooks } from './hookInspector';

// Effect inspector
export { inspectEffects } from './effectInspector';

// Zustand store tracker for explicit store registration
export { installZustandTracker, uninstallZustandTracker } from './zustandTracker';

// Redux store tracker for explicit store registration
export { installReduxTracker, uninstallReduxTracker, isReduxStore } from './reduxTracker';
export type { ReduxStoreApi } from './reduxTracker';

// Router tracker for automatic URL navigation tracking (History API patching)
export { installRouterTracker, uninstallRouterTracker } from './routerTracker';

// Timeline tracker for component lifecycle events
export { installTimelineTracker, uninstallTimelineTracker, recordTimelineEvent, getTimeline } from './timelineTracker';

// Console capture tracker
export { installConsoleTracker, uninstallConsoleTracker } from './consoleTracker';

// Utility for manual prop serialization
export { serializeValue, serializeProps } from './serializer';

// WebSocket client for advanced usage
export { getWebSocketClient, disposeWebSocketClient, FloTraceWebSocketClient } from './websocketClient';
