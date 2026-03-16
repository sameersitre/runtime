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
 * - Duplicate detection via sliding 2-second window keyed by method:path
 * - Noise filtering: analytics, HMR, extensions, static assets, FloTrace's own WS
 * - Batched sending: 500ms flush, max 50 entries per batch, 300 entry ring buffer
 * - AbortController support: detects aborted requests
 */

import type { NetworkRequestEntry } from './types';
import type { FloTraceWebSocketClient } from './websocketClient';
import { getCurrentRenderingFiber, getComponentNameFromFiber, buildAncestorChain } from './consoleTracker';

// ============================================================================
// Constants
// ============================================================================

const MAX_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 500;
const MAX_BUFFER_SIZE = 300;
const DEDUPE_WINDOW_MS = 5000;
const MAX_ANCESTOR_CHAIN = 3;

/** URL patterns to filter out (analytics, dev tools, static assets, etc.) */
const NOISE_URL_PATTERNS: RegExp[] = [
  // Analytics & tracking
  /google-analytics\.com/i, /googletagmanager\.com/i,
  /facebook\.com\/tr/i, /segment\.io/i, /mixpanel\.com/i,
  /amplitude\.com/i, /hotjar\.com/i, /fullstory\.com/i,
  /sentry\.io/i, /bugsnag\.com/i, /datadog/i,
  /clarity\.ms/i, /plausible\.io/i,
  // Development tools
  /webpack-dev-server/i, /__webpack_hmr/i, /\.hot-update\./i,
  /\.map$/, /sourcemap/i,
  /__nextjs_original-stack-frame/i, /__nextjs_launch-editor/i,
  /on-demand-entries-ping/i,
  // Browser resources
  /favicon\.ico/i, /robots\.txt/i, /manifest\.json/i,
  /service-worker/i, /sw\.js/i,
  // Static assets
  /\/_next\/static\//i, /\/_next\/image/i,
  // FloTrace's own WebSocket
  /127\.0\.0\.1:3457/,
  // Chrome extensions
  /chrome-extension:/i, /moz-extension:/i,
];

// ============================================================================
// Module state
// ============================================================================

let client: FloTraceWebSocketClient | null = null;
let isInstalled = false;
let buffer: NetworkRequestEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let requestCounter = 0;

/** O(1) lookup: requestId → buffer index for in-place updates */
const requestIndexMap = new Map<string, number>();

/** Original fetch before our patch (may already be RSC-interceptor-patched) */
let previousFetch: typeof fetch | null = null;

/** Original XHR methods */
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXhrSend: typeof XMLHttpRequest.prototype.send | null = null;

/** Sliding window for duplicate detection: dedupeKey → last seen timestamp */
const dedupeWindow = new Map<string, number>();


// ============================================================================
// Install / Uninstall
// ============================================================================

export function installNetworkTracker(wsClient: FloTraceWebSocketClient): void {
  if (isInstalled) return;
  client = wsClient;
  isInstalled = true;
  requestCounter = 0;

  patchFetch();
  patchXhr();

  flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS);
}

export function uninstallNetworkTracker(): void {
  if (!isInstalled) return;

  // Restore fetch — restores to whatever was there before us (RSC-patched or native)
  if (previousFetch) {
    globalThis.fetch = previousFetch;
    previousFetch = null;
  }

  // Restore XHR
  if (originalXhrOpen) {
    XMLHttpRequest.prototype.open = originalXhrOpen;
    originalXhrOpen = null;
  }
  if (originalXhrSend) {
    XMLHttpRequest.prototype.send = originalXhrSend;
    originalXhrSend = null;
  }

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  flushBuffer();
  buffer = [];
  requestIndexMap.clear();
  dedupeWindow.clear();
  client = null;
  isInstalled = false;
}

// ============================================================================
// Fetch patching
// ============================================================================

