import React, { ReactNode } from 'react';

/**
 * Types for @flotrace/runtime package
 * These mirror the shared types from the extension but are standalone
 * to avoid importing from the extension package.
 */
/**
 * Serialized value for safe transmission over WebSocket
 */
type SerializedValue = null | boolean | number | string | SerializedValue[] | {
    [key: string]: SerializedValue;
} | {
    __type: 'function';
    name?: string;
} | {
    __type: 'undefined';
} | {
    __type: 'symbol';
    description?: string;
} | {
    __type: 'circular';
} | {
    __type: 'truncated';
    originalType: string;
    length?: number;
};
/**
 * Messages sent from runtime to extension
 */
type RuntimeMessage = RuntimeReadyMessage | RuntimeRenderMessage | RuntimePropsUpdateMessage | RuntimeNodePropsMessage | RuntimeZustandUpdateMessage | RuntimeReduxUpdateMessage | RuntimeRouterUpdateMessage | RuntimeContextUpdateMessage | RuntimeDisconnectMessage | RuntimeTreeSnapshotMessage | RuntimeTreeDiffMessage;
interface RuntimeReadyMessage {
    type: 'runtime:ready';
    appName?: string;
    reactVersion?: string;
    appUrl?: string;
}
interface RuntimeRenderMessage {
    type: 'runtime:render';
    componentName: string;
    filePath?: string;
    phase: 'mount' | 'update';
    actualDuration: number;
    baseDuration: number;
    timestamp: number;
    instanceId?: string;
}
interface RuntimePropsUpdateMessage {
    type: 'runtime:props';
    componentName: string;
    instanceId?: string;
    props: Record<string, SerializedValue>;
    changedKeys?: string[];
    timestamp: number;
}
interface RuntimeNodePropsMessage {
    type: 'runtime:nodeProps';
    /** Path-based node ID (e.g., "App-0/Dashboard-0/Card-2") */
    nodeId: string;
    /** Serialized props from fiber.memoizedProps */
    props: Record<string, SerializedValue>;
    timestamp: number;
}
interface RuntimeZustandUpdateMessage {
    type: 'runtime:zustand';
    storeName: string;
    state: Record<string, SerializedValue>;
    changedKeys: string[];
    timestamp: number;
}
interface RuntimeReduxUpdateMessage {
    type: 'runtime:redux';
    /** Current state snapshot */
    state: Record<string, SerializedValue>;
    /** Keys that changed */
    changedKeys: string[];
    timestamp: number;
}
interface RuntimeRouterUpdateMessage {
    type: 'runtime:router';
    pathname: string;
    params: Record<string, string>;
    searchParams: Record<string, string>;
    timestamp: number;
}
interface RuntimeContextUpdateMessage {
    type: 'runtime:context';
    contextName: string;
    value: SerializedValue;
    consumers?: string[];
    timestamp: number;
}
interface RuntimeDisconnectMessage {
    type: 'runtime:disconnect';
    reason?: string;
}
interface RuntimeTreeSnapshotMessage {
    type: 'runtime:treeSnapshot';
    /** Full component tree from fiber traversal */
    tree: LiveTreeNode;
    /** Timestamp when snapshot was taken */
    timestamp: number;
}
/**
 * Incremental tree diff — sent instead of a full snapshot when the tree
 * structure hasn't changed dramatically. Reduces WebSocket payload by ~80-95%
 * compared to sending the full tree every time.
 *
 * The extension reconstructs the full tree by applying diffs to its cached copy.
 * A full snapshot is sent every FULL_SNAPSHOT_INTERVAL (10) diffs to prevent drift,
 * and whenever the extension detects a sequence gap.
 */
interface RuntimeTreeDiffMessage {
    type: 'runtime:treeDiff';
    /** Monotonic sequence number — extension uses this to detect missed diffs */
    seq: number;
    /** Nodes added since last snapshot (includes parentId for tree insertion) */
    added: Array<LiveTreeNode & {
        parentId: string;
    }>;
    /** Node IDs removed since last snapshot */
    removed: string[];
    /** Nodes whose mutable fields changed (renderDuration, renderPhase, renderReason) */
    updated: Array<{
        id: string;
        renderDuration?: number;
        renderPhase?: 'mount' | 'update';
        renderReason?: 'mount' | 'props-changed' | 'state-or-context' | 'parent';
    }>;
    timestamp: number;
}
/**
 * A node in the live component tree captured from React fiber tree.
 * Path-based IDs ensure stability across snapshots for React Flow animations.
 */
