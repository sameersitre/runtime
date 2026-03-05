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

import type { LiveTreeNode, RuntimeTreeDiffMessage, SerializedValue, DetailedRenderReason, PropChange, HookInfo, EffectInfo } from "./types";
import { serializeValue, serializeProps } from "./serializer";
import { getWebSocketClient } from "./websocketClient";
import { inspectHooks } from "./hookInspector";
import { inspectEffects } from "./effectInspector";
import { recordTimelineEvent } from "./timelineTracker";
export type { SerializedValue };

// React fiber tag constants (from React source: ReactWorkTags.js)
const FIBER_TAGS = {
  FunctionComponent: 0,
  ClassComponent: 1,
  HostRoot: 3, // Root of a host tree (e.g., #root DOM node)
  HostComponent: 5, // DOM elements (div, span, etc.) - SKIP these
  HostText: 6, // Text nodes - SKIP these
  Fragment: 7, // React.Fragment - SKIP but traverse children
  Mode: 8, // React.StrictMode, ConcurrentMode - SKIP but traverse children
  ContextConsumer: 9,
  ContextProvider: 10,
  ForwardRef: 11,
  Profiler: 12, // React.Profiler - SKIP but traverse children
  SuspenseComponent: 13,
  MemoComponent: 14,
  SimpleMemoComponent: 15,
  LazyComponent: 16,
  OffscreenComponent: 22, // React 18 concurrent features - SKIP but traverse children
} as const;

// Fiber tags that represent user components (not host/DOM elements)
const USER_COMPONENT_TAGS: Set<number> = new Set([
  FIBER_TAGS.FunctionComponent,
  FIBER_TAGS.ClassComponent,
  FIBER_TAGS.ForwardRef,
  FIBER_TAGS.MemoComponent,
  FIBER_TAGS.SimpleMemoComponent,
]);

/**
 * Minimal fiber type - only the fields we access.
 * React fibers are internal, so we type just what we use.
 */