function patchFetch(): void {
  if (typeof globalThis.fetch !== 'function') return;

  // Store current fetch (may be RSC-interceptor-patched — we chain on top)
  previousFetch = globalThis.fetch;

  globalThis.fetch = async function trackedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = extractUrl(input);

    // Skip noise URLs — call previous fetch directly with zero overhead
    if (isNoiseUrl(url)) {
      return previousFetch!.call(globalThis, input, init);
    }

    const method = (init?.method ?? 'GET').toUpperCase();
    const parsedUrl = parseUrl(url);
    const entry = createEntry(method, parsedUrl, init);
    const startTime = performance.now();

    // Check for AbortSignal
    if (init?.signal) {
      init.signal.addEventListener('abort', () => {
        entry.state = 'aborted';
        entry.durationMs = performance.now() - startTime;
        pushEntry(entry);
      }, { once: true });
    }

    // Push pending entry
    pushEntry({ ...entry });

    try {
      const response = await previousFetch!.call(globalThis, input, init);

      // Don't update if already aborted
      if (entry.state !== 'aborted') {
        entry.state = response.ok ? 'success' : 'error';
        entry.status = response.status;
        entry.durationMs = performance.now() - startTime;
        entry.responseSizeBytes = parseContentLength(response.headers);
        if (!response.ok) {
          entry.errorMessage = `${response.status} ${response.statusText}`;
        }
        pushEntry(entry);
      }

      return response;
    } catch (err) {
      if (entry.state !== 'aborted') {
        entry.state = 'error';
        entry.durationMs = performance.now() - startTime;
        entry.errorMessage = err instanceof Error ? err.message : String(err);
        pushEntry(entry);
      }
      throw err;
    }
  };
}

// ============================================================================
// XHR patching
// ============================================================================

function patchXhr(): void {
  if (typeof XMLHttpRequest === 'undefined') return;

  originalXhrOpen = XMLHttpRequest.prototype.open;
  originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    // Store metadata on the XHR instance for later retrieval in send()
    (this as XhrWithMeta).__ftMethod = method.toUpperCase();
    (this as XhrWithMeta).__ftUrl = typeof url === 'string' ? url : url.href;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalXhrOpen as any).apply(this, [method, url, ...rest]);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const meta = this as XhrWithMeta;
    const url = meta.__ftUrl ?? '';

    // Skip noise
    if (isNoiseUrl(url)) {
      return originalXhrSend!.call(this, body);
    }

    const method = meta.__ftMethod ?? 'GET';
    const parsedUrl = parseUrl(url);
    const entry = createEntry(method, parsedUrl);
    const startTime = performance.now();

    // Push pending
    pushEntry({ ...entry });

    this.addEventListener('load', () => {
      entry.state = this.status >= 400 ? 'error' : 'success';
      entry.status = this.status;
      entry.durationMs = performance.now() - startTime;
      entry.responseSizeBytes = parseXhrContentLength(this);
      if (this.status >= 400) {
        entry.errorMessage = `${this.status} ${this.statusText}`;
      }
      pushEntry(entry);
    });

    this.addEventListener('error', () => {
      entry.state = 'error';
      entry.durationMs = performance.now() - startTime;
      entry.errorMessage = 'Network error';
      pushEntry(entry);
    });

    this.addEventListener('abort', () => {
      entry.state = 'aborted';
      entry.durationMs = performance.now() - startTime;
      pushEntry(entry);
    });

    return originalXhrSend!.call(this, body);
  };
}

/** Metadata stored on XHR instance between open() and send() */
interface XhrWithMeta extends XMLHttpRequest {
  __ftMethod?: string;
  __ftUrl?: string;
}

// ============================================================================
// Entry creation & attribution
// ============================================================================

function createEntry(
  method: string,
  parsedUrl: { path: string; host: string },
  init?: RequestInit,
): NetworkRequestEntry {
  const requestId = String(++requestCounter);
  const dedupeKey = `${method}:${parsedUrl.path}`;

  // Component attribution
  const attribution = getAttribution();

  // Next.js Server Action / prefetch detection
  const isServerAction = hasHeader(init, 'Next-Action');
  const isPrefetch = hasHeader(init, 'Next-Router-Prefetch');

  // Duplicate detection
  const now = Date.now();
  const isDuplicate = checkDuplicate(dedupeKey, now);

  return {
    requestId,
    method,
    urlPath: parsedUrl.path,
    urlHost: parsedUrl.host,
    status: 0,
    durationMs: null,
    responseSizeBytes: null,
    componentName: attribution.componentName,
    ancestorChain: attribution.ancestorChain,
    initiatedDuringRender: attribution.duringRender,
    initiatedInEffect: attribution.inEffect,
    state: 'pending',
    dedupeKey,
    isDuplicate: isDuplicate || undefined,
    isServerAction: isServerAction || undefined,
    isPrefetch: isPrefetch || undefined,
    timestamp: now,
  };
}

