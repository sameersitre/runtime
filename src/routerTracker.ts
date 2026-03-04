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

import type { FloTraceWebSocketClient } from './websocketClient';

// Module-level state (mirrors zustandTracker/reduxTracker pattern)
let isInstalled = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let client: FloTraceWebSocketClient | null = null;

// Store original methods so we can restore them on uninstall
let originalPushState: typeof history.pushState | null = null;
let originalReplaceState: typeof history.replaceState | null = null;
let popstateHandler: ((event: PopStateEvent) => void) | null = null;

const DEBOUNCE_MS = 200;

/**
 * Install router tracking.
 * Patches history.pushState/replaceState and listens for popstate events
 * to detect all navigation in the browser.
 */
export function installRouterTracker(wsClient: FloTraceWebSocketClient): void {
  if (isInstalled) {
    console.warn('[FloTrace] Router tracker already installed, reinstalling');
    uninstallRouterTracker();
  }

  if (typeof window === 'undefined' || typeof history === 'undefined') {
    console.warn('[FloTrace] Router tracker requires a browser environment');
    return;
  }

  console.log('[FloTrace] Installing router tracker');

  try {
  isInstalled = true;
  client = wsClient;

  // Save original methods
  originalPushState = history.pushState.bind(history);
  originalReplaceState = history.replaceState.bind(history);

  // Wrap history.pushState — called by React Router on <Link> clicks and navigate()
  // Critical: always call original first so navigation works even if FloTrace fails
  history.pushState = function (
    data: unknown,
    unused: string,
    url?: string | URL | null
  ) {
    originalPushState!(data, unused, url);
    try {
      scheduleRouterUpdate();
    } catch (error) {
      console.error('[FloTrace] Error in pushState handler:', error);
    }
  };

  // Wrap history.replaceState — called by React Router on redirect/replace navigation
  history.replaceState = function (
    data: unknown,
    unused: string,
    url?: string | URL | null
  ) {
    originalReplaceState!(data, unused, url);
    try {
      scheduleRouterUpdate();
    } catch (error) {
      console.error('[FloTrace] Error in replaceState handler:', error);
    }
  };

  // Listen for popstate — fired on back/forward button clicks
  popstateHandler = () => {
    try {
      scheduleRouterUpdate();
    } catch (error) {
      console.error('[FloTrace] Error in popstate handler:', error);
    }
  };
  window.addEventListener('popstate', popstateHandler);

  // Send initial state immediately (current URL on install)
  sendRouterUpdate();
  } catch (error) {
    console.error('[FloTrace] Failed to install router tracker:', error);
    // Clean up any partial installation
    try { uninstallRouterTracker(); } catch (_) { /* ignore cleanup errors */ }
  }
}

/**
 * Uninstall router tracking, restoring original History methods.
 */
export function uninstallRouterTracker(): void {
  if (!isInstalled) return;

  // Clear debounce timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  // Restore original history methods — per-step try-catch so one failure
  // doesn't prevent the rest from being restored
  try {
    if (originalPushState) {
      history.pushState = originalPushState;
      originalPushState = null;
    }
  } catch (error) {
    console.error('[FloTrace] Error restoring pushState:', error);
  }

  try {
    if (originalReplaceState) {
      history.replaceState = originalReplaceState;
      originalReplaceState = null;
    }
  } catch (error) {
    console.error('[FloTrace] Error restoring replaceState:', error);
  }

  // Remove popstate listener
  try {
    if (popstateHandler) {
      window.removeEventListener('popstate', popstateHandler);
      popstateHandler = null;
    }
  } catch (error) {
    console.error('[FloTrace] Error removing popstate listener:', error);
  }

  client = null;
  isInstalled = false;
  console.log('[FloTrace] Router tracker uninstalled');
}

/**
 * Schedule a debounced router update.
 * Multiple rapid navigations (e.g., redirects) collapse into one update.
 */
function scheduleRouterUpdate(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    sendRouterUpdate();
  }, DEBOUNCE_MS);
}

/**
 * Read current URL and send router state to the extension.
 */
function sendRouterUpdate(): void {
  try {
    if (!client?.connected) return;

    const pathname = window.location.pathname;

    // Parse search params into a plain object
    const searchParams: Record<string, string> = {};
    const urlSearchParams = new URLSearchParams(window.location.search);
    for (const [key, value] of urlSearchParams.entries()) {
      searchParams[key] = value;
    }

    client.sendImmediate({
      type: 'runtime:router',
      pathname,
      // Matched route params (e.g., :id) are not available from the History API.
      // Future enhancement: extract from React Router's fiber context.
      params: {},
      searchParams,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('[FloTrace] Error sending router update:', error);
  }
}