export interface Fiber {
  tag: number;
  type: FiberType | null;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  memoizedProps: Record<string, unknown> | null;
  pendingProps: Record<string, unknown> | null;
  actualDuration?: number;
  alternate?: Fiber | null;
  stateNode?: unknown;
  _debugSource?: { fileName: string; lineNumber: number } | null;
  /** Hook state linked list head (useState, useRef, useMemo, etc.) */
  memoizedState: FiberHookState | null;
  /** Effect queue (useEffect, useLayoutEffect circular list) */
  updateQueue: FiberUpdateQueue | null;
  /** Fiber flags (for detecting force updates, etc.) */
  flags: number;
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
export interface FiberHookState {
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
export interface FiberEffect {
  tag: number;
  create: (() => (() => void) | void) | null;
  destroy: (() => void) | null;
  deps: unknown[] | null;
  next: FiberEffect | null;
}

interface FiberUpdateQueue {
  lastEffect: FiberEffect | null;
}

interface FiberDependencies {
  firstContext: FiberContextDependency | null;
}

interface FiberContextDependency {
  context: { _currentValue: unknown; displayName?: string };
  memoizedValue: unknown;
  next: FiberContextDependency | null;
}

type FiberType = {
  name?: string;
  displayName?: string;
  // ForwardRef/Memo wrap an inner type
  render?: { name?: string; displayName?: string };
  type?: { name?: string; displayName?: string };
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
  onCommitFiberRoot?: (
    rendererID: number,
    root: FiberRoot,
    priority?: number,
  ) => void;
}

declare global {
  interface Window {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook & Record<string, unknown>;
  }
}

// Tree size limits to prevent JSON.stringify "Invalid string length" errors
// in large apps (e.g., tables with hundreds of rows)
const MAX_TREE_DEPTH = 100; // Max nesting depth of user components
const MAX_CHILDREN_PER_NODE = 300; // Max children per user component node

// Debounce timer for tree snapshot sending.
// Uses adaptive rate: small trees get frequent snapshots, large trees get
// throttled to avoid blocking the user's app main thread with walkFiber() + JSON.stringify().
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS_SMALL = 200; // < 50 components → 5 snapshots/sec
const DEBOUNCE_MS_MEDIUM = 500; // 50-200 components → 2 snapshots/sec
const DEBOUNCE_MS_LARGE = 1000; // 200+ components → 1 snapshot/sec
let currentDebounceMs = DEBOUNCE_MS_SMALL; // Starts fast, adapts after first snapshot

// Track whether we're currently walking (to avoid recursive/concurrent walks)
let isWalking = false;

// Store the original hook so we can restore it
let originalOnCommitFiberRoot: DevToolsHook["onCommitFiberRoot"] | null = null;
let isInstalled = false;
let hookedRendererID: number | null = null;

// Track which strategy is active
let activeStrategy: "devtools" | "dom" | null = null;

// Track when the last snapshot was actually sent, so the Profiler-based
// fallback can kick in if the DevTools hook stops firing (React 19 compat).
let lastSnapshotSentTime = 0;
const DEVTOOLS_STALE_THRESHOLD_MS = 2000; // If no DevTools snapshot in 2s, allow DOM fallback

// Fiber reference cache: nodeId → fiber, rebuilt on every tree walk.
// Used for on-demand props lookup (getNodeProps) so we don't re-walk the tree.
// Fiber references stay valid because React reuses fiber objects across renders.
let fiberRefMap: Map<string, Fiber> = new Map();

/**
 * Get the display name of a fiber's component type.
 */
function getComponentName(fiber: Fiber): string {
  const type = fiber.type;
  if (!type) return "Unknown";

  // Direct function/class component
  if (typeof type === "function") {
    return (
      (type as FiberType).displayName || (type as FiberType).name || "Anonymous"
    );
  }

  // Object-based types (ForwardRef, Memo)
  if (typeof type === "object" && type !== null) {
    const t = type as FiberType;
    // Memo wraps type
    if (t.type) {
      return t.type.displayName || t.type.name || "Memo";
    }
    // ForwardRef wraps render
    if (t.render) {
      return t.render.displayName || t.render.name || "ForwardRef";
    }
    return t.displayName || t.name || "Unknown";
  }

  // String type means host component (div, span)
  if (typeof type === "string") {
    return type;
  }

  return "Unknown";
}

/**
 * Check if a fiber represents a user-defined component (not a library/framework internal).
 * Uses _debugSource (available in dev mode) as primary heuristic, with name-based fallback.
 */
function isUserComponent(fiber: Fiber): boolean {
  if (!USER_COMPONENT_TAGS.has(fiber.tag)) return false;

  const name = getComponentName(fiber);

  // Filter generic React wrapper names that have no specific component identity
  if (
    name === "Anonymous" ||
    name === "Unknown" ||
    name === "ForwardRef" ||
    name === "Memo"
  )
    return false;

  // Filter library-style displayNames (e.g., "@mantine/core/Box", "@radix-ui/Popover")
  // Libraries set displayName with package path — user components never have @ or /
  if (name.startsWith("@") || name.includes("/")) return false;

  // If _debugSource points to node_modules, it's a library component
  if (fiber._debugSource?.fileName?.includes("node_modules")) return false;

  return true;
}

// ============================================================================
// Framework component detection
// ============================================================================

/**
 * Known framework/library wrapper component names.
 * These pass isUserComponent() but are framework internals users typically don't want to see.
 */
const FRAMEWORK_COMPONENT_NAMES: Set<string> = new Set([
  // Next.js App Router internals
  "InnerLayoutRouter", "OuterLayoutRouter", "HotReload", "RedirectBoundary",
  "NotFoundBoundary", "RenderFromTemplateContext", "ScrollAndFocusHandler",
  "AppRouter", "ServerRoot", "ReactDevOverlay", "PathnameContextProviderAdapter",
  "MetadataBoundary", "ViewportBoundary", "NotFoundErrorBoundary",
  "RedirectErrorBoundary", "InnerScrollAndFocusHandler", "GlobalError",
  // React Router v6
  "Routes", "Route", "Router", "BrowserRouter", "HashRouter", "MemoryRouter",
  "Outlet", "Navigate", "RenderedRoute", "RouterProvider",
  // Common wrappers
  "Suspense", "ErrorBoundary", "QueryClientProvider", "PersistGate",
]);

/**
 * File path patterns indicating framework/library source.
 */
const FRAMEWORK_PATH_PATTERNS: RegExp[] = [
  /next[\\/]dist/,
  /react-router/,
  /react-dom/,
  /@tanstack[\\/]/,
  /react-redux/,
];

/**
 * Detect if a user-visible component is actually a framework/library wrapper.
 * Called only for fibers that already passed isUserComponent().
 */
function isFrameworkComponent(fiber: Fiber, name: string): boolean {
  if (FRAMEWORK_COMPONENT_NAMES.has(name)) return true;

  const filePath = fiber._debugSource?.fileName;
  if (filePath) {
    for (const pattern of FRAMEWORK_PATH_PATTERNS) {
      if (pattern.test(filePath)) return true;
    }
  }

  return false;
}

/**
 * Build a path-based stable ID for a fiber node.
 * Format: "App-0/Dashboard-0/Card-2"
 */
function buildNodeId(
  name: string,
  sameNameIndex: number,
  parentId: string,
): string {
  const segment = `${name}-${sameNameIndex}`;
  return parentId ? `${parentId}/${segment}` : segment;
}

/**
 * Shallow-compare two props objects by reference equality per key.
 * Returns true if any key was added, removed, or changed reference.
 */
function shallowPropsChanged(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): boolean {
  if (prev === next) return false;
  if (!prev || !next) return true;

  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);