function getAttribution(): {
  componentName?: string;
  ancestorChain?: string[];
  duringRender: boolean;
  inEffect: boolean;
} {
  // During render — getCurrentRenderingFiber returns the fiber (rare for fetches)
  const fiber = getCurrentRenderingFiber();
  if (fiber) {
    const name = getComponentNameFromFiber(fiber);
    const ancestors = buildAncestorChain(fiber).slice(-MAX_ANCESTOR_CHAIN);
    return {
      componentName: name || undefined,
      ancestorChain: ancestors.length > 0 ? ancestors : undefined,
      duringRender: true,
      inEffect: false,
    };
  }

  // Unattributed — component attribution for effects/event handlers is not
  // achievable without React's privileged internal profiling APIs.
  return { duringRender: false, inEffect: false };
}

// ============================================================================
// Helpers
// ============================================================================

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

function parseUrl(url: string): { path: string; host: string } {
  try {
    const u = new URL(url, globalThis.location?.href ?? 'http://localhost');
    return { path: u.pathname, host: u.host };
  } catch {
    return { path: url.split('?')[0] ?? url, host: '' };
  }
}

function isNoiseUrl(url: string): boolean {
  return NOISE_URL_PATTERNS.some((p) => p.test(url));
}

/** Parse a content-length string to a number, returning null if absent or invalid. */
function parseIntOrNull(value: string | null): number | null {
  if (!value) return null;
  const n = parseInt(value, 10);
  return isNaN(n) ? null : n;
}

function parseContentLength(headers: Headers): number | null {
  return parseIntOrNull(headers.get('content-length'));
}

function parseXhrContentLength(xhr: XMLHttpRequest): number | null {
  return parseIntOrNull(xhr.getResponseHeader('content-length'));
}

function hasHeader(init: RequestInit | undefined, name: string): boolean {
  if (!init?.headers) return false;
  if (init.headers instanceof Headers) return init.headers.has(name);
  if (Array.isArray(init.headers)) return init.headers.some(([k]) => k.toLowerCase() === name.toLowerCase());
  if (typeof init.headers === 'object') {
    return Object.keys(init.headers).some((k) => k.toLowerCase() === name.toLowerCase());
  }
  return false;
}

function checkDuplicate(dedupeKey: string, now: number): boolean {
  // Prune expired entries
  for (const [key, ts] of dedupeWindow) {
    if (now - ts > DEDUPE_WINDOW_MS) dedupeWindow.delete(key);
  }
  const isDup = dedupeWindow.has(dedupeKey);
  dedupeWindow.set(dedupeKey, now);
  return isDup;
}

// ============================================================================
// Buffer & flush
// ============================================================================

function pushEntry(entry: NetworkRequestEntry): void {
  // O(1) upsert: update in-place if this requestId is already buffered
  const existingIdx = requestIndexMap.get(entry.requestId);
  if (existingIdx !== undefined && existingIdx < buffer.length && buffer[existingIdx]?.requestId === entry.requestId) {
    buffer[existingIdx] = entry;
  } else {
    requestIndexMap.set(entry.requestId, buffer.length);
    buffer.push(entry);
  }

  // Ring buffer — drop oldest and rebuild index
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer = buffer.slice(-MAX_BUFFER_SIZE);
    rebuildRequestIndex();
  }

  // Immediate flush if batch is full
  if (buffer.length >= MAX_BATCH_SIZE) {
    flushBuffer();
  }
}

function rebuildRequestIndex(): void {
  requestIndexMap.clear();
  for (let i = 0; i < buffer.length; i++) {
    requestIndexMap.set(buffer[i].requestId, i);
  }
}

function flushBuffer(): void {
  if (buffer.length === 0 || !client?.connected) return;

  client.send({
    type: 'runtime:networkRequest',
    requests: [...buffer],
    timestamp: Date.now(),
  });

  buffer = [];
  requestIndexMap.clear();
}
