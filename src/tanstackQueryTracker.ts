/**
 * TanStack Query Tracker for @flotrace/runtime
 *
 * Subscribes to QueryCache and MutationCache events and sends
 * query/mutation state snapshots to the FloTrace desktop app.
 *
 * Design: User passes their QueryClient via the `queryClient` prop on <FloTraceProvider>.
 * We subscribe via queryClient.getQueryCache().subscribe() and getMutationCache().subscribe().
 *
 * Uses duck-typed interface — no @tanstack/react-query dependency needed.
 * Same pattern as zustandTracker and reduxTracker.
 */

import type { SerializedValue, TanStackQueryInfo, TanStackMutationInfo } from './types';
import { serializeValue } from './serializer';
import type { FloTraceWebSocketClient } from './websocketClient';

// ============================================================================
// Duck-Typed Interfaces (no TanStack dependency)
// ============================================================================

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
    scope?: { id: string };
  };
}

/** Minimal QueryCache interface */
interface DuckQueryCache {
  getAll(): DuckQuery[];
  subscribe(cb: (event: { type: string; query?: DuckQuery }) => void): () => void;
}

/** Minimal MutationCache interface */
interface DuckMutationCache {
  getAll(): DuckMutation[];
  subscribe(cb: (event: { type: string; mutation?: DuckMutation }) => void): () => void;
}

/** Duck-typed QueryClient — what we need from the user */
export interface TanStackQueryClientApi {
  getQueryCache(): DuckQueryCache;
  getMutationCache(): DuckMutationCache;
}

// ============================================================================
// Module-Level State
// ============================================================================

let isInstalled = false;
let queryUnsubscribe: (() => void) | null = null;
let mutationUnsubscribe: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 300; // slightly higher than Zustand — queries change less frequently

// ============================================================================
// Validation
// ============================================================================

/** Validate that an object looks like a TanStack QueryClient */
export function isTanStackQueryClient(obj: unknown): obj is TanStackQueryClientApi {
  if (!obj || typeof obj !== 'object') return false;
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.getQueryCache === 'function' &&
    typeof candidate.getMutationCache === 'function'
  );
}

// ============================================================================
// Install / Uninstall
// ============================================================================

/**
 * Install TanStack Query tracking.
 * Subscribes to QueryCache and MutationCache and sends runtime:tanstackQuery messages.
 */
export function installTanStackQueryTracker(
  queryClient: TanStackQueryClientApi,
  client: FloTraceWebSocketClient,
): void {
  if (isInstalled) {
    console.warn('[FloTrace] TanStack Query tracker already installed, reinstalling');
    uninstallTanStackQueryTracker();
  }

  isInstalled = true;
  console.log('[FloTrace] Installing TanStack Query tracker');

  try {
    const queryCache = queryClient.getQueryCache();
    const mutationCache = queryClient.getMutationCache();

    // Send initial snapshot
    sendSnapshot(queryCache, mutationCache, client);

    // Subscribe to query cache events
    queryUnsubscribe = queryCache.subscribe((event) => {
      try {
        // Only send on meaningful events (skip observer-only events for perf)
        if (event.type === 'added' || event.type === 'removed' || event.type === 'updated') {
          scheduleSnapshot(queryCache, mutationCache, client);
        }
      } catch (error) {
        console.error('[FloTrace] Error in TanStack Query cache subscribe callback:', error);
      }
    });

    // Subscribe to mutation cache events
    mutationUnsubscribe = mutationCache.subscribe(() => {
      try {
        scheduleSnapshot(queryCache, mutationCache, client);
      } catch (error) {
        console.error('[FloTrace] Error in TanStack Mutation cache subscribe callback:', error);
      }
    });
  } catch (error) {
    console.error('[FloTrace] Failed to install TanStack Query tracker:', error);
    isInstalled = false;
  }
}

/**
 * Uninstall TanStack Query tracking.
 */
