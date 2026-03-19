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
type RuntimeMessage = RuntimeReadyMessage | RuntimeRenderMessage | RuntimePropsUpdateMessage | RuntimeNodePropsMessage | RuntimeZustandUpdateMessage | RuntimeReduxUpdateMessage | RuntimeRouterUpdateMessage | RuntimeContextUpdateMessage | RuntimeDisconnectMessage | RuntimeTreeSnapshotMessage | RuntimeTreeDiffMessage | RuntimeNodeHooksMessage | RuntimeNodeEffectsMessage | RuntimeDetailedRenderReasonMessage | RuntimeTimelineEventMessage | RuntimeTanStackQueryUpdateMessage | RuntimeRenderTriggerMessage | RuntimeRenderCascadeMessage | RuntimePropDrillingMessage | RuntimeActionStateMessage | RuntimeOptimisticDiffMessage | RuntimeNextjsContextMessage | RuntimeRscPayloadMessage | RuntimeHydrationEventMessage | RuntimeNetworkRequestMessage | RuntimeLocalStateCorrelationMessage;
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
    /** Per-request causal correlation: each entry maps a requestId to the specific store keys
     *  whose values came from that fetch response (WeakMap causal correlation). */
    correlatedRequests?: Array<{
        requestId: string;
        storeKeys: string[];
    }>;
    timestamp: number;
}
interface RuntimeReduxUpdateMessage {
    type: 'runtime:redux';
    /** Current state snapshot */
    state: Record<string, SerializedValue>;
    /** Keys that changed */
    changedKeys: string[];
    /** Per-request causal correlation: each entry maps a requestId to the specific store keys
     *  whose values came from that fetch response (WeakMap causal correlation). */
    correlatedRequests?: Array<{
        requestId: string;
        storeKeys: string[];
    }>;
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
 * React Compiler memoization status for a component.
 * Detected by checking for the React Compiler memo cache sentinel in fiber state.
 * Mirrors the CompilerStatus type in src/shared/liveMessages.ts.
 */
type CompilerStatus = 'compiled' | 'manual' | 'unoptimized' | 'de-opted';
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
    /** True if this component is a framework/library wrapper (Next.js, React Router, etc.) */
    isFramework?: boolean;
    /** React key prop (only string keys, used to differentiate same-name siblings in search) */
    reactKey?: string;
    /** TanStack Query hashes observed by this component (detected from useRef → QueryObserver) */
    queryHashes?: string[];
    /** Number of hooks in this component (counted from memoizedState linked list) */
    hookCount?: number;
    /** True if any hook is useContext (indicates data may come from context, not just props) */
    hasContextHook?: boolean;
    /** True if a useTransition hook on this component currently has isPending=true */
    isTransitionPending?: boolean;
    /** True if this component is currently rendering inside a Suspense fallback branch */
    isSuspenseFallback?: boolean;
    /** React Compiler memoization status (undefined = not analyzed / compiler not detected) */
    compilerStatus?: CompilerStatus;
    /** True if this is detected as a Next.js Server Component (heuristic) */
    isServerComponent?: boolean;
    /** True if this is the first client component below a server component boundary */
    isClientBoundary?: boolean;
    /** True if this component is from a third-party library, not user-defined code */
    isLibrary?: boolean;
    /** Short display label for the library source (e.g. 'framer', 'fontawesome', 'sonner') */
    libraryName?: string;
}
/**
 * Enhanced render reason with specific prop/state/context changes.
 */
type DetailedRenderReasonType = 'mount' | 'props-changed' | 'state-changed' | 'context-changed' | 'parent-render' | 'force-update';
interface PropChange {
    key: string;
    prev: SerializedValue;
    next: SerializedValue;
}
type DetailedRenderReason = {
    type: 'mount';
} | {
    type: 'props-changed';
    changedProps: PropChange[];
} | {
    type: 'state-changed';
    changedHookIndices: number[];
} | {
    type: 'context-changed';
    contextNames: string[];
} | {
    type: 'parent-render';
    parentName?: string;
} | {
    type: 'force-update';
};
/**
 * Hook type classification — inferred from fiber.memoizedState shape.
 */