interface LiveTreeNode {
    /** Path-based ID: "App-0/Dashboard-0/Card-2" (component name + child index among same-type siblings) */
    id: string;
    /** Component display name */
    name: string;
    /** Child components (host elements like div/span are filtered out) */
    children: LiveTreeNode[];
    /** Serialized props (functions filtered, values truncated) */
    props?: Record<string, SerializedValue>;
    /** Fiber tag: 0=Function, 1=Class, 11=ForwardRef, 14=Memo, 15=SimpleMemo */
    fiberTag: number;
    /** Mount on first render, update on re-render */
    renderPhase?: 'mount' | 'update';
    /** Render duration in ms (from Profiler) */
    renderDuration?: number;
    /** Source file path from _debugSource (dev mode only) */
    filePath?: string;
    /** Source line number from _debugSource (dev mode only) */
    lineNumber?: number;
    /** Why this component rendered (detected via fiber.alternate props comparison) */
    renderReason?: 'mount' | 'props-changed' | 'state-or-context' | 'parent';
}
/**
 * Messages received from extension
 */
type ExtensionToRuntimeMessage = {
    type: 'ext:ping';
} | {
    type: 'ext:startTracking';
    options?: TrackingOptions;
} | {
    type: 'ext:stopTracking';
} | {
    type: 'ext:requestState';
    componentName?: string;
} | {
    type: 'ext:requestNodeProps';
    nodeId: string;
} | {
    type: 'ext:startTreeTracking';
} | {
    type: 'ext:stopTreeTracking';
} | {
    type: 'ext:requestFullSnapshot';
};
interface TrackingOptions {
    trackAllRenders?: boolean;
    componentFilter?: string[];
    includeProps?: boolean;
    trackZustand?: boolean;
    trackRedux?: boolean;
    trackRouter?: boolean;
    trackContext?: boolean;
    batchSize?: number;
    batchDelayMs?: number;
}
/**
 * FloTrace provider configuration
 */
interface FloTraceConfig {
    /** WebSocket server port (default: 3457) */
    port?: number;
    /** App name to display in FloTrace */
    appName?: string;
    /** Enable/disable tracking (default: true in development) */
    enabled?: boolean;
    /** Auto-reconnect on disconnect (default: true) */
    autoReconnect?: boolean;
    /** Reconnect interval in ms (default: 2000) */
    reconnectInterval?: number;
    /** Track all renders or only specific components */
    trackAllRenders?: boolean;
    /** Include props in render events (default: true) */
    includeProps?: boolean;
    /** Track Zustand stores (default: true) */
    trackZustand?: boolean;
    /** Track Redux store (default: true) */
    trackRedux?: boolean;
    /** Track React Router (default: true) */
    trackRouter?: boolean;
    /** Track Context (default: true) */
    trackContext?: boolean;
}
/**
 * Default configuration
 */
declare const DEFAULT_CONFIG: Required<FloTraceConfig>;

type MessageHandler = (message: ExtensionToRuntimeMessage) => void;
type ConnectionHandler = (connected: boolean) => void;
/**
 * WebSocket client for connecting to FloTrace VS Code extension.
 * Handles connection, reconnection, and message batching.
 */
declare class FloTraceWebSocketClient {
    private ws;
    private config;
    private messageQueue;
    private flushTimeout;
    private reconnectTimeout;
    private isConnecting;
    private reconnectAttempts;
    private static readonly MAX_RECONNECT_ATTEMPTS;
    private static readonly MAX_RECONNECT_INTERVAL;
    private messageHandlers;
    private connectionHandlers;
    constructor(config?: FloTraceConfig);
    /**
     * Connect to the FloTrace WebSocket server
     */
    connect(): void;
    /**
     * Disconnect from the server
     */
    disconnect(): void;
    /**
     * Send a message to the extension (queued and batched)
     */
    send(message: RuntimeMessage): void;
    /**
     * Send a message immediately (not batched)
     */
    sendImmediate(message: RuntimeMessage): void;
    /**
     * Flush the message queue
     */
    private flush;
    /**
     * Schedule a reconnection attempt
     */
    private scheduleReconnect;
    /**
     * Handle incoming message from extension
     */
    private handleMessage;
    /**
     * Notify connection state change
     */
    private notifyConnectionChange;
    /**
     * Add a message handler
     */
    onMessage(handler: MessageHandler): () => void;
    /**
     * Add a connection state handler
     */
    onConnectionChange(handler: ConnectionHandler): () => void;
    /**
     * Check if connected
     */
    get connected(): boolean;
    /**
     * Get React version if available
     */
    private getReactVersion;
}
/**
 * Get or create the singleton WebSocket client
 */
