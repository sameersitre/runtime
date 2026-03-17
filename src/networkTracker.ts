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
/**
 * True when patches are installed but no WebSocket client yet.
 * Requests captured in this state land in earlyBuffer instead of buffer,
 * then are prepended when installNetworkTracker() provides the client.
 */
let isPrewarmed = false;
let buffer: NetworkRequestEntry[] = [];
/** Pre-connection ring buffer — populated while isPrewarmed and client is null. */
let earlyBuffer: NetworkRequestEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let requestCounter = 0;

/** O(1) lookup: requestId → buffer index for in-place updates */
const requestIndexMap = new Map<string, number>();
/** O(1) upsert index for the pre-connection earlyBuffer. */
const earlyRequestIndexMap = new Map<string, number>();

/** Original fetch before our patch (may already be RSC-interceptor-patched) */
let previousFetch: typeof fetch | null = null;

/** Original XHR methods */
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXhrSend: typeof XMLHttpRequest.prototype.send | null = null;

/** Original Response.prototype.json — restored on uninstall */
let originalResponseJson: (() => Promise<unknown>) | null = null;

/** Original JSON.parse — restored on uninstall */
let originalJsonParse: typeof JSON.parse | null = null;

/**
 * Response object → requestId mapping (fetch path).
 * Lets Response.prototype.json wrapper know which request to tag without
 * modifying the Response instance itself.
 */
const responseToRequestId = new WeakMap<Response, string>();

/**
 * Pending XHR request whose responseText is about to be JSON.parsed.
 * Set in our early 'load' listener; matched in patchJsonParse() when axios's
 * transformResponse calls JSON.parse(responseText) in a Promise microtask.
 * Text-matching survives the microtask checkpoint that clears stack-based approaches.
 *
 * Known limitation: single-slot design — if two XHR responses complete simultaneously,
 * the second overwrites the first's requestId before JSON.parse is called, causing
 * incorrect or missed causal correlations for concurrent XHR requests. This is a
 * best-effort trade-off; a Map<responseText, requestId> approach would risk holding
 * large response strings as keys.
 */
let activeXhrRequestId: string | null = null;
/** The exact responseText string — matched to avoid false positives. */
let activeXhrResponseText: string | null = null;

/** Sliding window for duplicate detection: dedupeKey → last seen timestamp */
const dedupeWindow = new Map<string, number>();

// ============================================================================
// WeakMap — API response data tagging for API → Store causal correlation
// ============================================================================

/**
 * Tags parsed JSON response objects with their requestId.
 * Store trackers (Zustand/Redux) call findFetchOrigin() in their synchronous
 * subscribe callbacks to establish causal correlation without timing guesses.
 * WeakMap keys are held weakly — GC cleans up automatically when data is replaced.
 */
const fetchDataOrigin = new WeakMap<object, string>();

/**
 * Timestamps for when each requestId's data was tagged.
 * findFetchOrigin() only returns a match within FETCH_ORIGIN_TTL_MS to prevent
 * stale correlations from old response objects still held in the Redux/Zustand store.
 */
const requestTagTimestamps = new Map<string, number>();
const FETCH_ORIGIN_TTL_MS = 3000;

/** Tag an object and its nested children (depth ≤ 2) with the requestId. */
function tagFetchData(obj: unknown, requestId: string, depth = 0): void {
  if (depth > 2 || obj === null || typeof obj !== 'object') return;
  fetchDataOrigin.set(obj as object, requestId);
  if (depth === 0) requestTagTimestamps.set(requestId, Date.now());
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 50); i++) tagFetchData(obj[i], requestId, depth + 1);
  } else {
    for (const val of Object.values(obj as Record<string, unknown>)) tagFetchData(val, requestId, depth + 1);
  }
}

/** Returns true if any API request's response data is currently tagged (within TTL window). */
export function hasActiveTags(): boolean {
  return requestTagTimestamps.size > 0;
}

/**
 * Scan an object (and nested children up to depth 2) for a WeakMap-tagged fetch origin.
 * Called by Zustand/Redux trackers synchronously in their subscribe callbacks.
 * Returns the requestId if this object was the result of a tracked fetch within the TTL
 * window, else undefined. TTL prevents stale entries from matching on later store updates
 * that reuse the same object references (immutable store pattern).
 */