  if (prevKeys.length !== nextKeys.length) return true;

  for (const key of nextKeys) {
    // Skip React internal keys (children is always "changed" on re-render)
    if (key === 'children') continue;
    if (prev[key] !== next[key]) return true;
  }

  return false;
}

/**
 * Determine why a fiber re-rendered by comparing current vs previous props.
 */
function detectRenderReason(
  fiber: Fiber,
  renderPhase: 'mount' | 'update',
): 'mount' | 'props-changed' | 'state-or-context' | 'parent' {
  if (renderPhase === 'mount') return 'mount';

  // fiber.alternate holds the previous version of this fiber
  const prev = fiber.alternate;
  if (!prev) return 'mount';

  // Compare props: if props changed, that's the reason
  if (shallowPropsChanged(prev.memoizedProps, fiber.memoizedProps)) {
    return 'props-changed';
  }

  // Props are identical — the render was caused by internal state change
  // (useState, useReducer, useContext) or a parent re-render forcing this component
  // We can't reliably distinguish state vs context vs parent without accessing
  // memoizedState (unstable internal), so we use a single bucket
  return 'state-or-context';
}

/**
 * Walk the fiber tree starting from a fiber node.
 * Skips host elements and transparent wrappers, keeps user components.
 *
 * @param sharedNameCountMap - When provided, this map is shared across recursive calls
 *   for transparent wrappers at the same logical level. This prevents duplicate IDs
 *   when sibling wrappers (e.g., <div>, SortableItem) each contain a user component
 *   with the same name — a common pattern in lists/tables.
 */
function walkFiber(
  fiber: Fiber | null,
  parentId: string,
  sharedNameCountMap?: Map<string, number>,
  depth = 0,
): LiveTreeNode[] {
  if (!fiber) return [];

  // Stop recursing if tree is too deep to prevent oversized snapshots
  if (depth >= MAX_TREE_DEPTH) return [];

  const nodes: LiveTreeNode[] = [];
  let current: Fiber | null = fiber;

  // Use shared map if provided (for promoted children from transparent wrappers),
  // otherwise create a new one for this sibling group
  const nameCountMap = sharedNameCountMap || new Map<string, number>();

  while (current) {
    // Per-node try-catch so one bad fiber doesn't kill the entire tree walk
    try {
      const tag = current.tag;

      if (isUserComponent(current)) {
        const name = getComponentName(current);
        const nameCount = nameCountMap.get(name) || 0;
        nameCountMap.set(name, nameCount + 1);

        const nodeId = buildNodeId(name, nameCount, parentId);

        // Store fiber reference for on-demand props lookup via getNodeProps()
        fiberRefMap.set(nodeId, current);

        const renderPhase: "mount" | "update" = current.alternate
          ? "update"
          : "mount";
        const renderReason = detectRenderReason(current, renderPhase);

        // Record timeline event for this component
        recordTimelineEvent(
          nodeId,
          name,
          renderPhase === 'mount' ? 'mount' : 'render',
          { reason: renderReason },
          current.actualDuration,
        );

        // Children of a user component start with a fresh nameCountMap (new parent level)
        // Increment depth for user component nesting
        const children = walkFiber(
          current.child,
          nodeId,
          undefined,
          depth + 1,
        );

        // Truncate children if there are too many (e.g., large tables/lists)
        const truncatedChildren =
          children.length > MAX_CHILDREN_PER_NODE
            ? children.slice(0, MAX_CHILDREN_PER_NODE)
            : children;

        const framework = isFrameworkComponent(current, name) || undefined;
        nodes.push({
          id: nodeId,
          name,
          children: truncatedChildren,
          fiberTag: tag,
          renderPhase,
          renderReason,
          renderDuration: current.actualDuration,
          filePath: current._debugSource?.fileName,
          lineNumber: current._debugSource?.lineNumber,
          isFramework: framework,
        });
      } else if (tag === FIBER_TAGS.HostText) {
        // Text nodes have no children to traverse - skip entirely
      } else {
        // For transparent wrappers (host components, fragments, providers, etc.):
        // skip the node itself but walk children — user components may be nested inside.
        // Pass the SAME nameCountMap so promoted children from different wrapper siblings
        // get unique indices (e.g., Row-0, Row-1 instead of both being Row-0).
        // Transparent wrappers don't increment depth (they're not user components)
        const childNodes = walkFiber(
          current.child,
          parentId,
          nameCountMap,
          depth,
        );
        nodes.push(...childNodes);
      }
    } catch (error) {
      console.error('[FloTrace] Error processing fiber node, skipping:', error);
    }

    current = current.sibling;
  }

  return nodes;
}

/**
 * Build a complete LiveTreeNode tree from a FiberRoot.
 * Props are NOT included in the tree — they are fetched on demand via getNodeProps().
 * This keeps tree snapshots small and avoids JSON.stringify overflow on large apps.
 */
function buildTreeFromFiberRoot(root: FiberRoot): LiveTreeNode | null {
  const rootFiber = root.current;
  if (!rootFiber || !rootFiber.child) {
    console.warn("[FloTrace] No root fiber or no child:", {
      hasRoot: !!rootFiber,
      hasChild: !!rootFiber?.child,
    });
    return null;
  }

  // Clear fiber reference map before rebuilding
  fiberRefMap = new Map();

  const topLevelNodes = walkFiber(rootFiber.child, "");
  console.log(
    "[FloTrace] walkFiber found",
    topLevelNodes.length,
    "top-level nodes",
  );

  if (topLevelNodes.length === 1) {
    return topLevelNodes[0];
  }

  if (topLevelNodes.length > 0) {
    return {
      id: "Root",
      name: "Root",
      children: topLevelNodes,
      fiberTag: FIBER_TAGS.HostRoot,
    };
  }

  return null;
}

// ============================================================================
// DOM-based fiber root discovery (fallback when DevTools hook is unavailable)
// ============================================================================

/**
 * Find the React fiber root by looking at DOM elements.
 * React attaches fibers to DOM nodes as __reactFiber$ (React 18+)
 * or __reactInternalInstance$ (React 16/17) properties.
 */
function findFiberRootFromDOM(): FiberRoot | null {
  try {
    if (typeof document === "undefined") return null;

    // Common root element selectors
    const selectors = ["#root", "#__next", "#app", "#__nuxt", "[data-reactroot]"];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;

      console.log(
        `[FloTrace] Trying selector "${selector}" → found element`,
        element.tagName,
        element.id,
      );
      const reactKeys = Object.keys(element).filter(
        (k) => k.startsWith("__react") || k.startsWith("_react"),
      );
      console.log(`[FloTrace] React keys on element:`, reactKeys);

      const fiberRoot = getFiberRootFromElement(element);
      if (fiberRoot) {
        console.log("[FloTrace] Found fiber root from selector:", selector);
        return fiberRoot;
      }
    }

    // Fallback: check ALL direct children of <body>
    const allBodyChildren = document.body?.children;
    if (allBodyChildren) {
      console.log(
        "[FloTrace] Scanning all",
        allBodyChildren.length,
        "body children for React root...",
      );
      for (const child of Array.from(allBodyChildren)) {
        const reactKeys = Object.keys(child).filter(
          (k) => k.startsWith("__react") || k.startsWith("_react"),
        );
        if (reactKeys.length > 0) {
          console.log(
            "[FloTrace] React keys on",
            child.tagName,
            child.id || "(no id)",
            ":",
            reactKeys,
          );
        }
        const fiberRoot = getFiberRootFromElement(child);
        if (fiberRoot) {
          console.log(
            "[FloTrace] Found fiber root from body child scan:",
            child.tagName,
            child.id || "(no id)",
          );
          return fiberRoot;
        }
      }
    }

    console.warn(
      "[FloTrace] Could not find React fiber root from any DOM element",
    );
    return null;
  } catch (error) {
    console.error("[FloTrace] Error finding fiber root from DOM:", error);
    return null;
  }
}