declare function getWebSocketClient(config?: FloTraceConfig): FloTraceWebSocketClient;
/**
 * Dispose the singleton client
 */
declare function disposeWebSocketClient(): void;

/**
 * Redux Store Tracker for @flotrace/runtime
 *
 * Subscribes to a Redux store and sends state change notifications
 * to the FloTrace VS Code extension.
 *
 * Design: User passes their Redux store via the `reduxStore` prop on <FloTraceProvider>.
 * We subscribe via store.subscribe() and use store.getState() to capture state.
 *
 * Key difference from Zustand tracker:
 * - Redux store.subscribe() callback receives no arguments
 * - We must call store.getState() manually and diff against previous snapshot
 * - Redux is a single global store (no multi-store record)
 */

/** Minimal Redux store interface — only what we need to subscribe */
interface ReduxStoreApi {
    subscribe: (listener: () => void) => () => void;
    getState: () => Record<string, unknown>;
}
/**
 * Validate that an object looks like a Redux store.
 * Checks for getState, subscribe, and dispatch as functions.
 */
declare function isReduxStore(obj: unknown): obj is ReduxStoreApi;
/**
 * Install Redux store tracking.
 * Subscribes to the store and sends runtime:redux messages on state change.
 */
declare function installReduxTracker(store: ReduxStoreApi, client: FloTraceWebSocketClient): void;
/**
 * Uninstall Redux store tracking.
 */
declare function uninstallReduxTracker(): void;

/**
 * Context for FloTrace runtime state
 */
interface FloTraceContextValue {
    connected: boolean;
    enabled: boolean;
    config: Required<FloTraceConfig>;
}
/**
 * Hook to access FloTrace context
 */
declare function useFloTrace(): FloTraceContextValue | null;
/**
 * Props for FloTraceProvider
 */