export function findFetchOrigin(obj: unknown, depth = 0): string | undefined {
  if (depth > 2 || obj === null || typeof obj !== 'object') return undefined;
  const rid = fetchDataOrigin.get(obj as object);
  if (rid) {
    const tagTime = requestTagTimestamps.get(rid);
    if (tagTime && Date.now() - tagTime <= FETCH_ORIGIN_TTL_MS) return rid;
    requestTagTimestamps.delete(rid); // prune expired entry — prevent unbounded growth
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 20); i++) {
      const found = findFetchOrigin(obj[i], depth + 1);
      if (found) return found;
    }
  } else {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      const found = findFetchOrigin(val, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}


// ============================================================================
// Install / Uninstall
// ============================================================================

/** Install all four patches in one call — avoids repeating the same 4 lines twice. */
function installPatches(): void {
  patchFetch();
  patchXhr();
  patchResponseJson();
  patchJsonParse();
}

/**
 * Install fetch/XHR patches eagerly — before the WebSocket client is ready.
 * Captured requests land in earlyBuffer and are prepended into the live buffer
 * when installNetworkTracker() is called with the real client.
 *
 * This mirrors the installFiberTreeWalker() early-install pattern so that
 * page-load requests (queries fired on mount) are not missed during the
 * window between React mounting and the WebSocket connecting.
 */
export function prewarmNetworkTracker(): void {
  if (isInstalled || isPrewarmed) return;
  isPrewarmed = true;
  installPatches();
}

export function installNetworkTracker(wsClient: FloTraceWebSocketClient): void {
  if (isInstalled) return;
  client = wsClient;
  isInstalled = true;

  if (!isPrewarmed) {
    // Cold install (no prewarm) — install patches fresh
    requestCounter = 0;
    installPatches();
  } else {
    // Patches already installed by prewarmNetworkTracker.
    // Prepend earlyBuffer so page-load requests appear first.
    isPrewarmed = false;
    if (earlyBuffer.length > 0) {
      buffer = [...earlyBuffer, ...buffer];
      rebuildRequestIndex();
      earlyBuffer = [];
      earlyRequestIndexMap.clear();
    }
  }

  flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS);
  // Flush immediately to send any earlyBuffer entries without waiting 500ms
  flushBuffer();
}

export function uninstallNetworkTracker(): void {
  if (!isInstalled && !isPrewarmed) return;

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

  // Restore Response.prototype.json
  if (originalResponseJson) {
    Response.prototype.json = originalResponseJson as typeof Response.prototype.json;
    originalResponseJson = null;
  }

  // Restore JSON.parse
  if (originalJsonParse) {
    JSON.parse = originalJsonParse;
    originalJsonParse = null;
  }

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  if (isInstalled) flushBuffer();
  buffer = [];
  earlyBuffer = [];
  requestIndexMap.clear();
  earlyRequestIndexMap.clear();
  dedupeWindow.clear();
  requestTagTimestamps.clear();
  activeXhrRequestId = null;
  activeXhrResponseText = null;
  client = null;
  isInstalled = false;
  isPrewarmed = false;
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

        // Associate this Response with its requestId so patchResponseJson()
        // can tag the parsed data without touching the Response instance itself.
        responseToRequestId.set(response, entry.requestId);
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

    // Plant an early 'load' listener — added here in open() so it fires BEFORE
    // any listeners the caller (e.g. axios) adds after open() returns.
    // When the response arrives this listener pushes the requestId onto
    // jsonParseTagStack so the global JSON.parse wrapper can tag the parsed
    // result before axios's listener returns.
    const self = this as XhrWithMeta;
    this.addEventListener('load', function () {
      const requestId = self.__ftRequestId;
      if (!requestId) return;

      // responseType='json': browser already parsed it; tag xhr.response directly
      // (same object reference the caller will read — no JSON.parse call happens)
      if (self.responseType === 'json' && self.response !== null && typeof self.response === 'object') {
        try { tagFetchData(self.response, requestId, 0); } catch { /* best-effort */ }
        return;
      }

      // Capture responseText now (fully populated when 'load' fires).
      // patchJsonParse() matches this exact text when axios's transformResponse
      // calls JSON.parse(responseText) in a Promise microtask — this survives
      // the microtask checkpoint that clears stack/queueMicrotask-based approaches.
      const text = self.responseText;
      if (text) {
        activeXhrRequestId = requestId;
        activeXhrResponseText = text;
      }
    });

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

    // Store requestId so the early open() load listener can read it
    (this as XhrWithMeta).__ftRequestId = entry.requestId;

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
  /** Set in send() so the early open() load listener can read it when the response arrives. */
  __ftRequestId?: string;
}

