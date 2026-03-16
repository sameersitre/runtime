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
import { installConsoleTracker, uninstallConsoleTracker } from './consoleTracker';
import { installNetworkTracker, uninstallNetworkTracker } from './networkTracker';

// Module-level timer for deferred cleanup (React Strict Mode handling).
// When Strict Mode unmounts then remounts, we cancel this timer so the
// WebSocket connection persists instead of being torn down and recreated.
let pendingCleanupTimer: ReturnType<typeof setTimeout> | null = null;

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

    const client = getWebSocketClient(mergedConfig);

    // Install fiber tree walker EAGERLY — before WebSocket connects.
    // This hooks onCommitFiberRoot immediately so no React commits are missed
    // during the window between page load and ext:startTreeTracking arriving.
    // Without this, Suspense resolution commits can be missed if they happen
    // before the server responds, causing skeletons to persist.
    installFiberTreeWalker();

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
            try {
              installZustandTracker(storesRef.current as Record<string, { subscribe: (listener: (state: Record<string, unknown>, prevState: Record<string, unknown>) => void) => () => void; getState: () => Record<string, unknown> }>, client);
            } catch (error) {
              console.error('[FloTrace] Failed to install Zustand tracker:', error);
            }
          }
          if (message.options?.trackRedux && reduxStoreRef.current) {
            try {
              installReduxTracker(reduxStoreRef.current, client);
            } catch (error) {
              console.error('[FloTrace] Failed to install Redux tracker:', error);
            }
          }
          if (message.options?.trackTanstackQuery && queryClientRef.current) {
            try {
              installTanStackQueryTracker(queryClientRef.current, client);
            } catch (error) {
              console.error('[FloTrace] Failed to install TanStack Query tracker:', error);
            }
          }
          if (message.options?.trackRouter) {
            try {
              installRouterTracker(client);
            } catch (error) {
              console.error('[FloTrace] Failed to install Router tracker:', error);
            }
          }
          if (message.options?.trackNetwork) {
            try {
              installNetworkTracker(client);
            } catch (error) {
              console.error('[FloTrace] Failed to install Network tracker:', error);
            }
          }
          // Timeline tracker — always install with tracking (captures mount/render events)
          try {
            installTimelineTracker(client);
          } catch (error) {
            console.error('[FloTrace] Failed to install Timeline tracker:', error);
          }
          console.log('[FloTrace] Tracking started with options:', message.options);
          break;

        case 'ext:stopTracking':
          trackingOptionsRef.current = {};
          // Per-tracker uninstall so one failure doesn't block others
          try { uninstallZustandTracker(); } catch (e) { console.error('[FloTrace] Error uninstalling Zustand tracker:', e); }
          try { uninstallReduxTracker(); } catch (e) { console.error('[FloTrace] Error uninstalling Redux tracker:', e); }
          try { uninstallTanStackQueryTracker(); } catch (e) { console.error('[FloTrace] Error uninstalling TanStack Query tracker:', e); }
          try { uninstallRouterTracker(); } catch (e) { console.error('[FloTrace] Error uninstalling Router tracker:', e); }
          try { uninstallTimelineTracker(); } catch (e) { console.error('[FloTrace] Error uninstalling Timeline tracker:', e); }
          try { uninstallConsoleTracker(); } catch (e) { console.error('[FloTrace] Error uninstalling Console tracker:', e); }
          try { uninstallNetworkTracker(); } catch (e) { console.error('[FloTrace] Error uninstalling Network tracker:', e); }
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

        case 'ext:startConsoleCapture':
          try {
            installConsoleTracker(client);
            console.log('[FloTrace] Console capture started');
          } catch (error) {
            console.error('[FloTrace] Failed to install Console tracker:', error);
          }
          break;

        case 'ext:stopConsoleCapture':
          try {
            uninstallConsoleTracker();
            console.log('[FloTrace] Console capture stopped');
          } catch (error) {
            console.error('[FloTrace] Error stopping Console tracker:', error);
          }
          break;

        case 'ext:startNetworkCapture':
          try {
            installNetworkTracker(client);
            console.log('[FloTrace] Network capture started');
          } catch (error) {
            console.error('[FloTrace] Failed to install Network tracker:', error);
          }
          break;

        case 'ext:stopNetworkCapture':
          try {
            uninstallNetworkTracker();
            console.log('[FloTrace] Network capture stopped');
          } catch (error) {
            console.error('[FloTrace] Error stopping Network tracker:', error);
          }
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
        try { uninstallFiberTreeWalker(); } catch (e) { console.error('[FloTrace] Error during cleanup (fiberTreeWalker):', e); }
        try { uninstallZustandTracker(); } catch (e) { console.error('[FloTrace] Error during cleanup (zustandTracker):', e); }
        try { uninstallReduxTracker(); } catch (e) { console.error('[FloTrace] Error during cleanup (reduxTracker):', e); }
        try { uninstallTanStackQueryTracker(); } catch (e) { console.error('[FloTrace] Error during cleanup (tanstackQueryTracker):', e); }
        try { uninstallRouterTracker(); } catch (e) { console.error('[FloTrace] Error during cleanup (routerTracker):', e); }
        try { uninstallTimelineTracker(); } catch (e) { console.error('[FloTrace] Error during cleanup (timelineTracker):', e); }
        try { uninstallConsoleTracker(); } catch (e) { console.error('[FloTrace] Error during cleanup (consoleTracker):', e); }
        try { uninstallNetworkTracker(); } catch (e) { console.error('[FloTrace] Error during cleanup (networkTracker):', e); }
        try { disposeWebSocketClient(); } catch (e) { console.error('[FloTrace] Error during cleanup (websocketClient):', e); }
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
