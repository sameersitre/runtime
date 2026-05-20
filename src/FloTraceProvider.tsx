import React, {
  useCallback,
  useEffect,
  useRef,
  createContext,
  useContext,
  type ReactNode,
  Profiler,
} from 'react';
import type {
  FloTraceConfig,
  ResolvedFloTraceConfig,
  TrackingOptions,
  ZustandStoreApi,
  ReduxStoreApi,
  TanStackQueryClientApi,
} from '@flotrace/runtime-core';
import {
  DEFAULT_CONFIG,
  getWebSocketClient,
  disposeWebSocketClient,
  serializeProps,
  getChangedKeys,
  installFiberTreeWalker,
  uninstallFiberTreeWalker,
  requestTreeSnapshot,
  requestFullSnapshot,
  getNodeProps,
  getNodeHooks,
  getNodeEffects,
  getDetailedRenderReason,
  installZustandTracker,
  uninstallZustandTracker,
  installReduxTracker,
  uninstallReduxTracker,
  installTanStackQueryTracker,
  uninstallTanStackQueryTracker,
  installTimelineTracker,
  uninstallTimelineTracker,
  getTimeline,
  detectWebFramework,
  resolveValueTrace,
  // Phase 4 — periodic callSiteMetrics emit + duplicate-key wire emitter
  computeCallSiteMetricsPayload,
  setDuplicateKeyEmitter,
  isJsxRuntimeActive,
  clearCallSiteRenders,
} from '@flotrace/runtime-core';
import pkg from '../package.json';

const RUNTIME_VERSION: string = pkg.version;
import { installRouterTracker, uninstallRouterTracker } from './routerTracker';
import {
  installNetworkTracker,
  uninstallNetworkTracker,
  prewarmNetworkTracker,
} from './networkTracker';

// Module-level timer for deferred cleanup (React Strict Mode handling).
// When Strict Mode unmounts then remounts, we cancel this timer so the
// WebSocket connection persists instead of being torn down and recreated.
let pendingCleanupTimer: ReturnType<typeof setTimeout> | null = null;

/** Runs a tracker operation, logging errors without throwing so one failure doesn't block others. */
function safeTrackerOp(name: string, op: () => void): void {
  try {
    op();
  } catch (error) {
    console.error(`[FloTrace] ${name}:`, error);
  }
}

/**
 * Derive a human-readable app name from the DOM. Priority:
 *   1. `<meta name="application-name">` — MDN-authoritative per spec. Next.js
 *      App Router's `metadata.applicationName` field auto-renders this, so
 *      Next.js users get the right name with zero FloTrace config.
 *   2. `document.title` at mount time — snapshot once so route-driven title
 *      churn doesn't bleed into appName (appId, not appName, is the upsert key).
 *   3. `location.hostname` — stable, route-independent fallback.
 *   4. Default 'React App' from DEFAULT_CONFIG (never reached in practice).
 */
function deriveWebAppName(): string {
  if (typeof document !== 'undefined') {
    const metaName = document
      .querySelector('meta[name="application-name"]')
      ?.getAttribute('content')
      ?.trim();
    if (metaName) return metaName;
    const title = document.title?.trim();
    if (title) return title;
  }
  if (typeof location !== 'undefined' && location.hostname) return location.hostname;
  return DEFAULT_CONFIG.appName;
}

/**
 * Stable app identifier derived from the deployment origin. `location.origin`
 * distinguishes `http://localhost:5173` from `http://localhost:5174` (two dev
 * servers = two projects in admin) while staying constant across route changes
 * and page reloads for the same deployment.
 */
function deriveWebAppId(): string {
  return typeof location !== 'undefined' && location.origin ? location.origin : 'web-app';
}

/**
 * Context for FloTrace runtime state
 */
interface FloTraceContextValue {
  connected: boolean;
  enabled: boolean;
  config: ResolvedFloTraceConfig;
}

const FloTraceContext = createContext<FloTraceContextValue | null>(null);

/**
 * Hook to access FloTrace context
 */
export function useFloTrace(): FloTraceContextValue | null {
  return useContext(FloTraceContext);
}