/**
 * Get the FiberRoot from a DOM element.
 *
 * React attaches internal properties to DOM elements:
 * - React 18 createRoot: __reactContainer$xxx on the ROOT element (value = HostRoot fiber)
 * - React 18 child elements: __reactFiber$xxx (value = element's fiber)
 * - React 17 ReactDOM.render: _reactRootContainer on the ROOT element
 * - React 16/17 child elements: __reactInternalInstance$xxx
 */
function getFiberRootFromElement(element: Element): FiberRoot | null {
  const keys = Object.keys(element);

  // Strategy 1: React 18 createRoot - root element has __reactContainer$xxx
  // This is the HostRoot fiber directly
  const containerKey = keys.find((k) => k.startsWith("__reactContainer$"));
  if (containerKey) {
    const hostRootFiber = (element as unknown as Record<string, Fiber>)[
      containerKey
    ];
    if (hostRootFiber?.stateNode) {
      return hostRootFiber.stateNode as FiberRoot;
    }
  }

  // Strategy 2: React 18 child elements or React 16/17 - __reactFiber$ / __reactInternalInstance$
  const fiberKey = keys.find(
    (k) =>
      k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"),
  );
  if (fiberKey) {
    const fiber = (element as unknown as Record<string, Fiber>)[fiberKey];
    if (fiber) {
      // Walk up to find the HostRoot fiber
      let current: Fiber | null = fiber;
      while (current?.return) {
        current = current.return;
      }
      if (current && current.tag === FIBER_TAGS.HostRoot && current.stateNode) {
        return current.stateNode as FiberRoot;
      }
    }
  }

  // Strategy 3: React 17 ReactDOM.render - _reactRootContainer on root element
  const el = element as unknown as {
    _reactRootContainer?: { _internalRoot?: FiberRoot };
  };
  if (el._reactRootContainer?._internalRoot) {
    return el._reactRootContainer._internalRoot;
  }

  return null;
}