type HookType = 'useState' | 'useReducer' | 'useRef' | 'useMemo' | 'useCallback' | 'useEffect' | 'useLayoutEffect' | 'useInsertionEffect' | 'useContext' | 'useImperativeHandle' | 'useDebugValue' | 'useTransition' | 'useDeferredValue' | 'useId' | 'useSyncExternalStore' | 'useOptimistic' | 'useFormStatus' | 'unknown';
/**
 * Information about a single hook in a component's hook linked list.
 */
interface HookInfo {
    /** Position in the hook linked list (0-based) */
    index: number;
    /** Classified hook type */
    type: HookType;
    /** Serialized current value (state for useState, ref.current for useRef, etc.) */
    value: SerializedValue;
    /** For useMemo/useCallback/useEffect: serialized dependency array */
    deps?: SerializedValue[];
    /** Hook name hint from _debugHookTypes if available */
    debugLabel?: string;
}
/**
 * Information about a single effect (useEffect/useLayoutEffect/useInsertionEffect).
 */
interface EffectInfo {
    /** Position in the effect circular list (0-based) */
    index: number;
    /** Corresponding hook index in the memoizedState list */
    hookIndex: number;
    /** Effect type derived from tag bitmask */
    type: 'useEffect' | 'useLayoutEffect' | 'useInsertionEffect';
    /** Current dependency array (null = no deps, runs every render) */
    deps: SerializedValue[] | null;
    /** Previous dependency array from fiber.alternate */
    prevDeps: SerializedValue[] | null;
    /** Indices of deps that changed (triggering this effect to run) */
    changedDepIndices: number[];
    /** Whether this effect will execute on this render */
    willRun: boolean;
    /** Whether the previous effect returned a cleanup function */
    hasCleanup: boolean;
}
/**
 * Component lifecycle event types for the timeline.
 */
type TimelineEventType = 'mount' | 'unmount' | 'render' | 'effect-run' | 'effect-cleanup' | 'state-update' | 'props-change';
/**
 * A single event in a component's lifecycle timeline.
 */