// ============================================================================
// Response.prototype.json patching (fetch path)
// ============================================================================

/**
 * Wraps Response.prototype.json once so parsed fetch data gets tagged in the
 * WeakMap without touching individual Response instances.
 * responseToRequestId maps Response → requestId (set in patchFetch after each
 * successful response).
 */
function patchResponseJson(): void {
  if (typeof Response === 'undefined') return;
  originalResponseJson = Response.prototype.json as () => Promise<unknown>;

  Response.prototype.json = async function (this: Response) {
    const data = await originalResponseJson!.call(this);
    const requestId = responseToRequestId.get(this);
    if (requestId && data !== null && typeof data === 'object') {
      try { tagFetchData(data, requestId, 0); } catch { /* best-effort */ }
    }
    return data;
  };
}

// ============================================================================
// JSON.parse patching (XHR / axios path)
// ============================================================================

/**
 * Wraps JSON.parse globally so axios's internal transformResponse call is
 * intercepted. Only tags when jsonParseTagStack is non-empty (i.e. inside an
 * XHR load event). The original value is always returned unmodified.
 */
function patchJsonParse(): void {
  originalJsonParse = JSON.parse;

  JSON.parse = function (text: string, reviver?: (key: string, value: unknown) => unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = originalJsonParse!.call(JSON, text as any, reviver as any);
    // Match exact responseText captured in the XHR 'load' listener.
    // axios calls JSON.parse in a Promise .then() microtask (transformResponse),
    // so text-matching is the only approach that survives the microtask checkpoint.
    if (
      activeXhrRequestId !== null &&
      activeXhrResponseText !== null &&
      (text as string) === activeXhrResponseText &&
      result !== null &&
      typeof result === 'object'
    ) {
      try { tagFetchData(result, activeXhrRequestId, 0); } catch { /* best-effort */ }
      activeXhrRequestId = null;
      activeXhrResponseText = null;
    }
    return result;
  } as typeof JSON.parse;
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

/** Pre-combined regex for O(1) noise URL matching instead of iterating 25 patterns */
const COMBINED_NOISE_PATTERN = new RegExp(
  NOISE_URL_PATTERNS.map(r => r.source).join('|'),
  'i',
);

function isNoiseUrl(url: string): boolean {
  return COMBINED_NOISE_PATTERN.test(url);
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

/**
 * O(1) upsert: update entry in-place if already buffered, otherwise append.
 * Prunes the oldest entries when the buffer exceeds maxSize, rebuilding idxMap.
 * Returns the (possibly replaced) array reference — callers must reassign.
 */
function upsertAndPrune(
  entry: NetworkRequestEntry,
  buf: NetworkRequestEntry[],
  idxMap: Map<string, number>,
  maxSize: number,
): NetworkRequestEntry[] {
  const existingIdx = idxMap.get(entry.requestId);
  if (existingIdx !== undefined && existingIdx < buf.length && buf[existingIdx]?.requestId === entry.requestId) {
    buf[existingIdx] = entry; // in-place update — same array reference
    return buf;
  }
  idxMap.set(entry.requestId, buf.length);
  buf.push(entry);
  if (buf.length > maxSize) {
    const pruned = buf.slice(-maxSize);
    idxMap.clear();
    for (let i = 0; i < pruned.length; i++) idxMap.set(pruned[i].requestId, i);
    return pruned;
  }
  return buf;
}

function pushEntry(entry: NetworkRequestEntry): void {
  // Pre-connection: buffer into earlyBuffer until the WebSocket client arrives
  if (client === null && isPrewarmed) {
    earlyBuffer = upsertAndPrune(entry, earlyBuffer, earlyRequestIndexMap, MAX_BUFFER_SIZE);
    return;
  }

  buffer = upsertAndPrune(entry, buffer, requestIndexMap, MAX_BUFFER_SIZE);

  // Immediate flush if batch is full
  if (buffer.length >= MAX_BATCH_SIZE) flushBuffer();
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
