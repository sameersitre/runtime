/**
 * Types for @flotrace/runtime package
 * These mirror the shared types from the extension but are standalone
 * to avoid importing from the extension package.
 */

/**
 * Serialized value for safe transmission over WebSocket
 */
export type SerializedValue =
  | null
  | boolean
  | number
  | string
  | SerializedValue[]
  | { [key: string]: SerializedValue }
  | { __type: 'function'; name?: string }
  | { __type: 'undefined' }
  | { __type: 'symbol'; description?: string }
  | { __type: 'circular' }
  | { __type: 'truncated'; originalType: string; length?: number };

/**
 * Messages sent from runtime to extension
 */
export type RuntimeMessage =
  | RuntimeReadyMessage
  | RuntimeRenderMessage
  | RuntimePropsUpdateMessage
  | RuntimeNodePropsMessage
  | RuntimeZustandUpdateMessage
  | RuntimeReduxUpdateMessage
  | RuntimeRouterUpdateMessage
  | RuntimeContextUpdateMessage
  | RuntimeDisconnectMessage
  | RuntimeTreeSnapshotMessage
  | RuntimeTreeDiffMessage;

export interface RuntimeReadyMessage {
  type: 'runtime:ready';
  appName?: string;
  reactVersion?: string;
  appUrl?: string;
}

export interface RuntimeRenderMessage {
  type: 'runtime:render';
  componentName: string;
  filePath?: string;
  phase: 'mount' | 'update';
  actualDuration: number;
  baseDuration: number;
  timestamp: number;
  instanceId?: string;
}

export interface RuntimePropsUpdateMessage {
  type: 'runtime:props';
  componentName: string;
  instanceId?: string;
  props: Record<string, SerializedValue>;
  changedKeys?: string[];
  timestamp: number;
}

export interface RuntimeNodePropsMessage {
  type: 'runtime:nodeProps';
  /** Path-based node ID (e.g., "App-0/Dashboard-0/Card-2") */
  nodeId: string;
  /** Serialized props from fiber.memoizedProps */
  props: Record<string, SerializedValue>;
  timestamp: number;
}

export interface RuntimeZustandUpdateMessage {
  type: 'runtime:zustand';
  storeName: string;
  state: Record<string, SerializedValue>;
  changedKeys: string[];
  timestamp: number;
}

export interface RuntimeReduxUpdateMessage {
  type: 'runtime:redux';
  /** Current state snapshot */
  state: Record<string, SerializedValue>;
  /** Keys that changed */
  changedKeys: string[];
  timestamp: number;
}

export interface RuntimeRouterUpdateMessage {
  type: 'runtime:router';
  pathname: string;
  params: Record<string, string>;
  searchParams: Record<string, string>;
  timestamp: number;
}

export interface RuntimeContextUpdateMessage {
  type: 'runtime:context';
  contextName: string;
  value: SerializedValue;
  consumers?: string[];
  timestamp: number;
}

export interface RuntimeDisconnectMessage {
  type: 'runtime:disconnect';
  reason?: string;
}

export interface RuntimeTreeSnapshotMessage {
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
export interface RuntimeTreeDiffMessage {
  type: 'runtime:treeDiff';
  /** Monotonic sequence number — extension uses this to detect missed diffs */
  seq: number;
  /** Nodes added since last snapshot (includes parentId for tree insertion) */
  added: Array<LiveTreeNode & { parentId: string }>;
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

// ============================================================================
// Live Tree Types
// ============================================================================

/**
 * A node in the live component tree captured from React fiber tree.
 * Path-based IDs ensure stability across snapshots for React Flow animations.
 */
export interface LiveTreeNode {
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
export type ExtensionToRuntimeMessage =
  | { type: 'ext:ping' }
  | { type: 'ext:startTracking'; options?: TrackingOptions }
  | { type: 'ext:stopTracking' }
  | { type: 'ext:requestState'; componentName?: string }
  | { type: 'ext:requestNodeProps'; nodeId: string }
  | { type: 'ext:startTreeTracking' }
  | { type: 'ext:stopTreeTracking' }
  | { type: 'ext:requestFullSnapshot' };

export interface TrackingOptions {
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
export interface FloTraceConfig {
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
export const DEFAULT_CONFIG: Required<FloTraceConfig> = {
  port: 3457,
  appName: 'React App',
  enabled: process.env.NODE_ENV === 'development',
  autoReconnect: true,
  reconnectInterval: 2000,
  trackAllRenders: true,
  includeProps: true,
  trackZustand: true,
  trackRedux: true,
  trackRouter: true,
  trackContext: true,
};