interface TimelineEvent {
    type: TimelineEventType;
    timestamp: number;
    /** Render duration in ms (for render events) */
    duration?: number;
    /** Additional context (e.g., which hook, which prop) */
    detail?: SerializedValue;
}
interface RuntimeNodeHooksMessage {
    type: 'runtime:nodeHooks';
    nodeId: string;
    hooks: HookInfo[];
    timestamp: number;
}
interface RuntimeNodeEffectsMessage {
    type: 'runtime:nodeEffects';
    nodeId: string;
    effects: EffectInfo[];
    timestamp: number;
}
interface RuntimeDetailedRenderReasonMessage {
    type: 'runtime:detailedRenderReason';
    nodeId: string;
    reason: DetailedRenderReason;
    timestamp: number;
}
interface RuntimeTimelineEventMessage {
    type: 'runtime:timelineEvent';
    nodeId: string;
    componentName: string;
    event: TimelineEvent;
}
/** Serialized query info sent over WebSocket */
interface TanStackQueryInfo {
    queryKey: SerializedValue;
    queryHash: string;
    status: 'pending' | 'error' | 'success';
    fetchStatus: 'idle' | 'fetching' | 'paused';
    dataUpdatedAt: number;
    errorUpdatedAt: number;
    isInvalidated: boolean;
    isStale: boolean;
    isActive: boolean;
    isDisabled: boolean;
    failureCount: number;
    errorMessage?: string;
    observerCount: number;
    /** Config values */
    staleTime?: number;
    gcTime?: number;
    /** Additional config for health analysis */
    refetchInterval?: number | false;
    refetchOnWindowFocus?: boolean | 'always';
    refetchOnMount?: boolean | 'always';
    refetchOnReconnect?: boolean | 'always';
    networkMode?: string;
    enabled?: boolean;
    retry?: number | boolean;
    /** Data shape descriptor (key names + types, no values) */
    dataShape?: SerializedValue;
    /** Number of times query refetched but data was identical */
    wastedRefetchCount?: number;
    /** Total number of fetches tracked */
    totalFetchCount?: number;
    /** Per-query state transition history (ring buffer, max 50) */
    events?: TanStackQueryEvent[];
    /** requestId of the API call whose response was stored in this query's cache (WeakMap causal) */
    correlatedRequestId?: string;
}
/** A state transition event for a TanStack Query */
interface TanStackQueryEvent {
    timestamp: number;
    /** Status before the transition */
    fromStatus: string;
    /** Status after the transition */
    toStatus: string;
    /** Fetch status before the transition */
    fromFetchStatus: string;
    /** Fetch status after the transition */
    toFetchStatus: string;
    /** Whether the data changed during this transition */
    dataChanged: boolean;
}
/** Serialized mutation info sent over WebSocket */
interface TanStackMutationInfo {
    mutationId: number;
    status: 'idle' | 'pending' | 'error' | 'success';
    isPaused: boolean;
    submittedAt: number;
    failureCount: number;
    errorMessage?: string;
    mutationKey?: SerializedValue;
    scope?: string;
    /** Correlation ID linking this mutation to queries it triggered */
    lastCorrelationId?: string;
}
/** Mutation → query invalidation → refetch correlation event */
interface MutationCorrelation {
    /** Unique ID for this correlation event */
    correlationId: string;
    /** The mutation that triggered the cascade */
    mutationId: number;
    /** Mutation key (if provided) for display */
    mutationKey?: SerializedValue;
    /** Timestamp when mutation completed (status → 'success') */
    mutationCompletedAt: number;
    /** Queries that started fetching within the correlation window */
    affectedQueries: Array<{
        queryHash: string;
        queryKey: SerializedValue;
        /** When the query started fetching */
        fetchStartedAt: number;
        /** Latency: fetchStartedAt - mutationCompletedAt */
        latencyMs: number;
        /** Whether the refetch actually changed data */
        dataChanged?: boolean;
    }>;
    /** Timestamp when the correlation window closed */
    resolvedAt: number;
}
interface RuntimeTanStackQueryUpdateMessage {
    type: 'runtime:tanstackQuery';
    queries: TanStackQueryInfo[];
    mutations: TanStackMutationInfo[];
    /** New correlation events since last snapshot */
    correlations?: MutationCorrelation[];
    timestamp: number;
}
interface StackFrame {
    functionName: string | null;
    fileName: string | null;
    lineNumber: number | null;
    columnNumber: number | null;
    /** false for node_modules / react-dom / react-reconciler frames */
    isUserCode: boolean;
}
interface TriggerRecord {
    triggerId: string;
    fiberId: string;
    componentName: string;
    hookIndex: number;
    hookType: 'state' | 'reducer' | 'setState' | 'forceUpdate';
    stack: StackFrame[];
    timestamp: number;
    action: SerializedValue | null;
    batchId: string | null;
}
type CascadeReason = 'state-update' | 'context-update' | 'props-changed' | 'parent-cascade' | 'force-update' | 'bailed-out';
interface CascadeNode {
    nodeId: string;
    componentName: string;
    reason: CascadeReason;
    renderDuration: number;
    subtreeDuration: number;
    changedProps?: string[];
    hookIndex?: number;
    triggerId?: string;
    children: CascadeNode[];
    depth: number;
    isMemoized: boolean;
}
type LanePriority = 'sync' | 'discrete' | 'continuous' | 'default' | 'transition' | 'deferred' | 'idle' | 'offscreen';
interface LaneInfo {
    priority: LanePriority;
    lanes: number;
    isTransition: boolean;
    isBlocking: boolean;
}
interface CascadeRecord {
    commitId: string;
    timestamp: number;
    totalDuration: number;
    totalComponents: number;
    avoidableCount: number;
    avoidableDuration: number;
    rootCauses: CascadeNode[];
    lane: LaneInfo;
    triggerIds: string[];
}
interface RuntimeRenderTriggerMessage {
    type: 'runtime:renderTrigger';
    trigger: TriggerRecord;
}
interface RuntimeRenderCascadeMessage {
    type: 'runtime:renderCascade';
    cascade: CascadeRecord;
}
interface PropDrillingChainNode {
    nodeId: string;
    componentName: string;
    propKey: string;
    role: 'source' | 'passthrough' | 'consumer';
    hookCount: number;
    hasContextHook: boolean;
}
interface PropDrillingChain {
    chainId: string;
    propName: string;
    sourceNodeId: string;
    sourceComponentName: string;
    consumerNodeIds: string[];
    consumerComponentNames: string[];
    path: PropDrillingChainNode[];
    depth: number;
    passthroughCount: number;
    severity: 'info' | 'warning' | 'critical';
    renames: Array<{
        atNodeId: string;
        fromKey: string;
        toKey: string;
    }>;
}
interface RuntimePropDrillingMessage {
    type: 'runtime:propDrilling';
    payload: {
        chains: PropDrillingChain[];
        passthroughNodeIds: string[];
        analysisTimestamp: number;
        treeSize: number;
    };
}
/** Sent whenever a useActionState or useOptimistic hook changes on any fiber */
interface RuntimeActionStateMessage {
    type: 'runtime:actionState';
    nodeId: string;
    componentName: string;
    /** One entry per useActionState / useOptimistic hook on this fiber */
    actions: Array<{
        hookIndex: number;
        hookKind: 'action' | 'optimistic';
        isPending: boolean;
        state: SerializedValue;
        error?: SerializedValue;
        pendingSince?: number;
        durationMs?: number;
    }>;
    timestamp: number;
}
/** Sent when a useOptimistic value diverges from its underlying actual value */
interface RuntimeOptimisticDiffMessage {
    type: 'runtime:optimisticDiff';
    nodeId: string;
    componentName: string;
    hookIndex: number;
    optimisticValue: SerializedValue;
    actualValue: SerializedValue;
    timestamp: number;
}
/** Sent once on mount when the Next.js environment is detected */
interface RuntimeNextjsContextMessage {
    type: 'runtime:nextjsContext';
    detected: boolean;
    version?: string;
    isAppRouter: boolean;
    initialRoute?: string;
    timestamp: number;
}
/** Sent when an RSC / Next.js data fetch is intercepted (metadata only, no values) */
interface RuntimeRscPayloadMessage {
    type: 'runtime:rscPayload';
    route: string;
    payloadSizeBytes: number;
    cacheStatus: 'HIT' | 'MISS' | 'STALE' | 'unknown';
    timestamp: number;
}
/** Sent when React hydration completes or a mismatch is detected */
interface RuntimeHydrationEventMessage {
    type: 'runtime:hydrationEvent';
    kind: 'complete' | 'mismatch';
    durationMs?: number;
    errorMessage?: string;
    timestamp: number;
}
/** Metadata for a single intercepted network request. Privacy-first: no bodies, no query params, no auth headers. */
interface NetworkRequestEntry {
    /** Incrementing request ID */
    requestId: string;
    /** HTTP method (GET, POST, PUT, DELETE, PATCH, etc.) */
    method: string;
    /** URL path only — query params stripped for privacy */
    urlPath: string;
    /** URL host for endpoint grouping */
    urlHost: string;
    /** HTTP status code (0 if pending/aborted) */
    status: number;
    /** Request duration in ms (null if still pending) */
    durationMs: number | null;
    /** Response size from Content-Length header (null if unavailable) */
    responseSizeBytes: number | null;
    /** React component that initiated this request (if attributable) */
    componentName?: string;
    /** Ancestor chain of the initiating component (last 3) */
    ancestorChain?: string[];
    /** True if fetch was called during React render phase (anti-pattern) */
    initiatedDuringRender: boolean;
    /** True if fetch was called inside a useEffect callback */
    initiatedInEffect: boolean;
    /** Request lifecycle state */
    state: 'pending' | 'success' | 'error' | 'aborted';
    /** Deduplication key: `${method}:${normalizedPath}` for duplicate detection */
    dedupeKey: string;
    /** True if another request with same dedupeKey was made within 2s */
    isDuplicate?: boolean;
    /** True if this is a Next.js Server Action (POST with Next-Action header) */
    isServerAction?: boolean;
    /** True if this is a Next.js RSC prefetch (Next-Router-Prefetch header) */
    isPrefetch?: boolean;
    /** Error message if request failed */
    errorMessage?: string;
    /** Timestamp (Date.now()) */
    timestamp: number;
}
/** Batched network request message sent to FloTrace server */
interface RuntimeNetworkRequestMessage {
    type: 'runtime:networkRequest';
    requests: NetworkRequestEntry[];
    timestamp: number;
}
/** Emitted when a fiber's useState/useReducer hook holds API response data (WeakMap causal) */
interface RuntimeLocalStateCorrelationMessage {
    type: 'runtime:localStateCorrelation';
    requestId: string;
    componentName: string;
    hookIndex: number;
    timestamp: number;
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
} | {
    type: 'ext:requestNodeHooks';
    nodeId: string;
} | {
    type: 'ext:requestNodeEffects';
    nodeId: string;
} | {
    type: 'ext:requestDetailedRenderReason';
    nodeId: string;
} | {
    type: 'ext:requestTimeline';
    nodeId: string;
} | {
    type: 'ext:startNetworkCapture';
} | {
    type: 'ext:stopNetworkCapture';
} | {
    type: 'ext:startReduxTracking';
} | {
    type: 'ext:stopReduxTracking';
} | {
    type: 'ext:startRouterTracking';
} | {
    type: 'ext:stopRouterTracking';
} | {
    type: 'ext:startZustandTracking';
} | {
    type: 'ext:stopZustandTracking';
} | {
    type: 'ext:startTanstackTracking';
} | {
    type: 'ext:stopTanstackTracking';
};
interface TrackingOptions {
    trackAllRenders?: boolean;
    componentFilter?: string[];
    includeProps?: boolean;
    trackZustand?: boolean;
    trackRedux?: boolean;
    trackRouter?: boolean;
    trackContext?: boolean;
    trackTanstackQuery?: boolean;
    trackNetwork?: boolean;
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
    /** Track TanStack Query (default: true) */
    trackTanstackQuery?: boolean;
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
    private static readonly BATCH_FLUSH_MS;
    private static readonly MAX_QUEUE_SIZE;
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
 * TanStack Query Tracker for @flotrace/runtime
 *
 * Subscribes to QueryCache and MutationCache events and sends
 * query/mutation state snapshots to the FloTrace desktop app.
 *
 * Features:
 * - Cache state snapshots with config for health analysis
 * - Wasted refetch detection (data unchanged across fetches)
 * - Per-query state transition timeline (ring buffer)
 * - Mutation → query correlation (detects invalidation cascades)
 *
 * Uses duck-typed interface — no @tanstack/react-query dependency needed.
 */

/** Minimal Query interface — only what we need to read state */
interface DuckQuery {
    queryKey: unknown[];
    queryHash: string;
    state: {
        status: 'pending' | 'success' | 'error';
        fetchStatus: 'idle' | 'fetching' | 'paused';
        data: unknown;
        error: unknown;
        dataUpdatedAt: number;
        errorUpdatedAt: number;
        isInvalidated: boolean;
        fetchFailureCount: number;
        fetchFailureReason: unknown;
    };
    options: {
        staleTime?: number;
        gcTime?: number;
        retry?: number | boolean;
        refetchInterval?: number | false;
        refetchOnWindowFocus?: boolean | 'always';
        refetchOnMount?: boolean | 'always';
        refetchOnReconnect?: boolean | 'always';
        networkMode?: 'online' | 'always' | 'offlineFirst';
        enabled?: boolean;
        meta?: Record<string, unknown>;
    };
    getObserversCount(): number;
    isStale(): boolean;
    isActive(): boolean;
    isDisabled(): boolean;
}
/** Minimal Mutation interface */
interface DuckMutation {
    mutationId: number;
    state: {
        status: 'idle' | 'pending' | 'error' | 'success';
        isPaused: boolean;
        submittedAt: number;
        variables: unknown;
        error: unknown;
        failureCount: number;
    };
    options: {
        mutationKey?: unknown[];
        scope?: {
            id: string;
        };
    };
}
/** Minimal QueryCache interface */
interface DuckQueryCache {
    getAll(): DuckQuery[];
    subscribe(cb: (event: {
        type: string;
        query?: DuckQuery;
    }) => void): () => void;
}
/** Minimal MutationCache interface */
interface DuckMutationCache {
    getAll(): DuckMutation[];
    subscribe(cb: (event: {
        type: string;
        mutation?: DuckMutation;
    }) => void): () => void;
}
/** Duck-typed QueryClient — what we need from the user */
interface TanStackQueryClientApi {
    getQueryCache(): DuckQueryCache;
    getMutationCache(): DuckMutationCache;
}
/** Validate that an object looks like a TanStack QueryClient */
declare function isTanStackQueryClient(obj: unknown): obj is TanStackQueryClientApi;
/**
 * Install TanStack Query tracking.
 * Subscribes to QueryCache and MutationCache and sends runtime:tanstackQuery messages.
 */
declare function installTanStackQueryTracker(queryClient: TanStackQueryClientApi, client: FloTraceWebSocketClient): void;
/**
 * Uninstall TanStack Query tracking.
 */
declare function uninstallTanStackQueryTracker(): void;

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
declare function FloTraceProvider({ children, config, stores, reduxStore, queryClient }: FloTraceProviderProps): JSX.Element;
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
    key: string | null;
    type: FiberType | null;
    child: Fiber | null;
    sibling: Fiber | null;
    return: Fiber | null;
    memoizedProps: Record<string, unknown> | null;
    pendingProps: Record<string, unknown> | null;
    actualDuration?: number;
    alternate?: Fiber | null;
    stateNode?: unknown;
    _debugSource?: {
        fileName: string;
        lineNumber: number;
    } | null;
    /** Hook state linked list head (useState, useRef, useMemo, etc.) */
    memoizedState: FiberHookState | null;
    /** Effect queue (useEffect, useLayoutEffect circular list) */
    updateQueue: FiberUpdateQueue | null;
    /** Fiber flags (for detecting force updates, etc.) */
    flags: number;
    /** Pending work lanes on this fiber */
    lanes: number;
    /** Pending work lanes on this fiber's subtree */
    childLanes: number;
    /** Element type (used for context detection) */
    elementType: unknown;
    /** Context dependencies (React 18+) */
    dependencies: FiberDependencies | null;
    /** Debug hook types array (dev mode: ["useState", "useEffect", ...]) */
    _debugHookTypes?: string[] | null;
}
/**
 * Hook state linked list node from fiber.memoizedState.
 * Each hook call creates one node in this linked list.
 */