// ============================================================================
// Snapshot sending (shared by both strategies)
// ============================================================================

/**
 * Send a tree snapshot with adaptive debounce based on tree size.
 *
 * Small trees (< 50 nodes) → 200ms debounce (5/sec)
 * Medium trees (50-200 nodes) → 500ms debounce (2/sec)
 * Large trees (200+ nodes) → 1000ms debounce (1/sec)
 *
 * The debounce interval is recalculated after every snapshot based on the
 * actual node count from fiberRefMap.size. This prevents large apps from
 * spending too much main-thread time in walkFiber() + JSON.stringify().
 */
function sendDebouncedSnapshot(root: FiberRoot): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;

    if (isWalking) {
      console.log("[FloTrace] Skipped snapshot: already walking");
      return;
    }
    isWalking = true;

    try {
      const tree = buildTreeFromFiberRoot(root);
      if (!tree) {
        console.warn("[FloTrace] buildTreeFromFiberRoot returned null");
        return;
      }

      // Adapt debounce for next snapshot based on current tree size.
      // fiberRefMap is populated during buildTreeFromFiberRoot → walkFiber().
      const nodeCount = fiberRefMap.size;
      if (nodeCount >= 200) {
        currentDebounceMs = DEBOUNCE_MS_LARGE;
      } else if (nodeCount >= 50) {
        currentDebounceMs = DEBOUNCE_MS_MEDIUM;
      } else {
        currentDebounceMs = DEBOUNCE_MS_SMALL;
      }

      const client = getWebSocketClient();
      if (!client.connected) {
        console.warn(
          "[FloTrace] WebSocket not connected, cannot send tree snapshot",
        );
        return;
      }

      // Flatten the current tree for diff computation
      const currentFlatTree = flattenTree(tree);

      // Decide: full snapshot or incremental diff?
      // Full snapshot when: first time, forced reset, or every Nth snapshot to prevent drift
      const sendFull =
        previousFlatTree === null ||
        snapshotCounter % FULL_SNAPSHOT_INTERVAL === 0;

      if (sendFull) {
        console.log(
          "[FloTrace] Sending FULL tree snapshot, root:",
          tree.name,
          "nodes:",
          nodeCount,
          "seq:", snapshotCounter,
          "nextDebounce:",
          currentDebounceMs + "ms",
        );
        client.sendImmediate({
          type: "runtime:treeSnapshot",
          tree,
          timestamp: Date.now(),
        });
        lastSnapshotSentTime = Date.now();
        // Reset diff sequence on full snapshot
        diffSeq = 0;
      } else {
        // Compute incremental diff against previous snapshot
        const diff = computeTreeDiff(previousFlatTree!, currentFlatTree);
        if (diff) {
          console.log(
            "[FloTrace] Sending tree diff, seq:",
            diffSeq,
            "added:", diff.added.length,
            "removed:", diff.removed.length,
            "updated:", diff.updated.length,
          );
          client.sendImmediate({
            type: "runtime:treeDiff",
            seq: diffSeq,
            added: diff.added,
            removed: diff.removed,
            updated: diff.updated,
            timestamp: Date.now(),
          });
          lastSnapshotSentTime = Date.now();
          diffSeq++;
        } else {
          // Nothing changed — skip sending entirely to save bandwidth
          console.log("[FloTrace] Tree unchanged, skipping diff");
        }
      }

      // Cache current tree for next diff computation
      previousFlatTree = currentFlatTree;
      snapshotCounter++;
    } catch (error) {
      console.error("[FloTrace] Error walking fiber tree:", error);
    } finally {
      isWalking = false;
    }
  }, currentDebounceMs);
}