/**
 * Props for FloTraceProvider
 */
export interface FloTraceProviderProps {
  children: ReactNode;
  config?: FloTraceConfig;
  /**
   * Optional Zustand stores to track. Keys become the store names shown in FloTrace.
   * Each value must be a Zustand store with .subscribe() and .getState() methods.
   *
   * @example
   * ```tsx
   * import { useBearStore } from './store/bearStore';
   *
   * <FloTraceProvider stores={{ bearStore: useBearStore }}>
   *   <App />
   * </FloTraceProvider>
   * ```
   */
  stores?: Record<
    string,
    { subscribe: (...args: unknown[]) => () => void; getState: () => Record<string, unknown> }
  >;
  /**
   * Optional Redux store to track. State changes are shown in FloTrace's Redux panel.
   *
   * @example
   * ```tsx
   * import { store } from './store';
   *
   * <FloTraceProvider reduxStore={store}>
   *   <App />
   * </FloTraceProvider>
   * ```
   */
  reduxStore?: ReduxStoreApi;
  /**
   * Optional TanStack Query client to track. Query and mutation state
   * is shown in FloTrace's TanStack Query panel.
   *
   * @example
   * ```tsx
   * import { queryClient } from './queryClient';
   *
   * <FloTraceProvider queryClient={queryClient}>
   *   <QueryClientProvider client={queryClient}>
   *     <App />
   *   </QueryClientProvider>
   * </FloTraceProvider>
   * ```
   */
  queryClient?: TanStackQueryClientApi;
}