interface FiberHookState {
    memoizedState: unknown;
    baseState: unknown;
    baseQueue: unknown;
    queue: {
        pending: unknown;
        lastRenderedReducer: ((...args: unknown[]) => unknown) | null;
        lastRenderedState: unknown;
        dispatch?: (...args: unknown[]) => void;
    } | null;
    next: FiberHookState | null;
}
/**
 * Effect structure in the updateQueue circular linked list.
 * Tag bitmask: HookHasEffect=0b0001, Insertion=0b0010, Layout=0b0100, Passive=0b1000
 */
interface FiberEffect {
    tag: number;
    create: (() => (() => void) | void) | null;
    destroy: (() => void) | null;
    deps: unknown[] | null;
    next: FiberEffect | null;
}
interface FiberUpdateQueue {
    lastEffect: FiberEffect | null;
    /** Class component update queue — pending updates linked list */
    shared?: {
        pending?: unknown;
    };
    /** Lane bits for this queue */
    lanes?: number;
}
interface FiberDependencies {
    firstContext: FiberContextDependency | null;
}
interface FiberContextDependency {
    context: {
        _currentValue: unknown;
        displayName?: string;
    };
    memoizedValue: unknown;
    next: FiberContextDependency | null;
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
 *
 * When the DevTools hook strategy is active, this acts as a safety net:
 * if no snapshot has been sent via onCommitFiberRoot within DEVTOOLS_STALE_THRESHOLD_MS,
 * we fall back to DOM-based snapshots. This handles React 19 compatibility issues
 * where onCommitFiberRoot may not fire reliably for all commits.
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
 * Get detailed render reason for a specific node by ID.
 * Uses fiberRefMap to look up the cached fiber reference.
 */
declare function getDetailedRenderReason(nodeId: string): DetailedRenderReason | null;
/**
 * Get all hooks for a specific node by ID.
 * Returns null if the node is not found (e.g., unmounted).
 */
declare function getNodeHooks(nodeId: string): HookInfo[] | null;
/**
 * Get all effects for a specific node by ID.
 * Returns null if the node is not found (e.g., unmounted).
 */
declare function getNodeEffects(nodeId: string): EffectInfo[] | null;
/**
 * Get the fiberRefMap for external use (e.g., console tracker fiber attribution).
 */
declare function getFiberRefMap(): Map<string, Fiber>;
/**
 * Uninstall the fiber tree walker, restoring the original hook.
 */
declare function uninstallFiberTreeWalker(): void;

/**
 * Hook Inspector for @flotrace/runtime
 *
 * Walks fiber.memoizedState linked list, classifies each hook by type,
 * and serializes values for display in FloTrace.
 *
 * Hook classification uses a combination of:
 * 1. fiber._debugHookTypes (available in dev builds — most reliable)
 * 2. Shape-based inference from memoizedState structure (fallback)
 *
 * Shape heuristics (from React internals):
 * - useState/useReducer: queue !== null (has dispatch/reducer)
 * - useRef: memoizedState is { current: <value> } with single key
 * - useMemo/useCallback: memoizedState is [computedValue, deps]
 * - useEffect/useLayoutEffect: matched against effect circular list via tag bitmask
 */

/**
 * Inspect all hooks in a fiber's memoizedState linked list.
 * Returns an array of HookInfo objects with type, value, and deps.
 */
declare function inspectHooks(fiber: Fiber): HookInfo[];

/**
 * Effect Dependency Tracker for @flotrace/runtime
 *
 * Walks fiber.updateQueue.lastEffect circular linked list to extract
 * all effects (useEffect, useLayoutEffect, useInsertionEffect) with:
 * - Current and previous dependency arrays
 * - Which specific deps changed (triggering the effect)
 * - Whether the effect will run on this render
 * - Whether a cleanup function exists
 *
 * Effect tag bitmask (from React's HookFlags):
 *   HookHasEffect  = 0b0001 (1)  — effect will execute
 *   HookInsertion  = 0b0010 (2)  — useInsertionEffect
 *   HookLayout     = 0b0100 (4)  — useLayoutEffect
 *   HookPassive    = 0b1000 (8)  — useEffect
 */

/**
 * Inspect all effects in a fiber's updateQueue.
 * Compares current deps with previous (from fiber.alternate) to detect changes.
 */
declare function inspectEffects(fiber: Fiber): EffectInfo[];

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
 * Component Event Timeline for @flotrace/runtime
 *
 * Emits lifecycle events (mount, unmount, render, effect-run, effect-cleanup,
 * state-update, props-change) for each component. Events are stored in a
 * ring buffer per component (max 100 events) to prevent memory growth.
 *
 * Events are batched and flushed every 500ms to avoid flooding the WebSocket.
 */

/**
 * Install the timeline tracker.
 * Call once during ext:startTracking.
 */
declare function installTimelineTracker(wsClient: FloTraceWebSocketClient): void;
/**
 * Uninstall the timeline tracker and clean up resources.
 */
declare function uninstallTimelineTracker(): void;
/**
 * Record a lifecycle event for a component.
 * Called from the fiber tree walker during tree walks and from effect trackers.
 *
 * @param nodeId - Path-based node ID (e.g., "App-0/Dashboard-0/Card-2")
 * @param componentName - Component display name
 * @param eventType - Lifecycle event type
 * @param detail - Optional additional context (serialized)
 * @param duration - Optional duration in ms (for render events)
 */
declare function recordTimelineEvent(nodeId: string, componentName: string, eventType: TimelineEventType, detail?: unknown, duration?: number): void;
/**
 * Get the timeline for a specific component (for on-demand requests).
 */
declare function getTimeline(nodeId: string): TimelineEvent[];

/**
 * Network Request Tracker for @flotrace/runtime
 *
 * Patches globalThis.fetch and XMLHttpRequest to capture all network requests
 * with React component attribution. Designed to chain properly with the existing
 * RSC payload interceptor (which patches fetch first for Next.js RSC requests).
 *
 * Key design decisions:
 * - Metadata only: URL path, method, status, timing, size (no bodies, no query params, no auth)
 * - Chains with existing fetch patches (RSC interceptor) — stores current globalThis.fetch, not native
 * - Component attribution via getCurrentRenderingFiber() + effect context (React 18 + 19)
 * - Duplicate detection via sliding 5-second window keyed by method:path
 * - Noise filtering: analytics, HMR, extensions, static assets, FloTrace's own WS
 * - Batched sending: 500ms flush, max 50 entries per batch, 300 entry ring buffer
 * - AbortController support: detects aborted requests
 */

declare function installNetworkTracker(wsClient: FloTraceWebSocketClient): void;
declare function uninstallNetworkTracker(): void;

/**
 * Serialize a value for safe transmission over WebSocket.
 * Handles circular references, functions, symbols, and large values.
 */
declare function serializeValue(value: unknown, depth?: number, seen?: WeakSet<object>): SerializedValue;
/**
 * Serialize props object, filtering out React internals and children
 */
declare function serializeProps(props: Record<string, unknown>): Record<string, SerializedValue>;

export { DEFAULT_CONFIG, type DetailedRenderReason, type DetailedRenderReasonType, type EffectInfo, type Fiber, type FiberEffect, type FiberHookState, type FloTraceConfig, FloTraceProvider, type FloTraceProviderProps, FloTraceWebSocketClient, type HookInfo, type HookType, type LiveTreeNode, type NetworkRequestEntry, type PropChange, type ReduxStoreApi, type SerializedValue, type TanStackMutationInfo, type TanStackQueryClientApi, type TanStackQueryInfo, type TimelineEvent, type TimelineEventType, type TrackingOptions, disposeWebSocketClient, getDetailedRenderReason, getFiberRefMap, getNodeEffects, getNodeHooks, getTimeline, getWebSocketClient, inspectEffects, inspectHooks, installFiberTreeWalker, installNetworkTracker, installReduxTracker, installRouterTracker, installTanStackQueryTracker, installTimelineTracker, installZustandTracker, isReduxStore, isTanStackQueryClient, recordTimelineEvent, requestTreeSnapshot, serializeProps, serializeValue, uninstallFiberTreeWalker, uninstallNetworkTracker, uninstallReduxTracker, uninstallRouterTracker, uninstallTanStackQueryTracker, uninstallTimelineTracker, uninstallZustandTracker, useFloTrace, useTrackProps, withFloTrace };