// ============================================================================
// Incremental Tree Diffs
// ============================================================================

// Previous tree flattened into a Map<nodeId, node> for O(1) diff lookups.
// null = no previous tree → next snapshot must be a full one.
let previousFlatTree: Map<string, LiveTreeNode> | null = null;

// Monotonic sequence number for diffs — extension detects gaps to request resync
let diffSeq = 0;

// Counter for periodic full snapshots to prevent drift from accumulated diffs
let snapshotCounter = 0;
const FULL_SNAPSHOT_INTERVAL = 10; // Send full snapshot every 10th to resync

/**
 * Flatten a tree into a Map<id, node> for O(1) lookups during diff computation.
 * Does NOT include children in the map values (the map is keyed by node.id only).
 */
function flattenTree(root: LiveTreeNode, out: Map<string, LiveTreeNode> = new Map()): Map<string, LiveTreeNode> {
  out.set(root.id, root);
  for (const child of root.children) {
    flattenTree(child, out);
  }
  return out;
}

/**
 * Derive the parent ID from a node's path-based ID.
 * E.g., "App-0/Dashboard-0/Card-2" → "App-0/Dashboard-0"
 * Returns empty string for root nodes (no "/" in ID).
 */
function getParentId(nodeId: string): string {
  const lastSlash = nodeId.lastIndexOf('/');
  return lastSlash === -1 ? '' : nodeId.substring(0, lastSlash);
}

/**
 * Compute an incremental diff between the previous and current tree snapshots.
 *
 * - **added**: nodes present in `curr` but not in `prev` (new components mounted)
 * - **removed**: node IDs present in `prev` but not in `curr` (components unmounted)
 * - **updated**: nodes in both where renderDuration, renderPhase, or renderReason changed
 *
 * Returns null if the diff is empty (nothing changed) — caller should skip sending.
 */
function computeTreeDiff(
  prev: Map<string, LiveTreeNode>,
  curr: Map<string, LiveTreeNode>,
): RuntimeTreeDiffMessage['added'] extends Array<infer _> ? {
  added: Array<LiveTreeNode & { parentId: string }>;
  removed: string[];
  updated: RuntimeTreeDiffMessage['updated'];
} | null : never {
  const added: Array<LiveTreeNode & { parentId: string }> = [];
  const removed: string[] = [];
  const updated: RuntimeTreeDiffMessage['updated'] = [];

  // Detect added + updated nodes
  for (const [id, currNode] of curr) {
    const prevNode = prev.get(id);
    if (!prevNode) {
      // New node — include full data + parentId for insertion
      added.push({ ...currNode, children: [], parentId: getParentId(id) });
    } else {
      // Existing node — check if mutable fields changed
      if (
        prevNode.renderDuration !== currNode.renderDuration ||
        prevNode.renderPhase !== currNode.renderPhase ||
        prevNode.renderReason !== currNode.renderReason
      ) {
        updated.push({
          id,
          renderDuration: currNode.renderDuration,
          renderPhase: currNode.renderPhase,
          renderReason: currNode.renderReason,
        });
      }
    }
  }

  // Detect removed nodes
  for (const id of prev.keys()) {
    if (!curr.has(id)) {
      removed.push(id);
    }
  }

  // Return null if nothing changed — no need to send an empty diff
  if (added.length === 0 && removed.length === 0 && updated.length === 0) {
    return null;
  }

  return { added, removed, updated };
}

// ============================================================================
// Public API
// ============================================================================

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
export function requestTreeSnapshot(): void {
  if (!isInstalled) {
    return;
  }

  // If using DevTools hook strategy AND it's been sending snapshots recently, skip.
  // Otherwise fall through to DOM fallback (React 19 compat safety net).
  if (activeStrategy === "devtools") {
    const elapsed = Date.now() - lastSnapshotSentTime;
    if (elapsed < DEVTOOLS_STALE_THRESHOLD_MS) return;
    console.log("[FloTrace] DevTools hook stale (" + elapsed + "ms), falling back to DOM snapshot");
  }

  // DOM fallback: find the fiber root from DOM elements
  const root = findFiberRootFromDOM();
  if (root) {
    sendDebouncedSnapshot(root);
  }
}