/**
 * FloTraceProvider wraps your React app to enable real-time render tracking.
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
export function FloTraceProvider({
  children,
  config = {},
  stores,
  reduxStore,
  queryClient,
}: FloTraceProviderProps): JSX.Element {
  // Refuse to attach inside React Native. Codebases that target both web and native
  // often wrap their shared root with whichever provider they imported first — without
  // this guard, the web provider would try to patch a non-existent DOM on the RN bundle.
  // Detection: React Native sets `navigator.product === 'ReactNative'` (and has no `document`).
  if (
    typeof navigator !== 'undefined' &&
    (navigator as { product?: string }).product === 'ReactNative'
  ) {
    console.warn(
      '[FloTrace] FloTraceProvider (from @flotrace/runtime) detected a React Native environment. ' +
        'Install @flotrace/runtime-native and use FloTraceProviderNative instead. Skipping attach.',
    );
    return <>{children}</>;
  }

  const framework = detectWebFramework();

  const mergedConfig: ResolvedFloTraceConfig = {
    ...DEFAULT_CONFIG,
    // Web default: expose the current page URL as the `appUrl` in runtime:ready.
    // Runtime-core defaults this to undefined so it stays platform-agnostic.
    getAppUrl: () => (typeof window !== 'undefined' ? window.location.href : undefined),
    platform: 'web',
    ...config,
    // Derived values fill in only when the user didn't supply a static one.
    // Placed AFTER `...config` so explicit user values still win via `??`.
    appName: config.appName ?? deriveWebAppName(),
    appId: config.appId ?? deriveWebAppId(),
    frameworkName: config.frameworkName ?? framework.frameworkName,
    frameworkVersion: config.frameworkVersion ?? framework.frameworkVersion,
    runtimeVersion: config.runtimeVersion ?? RUNTIME_VERSION,
  };
  const [connected, setConnected] = React.useState(false);
  const trackingOptionsRef = useRef<TrackingOptions>({});
  // Stable refs for stores to avoid stale closures in message handler
  const storesRef = useRef(stores);
  storesRef.current = stores;
  const reduxStoreRef = useRef(reduxStore);
  reduxStoreRef.current = reduxStore;
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const enabledRef = useRef(mergedConfig.enabled);
  enabledRef.current = mergedConfig.enabled;

  // ── Early patching — runs during render (top-down, before children render) ──
  // Must happen in render phase, NOT in useEffect/useLayoutEffect, because:
  // 1. urql with suspense:true calls fetch() during child render (throws promise)
  // 2. TanStack Query fires fetches in child useEffect (before parent useEffect)
  // Both happen before any parent effect can patch globalThis.fetch.
  // These calls are idempotent (module-level isPrewarmed/isInstalled guards) —
  // safe for React 19 Strict Mode double-render and subsequent re-renders.
  if (mergedConfig.enabled && typeof window !== 'undefined') {
    getWebSocketClient(mergedConfig); // ensure singleton created with correct config
    installFiberTreeWalker();
    prewarmNetworkTracker();
  }

  useEffect(() => {
    if (!mergedConfig.enabled) {
      return;
    }

    // Cancel any pending cleanup from a previous Strict Mode unmount.
    // React 18 Strict Mode runs mount → unmount → mount in dev mode.
    // Without this, the first unmount disposes the WebSocket, and the second
    // mount creates a new connection — the server briefly sees 2 clients.
    if (pendingCleanupTimer) {
      clearTimeout(pendingCleanupTimer);
      pendingCleanupTimer = null;
    }

    const client = getWebSocketClient(); // singleton already created in render phase

    // Handle connection state changes
    const unsubConnection = client.onConnectionChange((isConnected) => {
      setConnected(isConnected);
      // On (re)connect, trigger a full snapshot to recover from any snapshots
      // dropped while disconnected (e.g., hard refresh race condition where
      // React commits before WebSocket connects)
      if (isConnected) {
        requestFullSnapshot();
      }
    });

    // Handle messages from extension
    const unsubMessage = client.onMessage((message) => {
      try {
        switch (message.type) {
          // Heartbeat liveness is handled by the dedicated `runtime:pong` path
          // in websocketClient. We intentionally do NOT re-send `runtime:ready`
          // on every `ext:ping` — a truncated ready (only appName, no appId /
          // platform / versions) would clobber the server's client registry
          // metadata on every 5s tick. The initial `onopen` ready is authoritative.
          case 'ext:ping':
            break;

          case 'ext:startTracking':
            trackingOptionsRef.current = message.options || {};
            // Each tracker installed independently so one failure doesn't block others
            if (
              message.options?.trackZustand &&
              storesRef.current &&
              Object.keys(storesRef.current).length > 0
            ) {
              safeTrackerOp('Zustand install', () =>
                installZustandTracker(storesRef.current as Record<string, ZustandStoreApi>, client),
              );
            }
            if (message.options?.trackRedux && reduxStoreRef.current) {
              safeTrackerOp('Redux install', () =>
                installReduxTracker(reduxStoreRef.current!, client),
              );
            }
            if (message.options?.trackTanstackQuery && queryClientRef.current) {
              safeTrackerOp('TanStack Query install', () =>
                installTanStackQueryTracker(queryClientRef.current!, client),
              );
            }
            if (message.options?.trackRouter) {
              safeTrackerOp('Router install', () => installRouterTracker(client));
            }
            if (message.options?.trackNetwork) {
              safeTrackerOp('Network install', () => installNetworkTracker(client));
            }
            // Timeline tracker — always install with tracking (captures mount/render events)
            safeTrackerOp('Timeline install', () => installTimelineTracker(client));
            console.log('[FloTrace] Tracking started with options:', message.options);
            break;

          case 'ext:stopTracking':
            trackingOptionsRef.current = {};
            // Per-tracker uninstall so one failure doesn't block others
            safeTrackerOp('Zustand uninstall', uninstallZustandTracker);
            safeTrackerOp('Redux uninstall', uninstallReduxTracker);
            safeTrackerOp('TanStack Query uninstall', uninstallTanStackQueryTracker);
            safeTrackerOp('Router uninstall', uninstallRouterTracker);
            safeTrackerOp('Timeline uninstall', uninstallTimelineTracker);
            safeTrackerOp('Network uninstall', uninstallNetworkTracker);
            console.log('[FloTrace] Tracking stopped');
            break;

          case 'ext:startTreeTracking':
            // Walker already installed eagerly on mount — ensure it's running
            installFiberTreeWalker();
            break;

          case 'ext:stopTreeTracking':
            uninstallFiberTreeWalker();
            console.log('[FloTrace] Tree tracking stopped');
            break;

          case 'ext:requestNodeProps': {
            const props = getNodeProps(message.nodeId);
            client.sendImmediate({
              type: 'runtime:nodeProps',
              nodeId: message.nodeId,
              props: props || {},
              timestamp: Date.now(),
            });
            break;
          }

          case 'ext:requestNodeHooks': {
            const hooks = getNodeHooks(message.nodeId);
            client.sendImmediate({
              type: 'runtime:nodeHooks',
              nodeId: message.nodeId,
              hooks: hooks || [],
              timestamp: Date.now(),
            });
            break;
          }

          case 'ext:requestNodeEffects': {
            const effects = getNodeEffects(message.nodeId);
            client.sendImmediate({
              type: 'runtime:nodeEffects',
              nodeId: message.nodeId,
              effects: effects || [],
              timestamp: Date.now(),
            });
            break;
          }

          case 'ext:requestDetailedRenderReason': {
            const reason = getDetailedRenderReason(message.nodeId);
            if (reason) {
              client.sendImmediate({
                type: 'runtime:detailedRenderReason',
                nodeId: message.nodeId,
                reason,
                timestamp: Date.now(),
              });
            }
            break;
          }

          case 'ext:requestFullSnapshot':
            requestFullSnapshot();
            console.log('[FloTrace] Full snapshot requested by extension');
            break;

          case 'ext:requestTimeline': {
            const events = getTimeline(message.nodeId);
            const componentName =
              message.nodeId.split('/').pop()?.replace(/-\d+$/, '') ?? 'Unknown';
            for (const event of events) {
              client.sendImmediate({
                type: 'runtime:timelineEvent',
                nodeId: message.nodeId,
                componentName,
                event,
              });
            }
            break;
          }

          // Value Lineage — resolve the origin chain for a prop or hook value.
          case 'ext:traceValue': {
            try {
              const trace = resolveValueTrace({
                nodeId: message.nodeId,
                propPath: message.propPath,
                hookPath: message.hookPath,
              });
              client.sendImmediate({
                type: 'runtime:valueTrace',
                trace: { requestId: message.requestId, ...trace },
                timestamp: Date.now(),
              });
            } catch (error) {
              // Resolver must never throw into the message loop — reply with an empty trace.
              console.error('[FloTrace] resolveValueTrace threw:', error);
              client.sendImmediate({
                type: 'runtime:valueTrace',
                trace: {
                  requestId: message.requestId,
                  rootNodeId: message.nodeId,
                  rootPropPath: message.propPath,
                  rootHookPath: message.hookPath,
                  steps: [],
                  resolvedAtMs: Date.now(),
                  error: 'value-not-found',
                },
                timestamp: Date.now(),
              });
            }
            break;
          }

          case 'ext:startNetworkCapture':
            safeTrackerOp('Network capture start', () => installNetworkTracker(client));
            break;

          case 'ext:stopNetworkCapture':
            safeTrackerOp('Network capture stop', uninstallNetworkTracker);
            break;

          // --- Individual tracker start/stop (sidebar panel show/hide) ---

          case 'ext:startReduxTracking':
            if (reduxStoreRef.current)
              safeTrackerOp('Redux install', () =>
                installReduxTracker(reduxStoreRef.current!, client),
              );
            break;
          case 'ext:stopReduxTracking':
            safeTrackerOp('Redux uninstall', uninstallReduxTracker);
            break;
          case 'ext:startRouterTracking':
            safeTrackerOp('Router install', () => installRouterTracker(client));
            break;
          case 'ext:stopRouterTracking':
            safeTrackerOp('Router uninstall', uninstallRouterTracker);
            break;
          case 'ext:startZustandTracking':
            if (storesRef.current && Object.keys(storesRef.current).length > 0) {
              safeTrackerOp('Zustand install', () =>
                installZustandTracker(storesRef.current as Record<string, ZustandStoreApi>, client),
              );
            }
            break;
          case 'ext:stopZustandTracking':
            safeTrackerOp('Zustand uninstall', uninstallZustandTracker);
            break;
          case 'ext:startTanstackTracking':
            if (queryClientRef.current)
              safeTrackerOp('TanStack Query install', () =>
                installTanStackQueryTracker(queryClientRef.current!, client),
              );
            break;
          case 'ext:stopTanstackTracking':
            safeTrackerOp('TanStack Query uninstall', uninstallTanStackQueryTracker);
            break;

          case 'ext:requestState':
            // Legacy — kept for backward compatibility
            break;
        }
      } catch (error) {
        console.error(`[FloTrace] Error handling message type "${message.type}":`, error);
      }
    });

    // Connect (no-op if already connected from a previous mount)
    client.connect();

    // ─── JSX runtime: callSiteMetrics + duplicate-key wiring (Milestone 8 P4) ───
    // Only activate when the user opted into `"jsxImportSource": "@flotrace/runtime-core"`
    // — `isJsxRuntimeActive()` returns true once the first jsxDEV call sets the
    // global sentinel. If not adopted, both surfaces are pure no-ops.
    //
    // Both run inside this effect so they tear down with the rest of the
    // tracker stack on unmount (Strict Mode cancellation included).
    setDuplicateKeyEmitter((evt) => {
      try {
        if (!client.connected) return;
        client.send({
          type: 'runtime:duplicateKey',
          callSiteId: evt.callSiteId,
          fileName: evt.fileName,
          lineNumber: evt.lineNumber,
          columnNumber: evt.columnNumber,
          duplicateKey: evt.duplicateKey,
          occurrences: evt.occurrences,
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error('[FloTrace] Error emitting runtime:duplicateKey:', error);
      }
    });

    // Periodic flush of per-callsite render rates. Computed from the ring
    // buffer on each tick — `null` payload (no recent activity) short-
    // circuits the WS send so idle apps stay silent.
    const callSiteMetricsTimer = setInterval(() => {
      try {
        if (!client.connected) return;
        if (!isJsxRuntimeActive()) return;
        const metrics = computeCallSiteMetricsPayload();
        if (metrics === null) return;
        client.send({
          type: 'runtime:callSiteMetrics',
          metrics,
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error('[FloTrace] Error emitting runtime:callSiteMetrics:', error);
      }
    }, 1000);

    return () => {
      // Immediately unsubscribe handlers to prevent duplicates on remount
      unsubConnection();
      unsubMessage();
      // JSX runtime cleanup — clear the emitter so deferred-cleanup window
      // doesn't keep sending dupe-key events for a dead session, and stop
      // the periodic metrics timer.
      setDuplicateKeyEmitter(null);
      clearInterval(callSiteMetricsTimer);

      // Defer heavy cleanup so Strict Mode remount can cancel it.
      // On real unmount, this runs after 100ms and tears everything down.
      // Each uninstall wrapped independently so one failure doesn't block others
      pendingCleanupTimer = setTimeout(() => {
        pendingCleanupTimer = null;
        safeTrackerOp('cleanup fiberTreeWalker', uninstallFiberTreeWalker);
        safeTrackerOp('cleanup zustandTracker', uninstallZustandTracker);
        safeTrackerOp('cleanup reduxTracker', uninstallReduxTracker);
        safeTrackerOp('cleanup tanstackQueryTracker', uninstallTanStackQueryTracker);
        safeTrackerOp('cleanup routerTracker', uninstallRouterTracker);
        safeTrackerOp('cleanup timelineTracker', uninstallTimelineTracker);
        safeTrackerOp('cleanup networkTracker', uninstallNetworkTracker);
        safeTrackerOp('cleanup websocketClient', disposeWebSocketClient);
        // Clear the per-callsite ring buffer so a remount after disconnect
        // doesn't accumulate stale entries across sessions.
        safeTrackerOp('cleanup callSiteRenders', clearCallSiteRenders);
      }, 100);
    };
  }, [mergedConfig.enabled, mergedConfig.port, mergedConfig.appName]);

  /**
   * Profiler callback — stable reference via useCallback to avoid
   * unnecessary Profiler re-subscriptions on parent re-renders.
   */
  const onRenderCallback = useCallback(
    (
      id: string,
      phase: 'mount' | 'update' | 'nested-update',
      actualDuration: number,
      baseDuration: number,
      _startTime: number,
      commitTime: number,
    ) => {
      try {
        if (!enabledRef.current) return;

        const client = getWebSocketClient();
        if (!client.connected) return;

        const normalizedPhase = phase === 'nested-update' ? 'update' : phase;

        client.send({
          type: 'runtime:render',
          componentName: id,
          phase: normalizedPhase,
          actualDuration,
          baseDuration,
          timestamp: commitTime,
        });

        // Trigger tree snapshot if tree tracking is active (DOM fallback strategy).
        // This is a no-op if using the DevTools hook strategy (which is event-driven).
        requestTreeSnapshot();
      } catch (error) {
        console.error('[FloTrace] Error in Profiler callback:', error);
      }
    },
    [],
  );

  const contextValue: FloTraceContextValue = {
    connected,
    enabled: mergedConfig.enabled,
    config: mergedConfig,
  };

  return (
    <FloTraceContext.Provider value={contextValue}>
      <Profiler id="FloTrace-Root" onRender={onRenderCallback}>
        {children}
      </Profiler>
    </FloTraceContext.Provider>
  );
}