export function uninstallTanStackQueryTracker(): void {
  if (!isInstalled) return;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (queryUnsubscribe) {
    try { queryUnsubscribe(); } catch (e) { console.error('[FloTrace] Error unsubscribing from QueryCache:', e); }
    queryUnsubscribe = null;
  }

  if (mutationUnsubscribe) {
    try { mutationUnsubscribe(); } catch (e) { console.error('[FloTrace] Error unsubscribing from MutationCache:', e); }
    mutationUnsubscribe = null;
  }

  isInstalled = false;
  console.log('[FloTrace] TanStack Query tracker uninstalled');
}

// ============================================================================
// Snapshot Scheduling
// ============================================================================

function scheduleSnapshot(
  queryCache: DuckQueryCache,
  mutationCache: DuckMutationCache,
  client: FloTraceWebSocketClient,
): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    sendSnapshot(queryCache, mutationCache, client);
  }, DEBOUNCE_MS);
}

// ============================================================================
// Snapshot Serialization
// ============================================================================

/**
 * Serialize query data using the safe serializer (depth-limited, circular-ref safe).
 * Returns the actual data values so users can inspect query responses in FloTrace.
 */
function serializeQueryData(data: unknown): SerializedValue {
  if (data === null || data === undefined) return null;
  try {
    return serializeValue(data);
  } catch {
    return { __type: 'truncated', originalType: typeof data };
  }
}

function extractErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'Unknown error';
  }
}

function serializeQuery(query: DuckQuery): TanStackQueryInfo {
  let queryKeySerialized: SerializedValue;
  try {
    queryKeySerialized = serializeValue(query.queryKey);
  } catch {
    queryKeySerialized = '[serialization failed]';
  }

  const errorMessage = query.state.error ? extractErrorMessage(query.state.error) : undefined;

  return {
    queryKey: queryKeySerialized,
    queryHash: query.queryHash,
    status: query.state.status,
    fetchStatus: query.state.fetchStatus,
    dataUpdatedAt: query.state.dataUpdatedAt,
    errorUpdatedAt: query.state.errorUpdatedAt,
    isInvalidated: query.state.isInvalidated,
    isStale: safeCall(() => query.isStale(), false),
    isActive: safeCall(() => query.isActive(), false),
    isDisabled: safeCall(() => query.isDisabled(), false),
    failureCount: query.state.fetchFailureCount,
    errorMessage,
    observerCount: safeCall(() => query.getObserversCount(), 0),
    staleTime: query.options.staleTime,
    gcTime: query.options.gcTime,
    dataShape: serializeQueryData(query.state.data),
  };
}

function serializeMutation(mutation: DuckMutation): TanStackMutationInfo {
  const errorMessage = mutation.state.error ? extractErrorMessage(mutation.state.error) : undefined;

  let mutationKey: SerializedValue | undefined;
  if (mutation.options.mutationKey) {
    try {
      mutationKey = serializeValue(mutation.options.mutationKey);
    } catch {
      mutationKey = '[serialization failed]';
    }
  }

  return {
    mutationId: mutation.mutationId,
    status: mutation.state.status,
    isPaused: mutation.state.isPaused,
    submittedAt: mutation.state.submittedAt,
    failureCount: mutation.state.failureCount,
    errorMessage,
    mutationKey,
    scope: mutation.options.scope?.id,
  };
}

function sendSnapshot(
  queryCache: DuckQueryCache,
  mutationCache: DuckMutationCache,
  client: FloTraceWebSocketClient,
): void {
  try {
    if (!client.connected) return;

    const queries: TanStackQueryInfo[] = [];
    for (const query of queryCache.getAll()) {
      try {
        queries.push(serializeQuery(query));
      } catch (error) {
        console.error(`[FloTrace] Error serializing query "${query.queryHash}":`, error);
      }
    }

    const mutations: TanStackMutationInfo[] = [];
    for (const mutation of mutationCache.getAll()) {
      try {
        mutations.push(serializeMutation(mutation));
      } catch (error) {
        console.error(`[FloTrace] Error serializing mutation ${mutation.mutationId}:`, error);
      }
    }

    client.sendImmediate({
      type: 'runtime:tanstackQuery',
      queries,
      mutations,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('[FloTrace] Error sending TanStack Query snapshot:', error);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