/**
 * Force the next snapshot to be a full tree (not a diff).
 * Called when the extension detects a sequence gap or on explicit refresh.
 * Resets diff state so the next sendDebouncedSnapshot sends runtime:treeSnapshot.
 */
export function requestFullSnapshot(): void {
  previousFlatTree = null;
  snapshotCounter = 0;
  diffSeq = 0;
}

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
export function installFiberTreeWalker(): () => void {
  if (isInstalled) {
    console.warn("[FloTrace] Fiber tree walker already installed");
    return () => uninstallFiberTreeWalker();
  }

  if (typeof window === "undefined") {
    console.warn(
      "[FloTrace] Not in browser environment, cannot install fiber tree walker",
    );
    return () => {};
  }

  isInstalled = true;

  // Strategy 1: Try DevTools hook
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook && typeof hook.onCommitFiberRoot === "function") {
    originalOnCommitFiberRoot = hook.onCommitFiberRoot;

    hook.onCommitFiberRoot = (
      rendererID: number,
      root: FiberRoot,
      priority?: number,
    ) => {
      // Call original handler first (React DevTools)
      if (originalOnCommitFiberRoot) {
        try {
          originalOnCommitFiberRoot(rendererID, root, priority);
        } catch (error) {
          console.error(
            "[FloTrace] Error in original onCommitFiberRoot:",
            error,
          );
        }
      }

      if (hookedRendererID === null) {
        hookedRendererID = rendererID;
      }

      // Only track the first renderer
      if (rendererID !== hookedRendererID) return;

      sendDebouncedSnapshot(root);
    };

    activeStrategy = "devtools";
    console.log(
      "[FloTrace] Fiber tree walker installed (DevTools hook strategy)",
    );

    // Send an initial snapshot via DOM fallback (don't wait for next React commit)
    setTimeout(() => {
      try {
        const root = findFiberRootFromDOM();
        if (root) {
          sendDebouncedSnapshot(root);
        }
      } catch (error) {
        console.error('[FloTrace] Error sending initial DevTools snapshot:', error);
      }
    }, 100);
  } else {
    // Strategy 2: DOM fallback - snapshots are triggered by requestTreeSnapshot()
    activeStrategy = "dom";
    console.log(
      "[FloTrace] Fiber tree walker installed (DOM fallback strategy)",
    );

    // Send an initial snapshot immediately by finding the fiber root from DOM
    setTimeout(() => {
      try {
        const root = findFiberRootFromDOM();
        if (root) {
          sendDebouncedSnapshot(root);
        }
      } catch (error) {
        console.error('[FloTrace] Error sending initial DOM fallback snapshot:', error);
      }
    }, 100);
  }

  return () => uninstallFiberTreeWalker();
}

/**
 * Get serialized props for a specific node by ID.
 * Looks up the fiber reference cached during the last tree walk and serializes
 * its current memoizedProps. Returns null if the node is not found (e.g., unmounted).
 */
export function getNodeProps(nodeId: string): Record<string, SerializedValue> | null {
  const fiber = fiberRefMap.get(nodeId);
  if (!fiber || !fiber.memoizedProps) {
    return null;
  }
  try {
    return serializeProps(fiber.memoizedProps);
  } catch (error) {
    console.error(`[FloTrace] Error serializing props for node "${nodeId}":`, error);
    return null;
  }
}

// ============================================================================
// Console-Free Debugging: Enhanced Render Reason, Hook/Effect Inspection
// ============================================================================

/**
 * Enhanced render reason with specific prop/state/context changes.
 * Called on-demand (not during tree walk) to avoid performance overhead.
 */
export function detectDetailedRenderReason(fiber: Fiber): DetailedRenderReason {
  if (!fiber.alternate) return { type: 'mount' };

  const prev = fiber.alternate;

  // 1. Check props changes with prev/next values
  if (shallowPropsChanged(prev.memoizedProps, fiber.memoizedProps)) {
    const changedProps = diffProps(prev.memoizedProps, fiber.memoizedProps);
    return { type: 'props-changed', changedProps };
  }

  // 2. Check state hooks by walking memoizedState linked list
  const changedHookIndices = diffHookStates(prev.memoizedState, fiber.memoizedState);
  if (changedHookIndices.length > 0) {
    return { type: 'state-changed', changedHookIndices };
  }

  // 3. Check context dependencies
  const changedContexts = detectContextChanges(fiber);
  if (changedContexts.length > 0) {
    return { type: 'context-changed', contextNames: changedContexts };
  }

  // 4. Parent render fallback
  const parentName = fiber.return ? getComponentName(fiber.return) : undefined;
  return { type: 'parent-render', parentName };
}