/**
 * Higher-order component to wrap a component with FloTrace profiling.
 * Use this for targeted profiling of specific components.
 *
 * @example
 * ```tsx
 * import { withFloTrace } from '@flotrace/runtime';
 *
 * const ProfiledComponent = withFloTrace(MyComponent, 'MyComponent');
 * ```
 */
export function withFloTrace<P extends object>(
  Component: React.ComponentType<P>,
  displayName?: string,
): React.FC<P> {
  const name = displayName || Component.displayName || Component.name || 'Unknown';

  const WrappedComponent: React.FC<P> = (props) => {
    const floTrace = useFloTrace();

    const onRender = (
      id: string,
      phase: 'mount' | 'update' | 'nested-update',
      actualDuration: number,
      baseDuration: number,
      startTime: number,
      commitTime: number,
    ) => {
      try {
        if (!floTrace?.enabled) {
          return;
        }

        const client = getWebSocketClient();
        if (!client.connected) {
          return;
        }

        const normalizedPhase = phase === 'nested-update' ? 'update' : phase;

        client.send({
          type: 'runtime:render',
          componentName: id,
          phase: normalizedPhase,
          actualDuration,
          baseDuration,
          timestamp: commitTime,
        });

        // Send props if enabled
        if (floTrace.config.includeProps) {
          client.send({
            type: 'runtime:props',
            componentName: id,
            props: serializeProps(props as Record<string, unknown>),
            timestamp: commitTime,
          });
        }
      } catch (error) {
        console.error('[FloTrace] Error in withFloTrace render callback:', error);
      }
    };

    return (
      <Profiler id={name} onRender={onRender}>
        <Component {...props} />
      </Profiler>
    );
  };

  WrappedComponent.displayName = `FloTrace(${name})`;
  return WrappedComponent;
}

/**
 * Hook to track props changes for a component.
 * Call this at the top of your component to track its props.
 *
 * @example
 * ```tsx
 * function MyComponent(props: MyProps) {
 *   useTrackProps('MyComponent', props);
 *   // ... rest of component
 * }
 * ```
 */
export function useTrackProps(componentName: string, props: Record<string, unknown>): void {
  const floTrace = useFloTrace();
  const prevPropsRef = useRef<Record<string, unknown>>();

  useEffect(() => {
    try {
      if (!floTrace?.enabled || !floTrace.config.includeProps) {
        return;
      }

      const client = getWebSocketClient();
      if (!client.connected) {
        return;
      }

      const changedKeys = getChangedKeys(prevPropsRef.current, props);
      if (changedKeys.length > 0) {
        client.send({
          type: 'runtime:props',
          componentName,
          props: serializeProps(props),
          changedKeys,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.error('[FloTrace] Error in useTrackProps:', error);
    } finally {
      // Always update prevProps so next comparison starts from current state
      prevPropsRef.current = { ...props };
    }
  }, [componentName, props, floTrace?.enabled, floTrace?.config.includeProps]);
}

export default FloTraceProvider;
