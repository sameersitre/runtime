import React, { useEffect, useRef, createContext, useContext, type ReactNode, Profiler } from 'react';
import type { FloTraceConfig, TrackingOptions } from './types';
import { DEFAULT_CONFIG } from './types';
import { getWebSocketClient, disposeWebSocketClient } from './websocketClient';
import { serializeProps, getChangedKeys } from './serializer';
import { installFiberTreeWalker, uninstallFiberTreeWalker, requestTreeSnapshot, requestFullSnapshot, getNodeProps, getNodeHooks, getNodeEffects, getDetailedRenderReason } from './fiberTreeWalker';
import { installZustandTracker, uninstallZustandTracker } from './zustandTracker';
import { installReduxTracker, uninstallReduxTracker, type ReduxStoreApi } from './reduxTracker';
import { installTanStackQueryTracker, uninstallTanStackQueryTracker, type TanStackQueryClientApi } from './tanstackQueryTracker';
import { installRouterTracker, uninstallRouterTracker } from './routerTracker';
import { installTimelineTracker, uninstallTimelineTracker, getTimeline } from './timelineTracker';
import { installNetworkTracker, uninstallNetworkTracker, prewarmNetworkTracker } from './networkTracker';

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
 * Context for FloTrace runtime state
 */
interface FloTraceContextValue {
  connected: boolean;
  enabled: boolean;
  config: Required<FloTraceConfig>;
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
  stores?: Record<string, { subscribe: (...args: unknown[]) => () => void; getState: () => Record<string, unknown> }>;
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
export function FloTraceProvider({ children, config = {}, stores, reduxStore, queryClient }: FloTraceProviderProps): JSX.Element {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const [connected, setConnected] = React.useState(false);
  const trackingOptionsRef = useRef<TrackingOptions>({});
  // Stable refs for stores to avoid stale closures in message handler
  const storesRef = useRef(stores);
  storesRef.current = stores;
  const reduxStoreRef = useRef(reduxStore);
  reduxStoreRef.current = reduxStore;
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

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
        case 'ext:ping':
          client.sendImmediate({ type: 'runtime:ready', appName: mergedConfig.appName });
          break;

        case 'ext:startTracking':
          trackingOptionsRef.current = message.options || {};
          // Each tracker installed independently so one failure doesn't block others
          if (message.options?.trackZustand && storesRef.current && Object.keys(storesRef.current).length > 0) {
            safeTrackerOp('Zustand install', () =>
              installZustandTracker(storesRef.current as Record<string, { subscribe: (listener: (state: Record<string, unknown>, prevState: Record<string, unknown>) => void) => () => void; getState: () => Record<string, unknown> }>, client));
          }
          if (message.options?.trackRedux && reduxStoreRef.current) {
            safeTrackerOp('Redux install', () => installReduxTracker(reduxStoreRef.current!, client));
          }
          if (message.options?.trackTanstackQuery && queryClientRef.current) {
            safeTrackerOp('TanStack Query install', () => installTanStackQueryTracker(queryClientRef.current!, client));
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
          const nodeId = (message as { nodeId?: string }).nodeId;
          if (nodeId) {
            const props = getNodeProps(nodeId);
            client.sendImmediate({
              type: 'runtime:nodeProps',
              nodeId,
              props: props || {},
              timestamp: Date.now(),
            });
          }
          break;
        }

        case 'ext:requestNodeHooks': {
          const hookNodeId = (message as { nodeId?: string }).nodeId;
          if (hookNodeId) {
            const hooks = getNodeHooks(hookNodeId);
            client.sendImmediate({
              type: 'runtime:nodeHooks',
              nodeId: hookNodeId,
              hooks: hooks || [],
              timestamp: Date.now(),
            });
          }
          break;
        }

        case 'ext:requestNodeEffects': {
          const effectNodeId = (message as { nodeId?: string }).nodeId;
          if (effectNodeId) {
            const effects = getNodeEffects(effectNodeId);
            client.sendImmediate({
              type: 'runtime:nodeEffects',
              nodeId: effectNodeId,
              effects: effects || [],
              timestamp: Date.now(),
            });
          }
          break;
        }

        case 'ext:requestDetailedRenderReason': {
          const reasonNodeId = (message as { nodeId?: string }).nodeId;
          if (reasonNodeId) {
            const reason = getDetailedRenderReason(reasonNodeId);
            if (reason) {
              client.sendImmediate({
                type: 'runtime:detailedRenderReason',
                nodeId: reasonNodeId,
                reason,
                timestamp: Date.now(),
              });
            }
          }
          break;
        }

        case 'ext:requestFullSnapshot':
          requestFullSnapshot();
          console.log('[FloTrace] Full snapshot requested by extension');
          break;

        case 'ext:requestTimeline': {
          const timelineNodeId = (message as { nodeId?: string }).nodeId;
          if (timelineNodeId) {
            const events = getTimeline(timelineNodeId);
            const componentName = timelineNodeId.split('/').pop()?.replace(/-\d+$/, '') ?? 'Unknown';
            for (const event of events) {
              client.sendImmediate({
                type: 'runtime:timelineEvent',
                nodeId: timelineNodeId,
                componentName,
                event,
              });
            }
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
          if (reduxStoreRef.current) {
            safeTrackerOp('Redux install', () => installReduxTracker(reduxStoreRef.current!, client));
          }
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
              installZustandTracker(
                storesRef.current as Record<string, { subscribe: (listener: (state: Record<string, unknown>, prevState: Record<string, unknown>) => void) => () => void; getState: () => Record<string, unknown> }>,
                client,
              ));
          }
          break;
        case 'ext:stopZustandTracking':
          safeTrackerOp('Zustand uninstall', uninstallZustandTracker);
          break;

        case 'ext:startTanstackTracking':
          if (queryClientRef.current) {
            safeTrackerOp('TanStack Query install', () => installTanStackQueryTracker(queryClientRef.current!, client));
          }
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

    return () => {
      // Immediately unsubscribe handlers to prevent duplicates on remount
      unsubConnection();
      unsubMessage();

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
      }, 100);
    };
  }, [mergedConfig.enabled, mergedConfig.port, mergedConfig.appName]);

  /**
   * Profiler callback - called every time a component renders
   */
  const onRenderCallback = (
    id: string,
    phase: 'mount' | 'update' | 'nested-update',
    actualDuration: number,
    baseDuration: number,
    startTime: number,
    commitTime: number
  ) => {
    try {
      if (!mergedConfig.enabled) {
        return;
      }

      const client = getWebSocketClient();
      if (!client.connected) {
        return;
      }

      // Convert nested-update to update for simplicity
      const normalizedPhase = phase === 'nested-update' ? 'update' : phase;

      // Send render event
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
  };

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
  displayName?: string
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
      commitTime: number
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