/**
 * Diff two props objects and return the specific keys that changed with values.
 */
function diffProps(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): PropChange[] {
  const changes: PropChange[] = [];
  if (!prev || !next) return changes;

  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    if (key === 'children') continue;
    if (!Object.is(prev[key], next[key])) {
      changes.push({
        key,
        prev: serializeValue(prev[key], 0, new WeakSet()),
        next: serializeValue(next[key], 0, new WeakSet()),
      });
    }
  }
  return changes;
}

/**
 * Walk two memoizedState linked lists in parallel, comparing by reference.
 * Returns indices of hooks whose memoizedState changed.
 */
function diffHookStates(
  prev: FiberHookState | null,
  next: FiberHookState | null,
): number[] {
  const changed: number[] = [];
  let prevHook = prev;
  let nextHook = next;
  let index = 0;

  while (prevHook && nextHook) {
    // Only compare hooks that have a queue (state hooks: useState, useReducer)
    // Skip effect/memo/ref hooks since their memoizedState changes don't mean "state update"
    if (prevHook.queue !== null || nextHook.queue !== null) {
      if (!Object.is(prevHook.memoizedState, nextHook.memoizedState)) {
        changed.push(index);
      }
    }
    prevHook = prevHook.next;
    nextHook = nextHook.next;
    index++;
  }

  return changed;
}

/**
 * Detect context changes by examining fiber.dependencies.
 * React 18+ stores context dependencies as a linked list.
 */
function detectContextChanges(fiber: Fiber): string[] {
  const changed: string[] = [];
  if (!fiber.dependencies?.firstContext) return changed;

  let ctx: FiberContextDependency | null = fiber.dependencies.firstContext;
  while (ctx) {
    try {
      // Compare memoized value (from last render) with current context value
      if (!Object.is(ctx.memoizedValue, ctx.context._currentValue)) {
        const name = ctx.context.displayName || 'UnknownContext';
        changed.push(name);
      }
    } catch {
      // Skip if context access fails
    }
    ctx = ctx.next;
  }

  return changed;
}

/**
 * Get detailed render reason for a specific node by ID.
 * Uses fiberRefMap to look up the cached fiber reference.
 */
export function getDetailedRenderReason(nodeId: string): DetailedRenderReason | null {
  const fiber = fiberRefMap.get(nodeId);
  if (!fiber) return null;
  try {
    return detectDetailedRenderReason(fiber);
  } catch (error) {
    console.error(`[FloTrace] Error detecting render reason for "${nodeId}":`, error);
    return null;
  }
}

/**
 * Get all hooks for a specific node by ID.
 * Returns null if the node is not found (e.g., unmounted).
 */
export function getNodeHooks(nodeId: string): HookInfo[] | null {
  const fiber = fiberRefMap.get(nodeId);
  if (!fiber) return null;
  try {
    return inspectHooks(fiber);
  } catch (error) {
    console.error(`[FloTrace] Error inspecting hooks for node "${nodeId}":`, error);
    return null;
  }
}

/**
 * Get all effects for a specific node by ID.
 * Returns null if the node is not found (e.g., unmounted).
 */
export function getNodeEffects(nodeId: string): EffectInfo[] | null {
  const fiber = fiberRefMap.get(nodeId);
  if (!fiber) return null;
  try {
    return inspectEffects(fiber);
  } catch (error) {
    console.error(`[FloTrace] Error inspecting effects for node "${nodeId}":`, error);
    return null;
  }
}

/**
 * Get the fiberRefMap for external use (e.g., console tracker fiber attribution).
 */
export function getFiberRefMap(): Map<string, Fiber> {
  return fiberRefMap;
}

/**
 * Uninstall the fiber tree walker, restoring the original hook.
 */
export function uninstallFiberTreeWalker(): void {
  if (!isInstalled) return;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  // Restore DevTools hook if we wrapped it
  if (activeStrategy === "devtools" && typeof window !== "undefined") {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook) {
      if (originalOnCommitFiberRoot) {
        hook.onCommitFiberRoot = originalOnCommitFiberRoot;
      } else {
        delete hook.onCommitFiberRoot;
      }
    }
  }

  originalOnCommitFiberRoot = null;
  hookedRendererID = null;
  activeStrategy = null;
  fiberRefMap = new Map();
  previousFlatTree = null;
  snapshotCounter = 0;
  diffSeq = 0;
  lastSnapshotSentTime = 0;
  isInstalled = false;
  console.log("[FloTrace] Fiber tree walker uninstalled");
}