interface FloTraceProviderProps {
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
    stores?: Record<string, {
        subscribe: (...args: unknown[]) => () => void;
        getState: () => Record<string, unknown>;
    }>;
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
declare function FloTraceProvider({ children, config, stores, reduxStore }: FloTraceProviderProps): JSX.Element;
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
declare function withFloTrace<P extends object>(Component: React.ComponentType<P>, displayName?: string): React.FC<P>;
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
declare function useTrackProps(componentName: string, props: Record<string, unknown>): void;

/**
 * Fiber Tree Walker for @flotrace/runtime
 *
 * Captures the full React component hierarchy and sends tree snapshots
 * to the FloTrace VS Code extension via WebSocket.
 *
 * Two strategies for accessing the fiber tree:
 * 1. DevTools Hook: Wraps __REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot (event-driven)
 * 2. DOM Fallback: Finds fibers via __reactFiber$ keys on DOM elements (works without DevTools)
 *
 * The DOM fallback is triggered by requestTreeSnapshot() which is called
 * from the Profiler's onRender callback - so tree walks happen after each React commit.
 */

/**
 * Minimal fiber type - only the fields we access.
 * React fibers are internal, so we type just what we use.
 */
interface Fiber {
    tag: number;
    type: FiberType | null;
    child: Fiber | null;
    sibling: Fiber | null;
    return: Fiber | null;
    memoizedProps: Record<string, unknown> | null;
    actualDuration?: number;
    alternate?: Fiber | null;
    stateNode?: unknown;
    _debugSource?: {
        fileName: string;
        lineNumber: number;
    } | null;
}
type FiberType = {
    name?: string;
    displayName?: string;
    render?: {
        name?: string;
        displayName?: string;
    };
    type?: {
        name?: string;
        displayName?: string;
    };
};
/**
 * FiberRoot from React internals (what onCommitFiberRoot receives)
 */
interface FiberRoot {
    current: Fiber;
}
/**
 * The global hook React DevTools uses. We piggyback on it.
 */
interface DevToolsHook {
    onCommitFiberRoot?: (rendererID: number, root: FiberRoot, priority?: number) => void;
}
declare global {
    interface Window {
        __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook & Record<string, unknown>;
    }
}
/**
 * Request a tree snapshot using the DOM fallback approach.
 * Called from FloTraceProvider's Profiler onRender callback after each React commit.
 * This is the primary way to trigger tree walks when DevTools hook isn't available.
 */
declare function requestTreeSnapshot(): void;
/**
 * Install the fiber tree walker.
 *
 * Strategy 1 (preferred): Hook into __REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot
 * Strategy 2 (fallback): DOM-based fiber access, triggered by requestTreeSnapshot()
 *
 * Tree snapshots are always sent WITHOUT props (structure only).
 * Props are fetched on demand via getNodeProps() when the user selects a node.
 *
 * @returns Cleanup function to uninstall
 */
declare function installFiberTreeWalker(): () => void;
/**
 * Uninstall the fiber tree walker, restoring the original hook.
 */
declare function uninstallFiberTreeWalker(): void;

/**
 * Zustand Store Tracker for @flotrace/runtime
 *
 * Subscribes to explicitly registered Zustand stores and sends
 * state change notifications to the FloTrace VS Code extension.
 *
 * Design: User registers stores via the `stores` prop on <FloTraceProvider>.
 * We subscribe to each store's .subscribe() method and use .getState()
 * to capture state on change.
 *
 * Why explicit registration vs. automatic detection:
 * - Automatic detection requires patching Zustand internals (fragile across versions)
 * - Explicit registration is simple, reliable, and version-independent
 * - Users can control exactly which stores are tracked
 */

/** Minimal Zustand store interface — only what we need to subscribe */
interface ZustandStoreApi {
    subscribe: (listener: (state: Record<string, unknown>, prevState: Record<string, unknown>) => void) => () => void;
    getState: () => Record<string, unknown>;
}
/**
 * Install Zustand store tracking.
 * Subscribes to each store and sends runtime:zustand messages on state change.
 */
declare function installZustandTracker(stores: Record<string, ZustandStoreApi>, client: FloTraceWebSocketClient): void;
/**
 * Uninstall Zustand store tracking, unsubscribing from all stores.
 */
declare function uninstallZustandTracker(): void;

/**
 * Router Tracker for @flotrace/runtime
 *
 * Automatically tracks URL navigation by patching the browser's History API.
 * Sends pathname and search params to the FloTrace VS Code extension on every
 * navigation event (pushState, replaceState, popstate).
 *
 * Why History API patching:
 * - React Router (and all SPA routers) ultimately use history.pushState/replaceState
 * - Works with any router library (React Router, TanStack Router, Next.js, etc.)
 * - Zero user code changes — no hooks or components to install
 * - Covers programmatic navigation, link clicks, and back/forward buttons
 *
 * Limitation: We get pathname + search params but NOT matched route params
 * (e.g., /users/:id → { id: '123' }). Those require React Router context access
 * and can be added as a future enhancement.
 */

/**
 * Install router tracking.
 * Patches history.pushState/replaceState and listens for popstate events
 * to detect all navigation in the browser.
 */
declare function installRouterTracker(wsClient: FloTraceWebSocketClient): void;
/**
 * Uninstall router tracking, restoring original History methods.
 */
declare function uninstallRouterTracker(): void;

/**
 * Serialize a value for safe transmission over WebSocket.
 * Handles circular references, functions, symbols, and large values.
 */
declare function serializeValue(value: unknown, depth?: number, seen?: WeakSet<object>): SerializedValue;
/**
 * Serialize props object, filtering out React internals and children
 */
declare function serializeProps(props: Record<string, unknown>): Record<string, SerializedValue>;

export { DEFAULT_CONFIG, type FloTraceConfig, FloTraceProvider, type FloTraceProviderProps, FloTraceWebSocketClient, type LiveTreeNode, type ReduxStoreApi, type SerializedValue, type TrackingOptions, disposeWebSocketClient, getWebSocketClient, installFiberTreeWalker, installReduxTracker, installRouterTracker, installZustandTracker, isReduxStore, requestTreeSnapshot, serializeProps, serializeValue, uninstallFiberTreeWalker, uninstallReduxTracker, uninstallRouterTracker, uninstallZustandTracker, useFloTrace, useTrackProps, withFloTrace };
