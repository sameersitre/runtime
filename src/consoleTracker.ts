/**
 * Console Capture for @flotrace/runtime
 *
 * Monkey-patches console.log/warn/error/info/debug to capture calls
 * with React component attribution. Attempts to identify which component
 * triggered the console call via React's internal current fiber tracking.
 *
 * Key design decisions:
 * - Always calls the original console method first (preserves normal behavior)
 * - Uses a batch buffer (max 50 entries, 500ms flush) to avoid flooding WebSocket
 * - Fiber attribution via React's __SECRET_INTERNALS (works in dev mode)
 * - Skips [FloTrace]-prefixed logs to avoid recursion
 */

import type { ConsoleCaptureEntry, ConsoleLevel, SerializedValue } from './types';
import { serializeValue } from './serializer';
import type { FloTraceWebSocketClient } from './websocketClient';

const METHODS: ConsoleLevel[] = ['log', 'warn', 'error', 'info', 'debug'];
const MAX_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 500;
const MAX_ARGS_PER_ENTRY = 10;
const MAX_BUFFER_SIZE = 300;

const originals = new Map<ConsoleLevel, (...args: unknown[]) => void>();
let client: FloTraceWebSocketClient | null = null;
let isInstalled = false;
let buffer: ConsoleCaptureEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Install the console tracker.
 * Monkey-patches console methods to capture calls with component attribution.
 */
export function installConsoleTracker(wsClient: FloTraceWebSocketClient): void {
  if (isInstalled) return;
  client = wsClient;
  isInstalled = true;

  for (const method of METHODS) {
    originals.set(method, console[method].bind(console));
    console[method] = (...args: unknown[]) => {
      // Always call original first so normal console behavior is preserved
      originals.get(method)!(...args);
      captureEntry(method, args);
    };
  }

  flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS);
}

/**
 * Uninstall the console tracker and restore original console methods.
 */
export function uninstallConsoleTracker(): void {
  if (!isInstalled) return;

  // Restore originals
  for (const [method, original] of originals) {
    console[method] = original;
  }
  originals.clear();

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  // Send remaining buffered entries
  flushBuffer();

  buffer = [];
  client = null;
  isInstalled = false;
}

/**
 * Capture a console call and add it to the buffer.
 */
function captureEntry(level: ConsoleLevel, args: unknown[]): void {
  // Skip FloTrace's own logs to avoid recursion
  if (args.length > 0 && typeof args[0] === 'string' && args[0].startsWith('[FloTrace]')) {
    return;
  }

  const attribution = getCurrentFiberAttribution();

  const entry: ConsoleCaptureEntry = {
    level,
    args: args.slice(0, MAX_ARGS_PER_ENTRY).map((a) => {
      try {
        return serializeValue(a, 0, new WeakSet());
      } catch {
        return { __type: 'truncated', originalType: typeof a } as SerializedValue;
      }
    }),
    timestamp: Date.now(),
    ...attribution,
  };

  buffer.push(entry);

  // Enforce max buffer size (drop oldest)
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer = buffer.slice(-MAX_BUFFER_SIZE);
  }

  // Immediate flush if batch is full
  if (buffer.length >= MAX_BATCH_SIZE) {
    flushBuffer();
  }
}

/**
 * Attempt to attribute a console call to the currently rendering React component.
 *
 * Strategy 1 (React 18): __SECRET_INTERNALS...ReactCurrentOwner.current
 * Strategy 2 (React 19): __CLIENT_INTERNALS...owner field (renamed + flattened)
 * Both return the fiber currently being rendered (null between renders).
 */
function getCurrentFiberAttribution(): Partial<Pick<ConsoleCaptureEntry, 'componentName' | 'ancestorChain'>> {
  try {
    const currentFiber = getCurrentRenderingFiber();
    if (!currentFiber) return {};

    const componentName = getComponentNameFromFiber(currentFiber);
    const ancestorChain = buildAncestorChain(currentFiber);

    return {
      componentName: componentName || undefined,
      ancestorChain: ancestorChain.length > 0 ? ancestorChain : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Get the currently rendering fiber across React 18 and 19.
 * Exported so networkTracker can reuse the same attribution logic.
 */
export function getCurrentRenderingFiber(): FiberLike | null {
  try {
    const win = window as unknown as Record<string, unknown>;

    // React 18: __SECRET_INTERNALS...ReactCurrentOwner.current
    const secret = win.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED as
      { ReactCurrentOwner?: { current: FiberLike | null } } | undefined;
    if (secret?.ReactCurrentOwner?.current) return secret.ReactCurrentOwner.current;

    // React 19: renamed + flattened — try known property names
    const client = win.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE as
      Record<string, unknown> | undefined;
    if (client) {
      // React 19 stores the current owner in a top-level property.
      // Walk all values looking for something that looks like a fiber.
      for (const val of Object.values(client)) {
        if (isFiberLike(val)) return val as FiberLike;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Structural check for a React fiber node.
 * Requires tag (number), type, return, AND memoizedState or stateNode
 * to distinguish from non-fiber objects that happen to have tag/type/return.
 */
function isFiberLike(val: unknown): val is FiberLike {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return (
    typeof obj.tag === 'number' &&
    'type' in obj &&
    'return' in obj &&
    ('memoizedState' in obj || 'stateNode' in obj)
  );
}

// Minimal fiber shape for attribution (avoid importing full Fiber type).
// Exported so networkTracker can reuse the same attribution utilities.
export interface FiberLike {
  type: {
    name?: string;
    displayName?: string;
    type?: { name?: string; displayName?: string };
    render?: { name?: string; displayName?: string };
  } | ((...args: unknown[]) => unknown) | string | null;
  return: FiberLike | null;
  tag: number;
}

/**
 * Extract display name from a fiber node.
 * Exported for reuse by networkTracker attribution.
 */
export function getComponentNameFromFiber(fiber: FiberLike): string | null {
  const type = fiber.type;
  if (!type) return null;

  if (typeof type === 'function') {
    return (type as { displayName?: string; name?: string }).displayName ||
      (type as { name?: string }).name || null;
  }

  if (typeof type === 'object' && type !== null) {
    // Memo wraps type
    if (type.type) {
      return type.type.displayName || type.type.name || null;
    }
    // ForwardRef wraps render
    if (type.render) {
      return type.render.displayName || type.render.name || null;
    }
    return type.displayName || type.name || null;
  }

  return null;
}

/**
 * Walk up the fiber tree to build an ancestor chain of component names.
 * Stops after 10 levels to prevent excessive traversal.
 * Exported for reuse by networkTracker attribution.
 */
export function buildAncestorChain(fiber: FiberLike): string[] {
  const chain: string[] = [];
  let current: FiberLike | null = fiber;
  const maxDepth = 10;

  while (current && chain.length < maxDepth) {
    const name = getComponentNameFromFiber(current);
    if (name) {
      chain.unshift(name);
    }
    current = current.return;
  }

  return chain;
}

/**
 * Flush buffered entries to the WebSocket server.
 */
function flushBuffer(): void {
  if (buffer.length === 0 || !client?.connected) return;

  client.send({
    type: 'runtime:consoleCapture',
    entries: [...buffer],
    timestamp: Date.now(),
  });

  buffer = [];
}
