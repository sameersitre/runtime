// src/FloTraceProvider.tsx
import React, { useEffect, useRef, createContext, useContext, Profiler } from "react";

// src/types.ts
var DEFAULT_CONFIG = {
  port: 3457,
  appName: "React App",
  enabled: process.env.NODE_ENV === "development",
  autoReconnect: true,
  reconnectInterval: 2e3,
  trackAllRenders: true,
  includeProps: true,
  trackZustand: true,
  trackRedux: true,
  trackRouter: true,
  trackContext: true,
  trackTanstackQuery: true
};

// src/websocketClient.ts
var _FloTraceWebSocketClient = class _FloTraceWebSocketClient {
  constructor(config = {}) {
    this.ws = null;
    this.messageQueue = [];
    this.flushTimeout = null;
    this.reconnectTimeout = null;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    // Prevent unbounded queue growth when disconnected
    this.messageHandlers = /* @__PURE__ */ new Set();
    this.connectionHandlers = /* @__PURE__ */ new Set();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  /**
   * Connect to the FloTrace WebSocket server
   */
  connect() {
    if (this.ws || this.isConnecting) {
      return;
    }
    if (!this.config.enabled) {
      console.log("[FloTrace] Runtime disabled, skipping connection");
      return;
    }
    if (typeof window === "undefined" || typeof WebSocket === "undefined") {
      console.log("[FloTrace] Not in browser environment, skipping connection");
      return;
    }
    this.isConnecting = true;
    try {
      const url = `ws://127.0.0.1:${this.config.port}`;
      console.log(`[FloTrace] Connecting to ${url}...`);
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        console.log("[FloTrace] Connected to VS Code extension");
        this.notifyConnectionChange(true);
        this.send({
          type: "runtime:ready",
          appName: this.config.appName,
          reactVersion: this.getReactVersion(),
          appUrl: typeof window !== "undefined" ? window.location.href : void 0
        });
        this.flush();
      };
      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error("[FloTrace] Failed to parse message:", error);
        }
      };
      this.ws.onclose = () => {
        this.isConnecting = false;
        this.ws = null;
        console.log("[FloTrace] Disconnected from VS Code extension");
        this.notifyConnectionChange(false);
        if (this.config.autoReconnect) {
          this.scheduleReconnect();
        }
      };
      this.ws.onerror = (error) => {
        this.isConnecting = false;
        console.error("[FloTrace] WebSocket error:", error);
      };
    } catch (error) {
      this.isConnecting = false;
      console.error("[FloTrace] Failed to connect:", error);
      if (this.config.autoReconnect) {
        this.scheduleReconnect();
      }
    }
  }
  /**
   * Disconnect from the server
   */
  disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    if (this.ws) {
      try {
        this.send({ type: "runtime:disconnect", reason: "Client disconnect" });
      } catch (error) {
        console.error("[FloTrace] Error sending disconnect message:", error);
      }
      this.ws.close();
      this.ws = null;
    }
  }
  /**
   * Send a message to the extension (queued and batched)
   */
  send(message) {
    if (!this.config.enabled) {
      return;
    }
    this.messageQueue.push(message);
    if (this.messageQueue.length > _FloTraceWebSocketClient.MAX_QUEUE_SIZE) {
      this.messageQueue = this.messageQueue.slice(-_FloTraceWebSocketClient.MAX_QUEUE_SIZE);
    }
    if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => {
        this.flush();
      }, _FloTraceWebSocketClient.BATCH_FLUSH_MS);
    }
    if (this.messageQueue.length >= (this.config.trackAllRenders ? 50 : 10)) {
      this.flush();
    }
  }
  /**
   * Send a message immediately (not batched)
   */
  sendImmediate(message) {
    if (!this.config.enabled || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error("[FloTrace] Failed to send message:", error);
    }
  }
  /**
   * Flush the message queue
   */
  flush() {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.messageQueue.length === 0) {
      return;
    }
    try {
      for (const message of this.messageQueue) {
        this.ws.send(JSON.stringify(message));
      }
      this.messageQueue = [];
    } catch (error) {
      console.error("[FloTrace] Failed to flush messages:", error);
    }
  }
  /**
   * Schedule a reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectTimeout) {
      return;
    }
    if (this.reconnectAttempts >= _FloTraceWebSocketClient.MAX_RECONNECT_ATTEMPTS) {
      console.warn(
        `[FloTrace] Reconnection budget exhausted (${_FloTraceWebSocketClient.MAX_RECONNECT_ATTEMPTS} attempts). Reload the page or restart the extension to retry.`
      );
      return;
    }
    const baseDelay = this.config.reconnectInterval || 2e3;
    const delay = Math.min(
      baseDelay * Math.pow(2, this.reconnectAttempts),
      _FloTraceWebSocketClient.MAX_RECONNECT_INTERVAL
    );
    this.reconnectAttempts++;
    console.log(
      `[FloTrace] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${_FloTraceWebSocketClient.MAX_RECONNECT_ATTEMPTS})`
    );
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, delay);
  }
  /**
   * Handle incoming message from extension
   */
  handleMessage(message) {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        console.error("[FloTrace] Message handler error:", error);
      }
    }
  }
  /**
   * Notify connection state change
   */
  notifyConnectionChange(connected) {
    for (const handler of this.connectionHandlers) {
      try {
        handler(connected);
      } catch (error) {
        console.error("[FloTrace] Connection handler error:", error);
      }
    }
  }
  /**
   * Add a message handler
   */
  onMessage(handler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }
  /**
   * Add a connection state handler
   */
  onConnectionChange(handler) {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }
  /**
   * Check if connected
   */
  get connected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
  /**
   * Get React version if available
   */
  getReactVersion() {
    try {
      if (typeof window !== "undefined") {
        const React2 = window.React;
        return React2?.version;
      }
    } catch {
    }
    return void 0;
  }
};
_FloTraceWebSocketClient.MAX_RECONNECT_ATTEMPTS = 10;
_FloTraceWebSocketClient.MAX_RECONNECT_INTERVAL = 3e4;
// 30s cap
_FloTraceWebSocketClient.BATCH_FLUSH_MS = 100;
// Flush batched messages every 100ms
_FloTraceWebSocketClient.MAX_QUEUE_SIZE = 500;
var FloTraceWebSocketClient = _FloTraceWebSocketClient;
var clientInstance = null;
function getWebSocketClient(config) {
  if (!clientInstance) {
    clientInstance = new FloTraceWebSocketClient(config);
  }
  return clientInstance;
}
function disposeWebSocketClient() {
  if (clientInstance) {
    clientInstance.disconnect();
    clientInstance = null;
  }
}

// src/serializer.ts
var MAX_DEPTH = 5;
var MAX_STRING_LENGTH = 500;
var MAX_ARRAY_LENGTH = 50;
var MAX_OBJECT_KEYS = 30;
function serializeValue(value, depth = 0, seen = /* @__PURE__ */ new WeakSet()) {
  if (value === null) {
    return null;
  }
  if (value === void 0) {
    return { __type: "undefined" };
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      return {
        __type: "truncated",
        originalType: "string",
        length: value.length
      };
    }
    return value;
  }
  if (typeof value === "symbol") {
    return {
      __type: "symbol",
      description: value.description
    };
  }
  if (typeof value === "function") {
    return {
      __type: "function",
      name: value.name || "anonymous"
    };
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return { __type: "circular" };
    }
    if (depth >= MAX_DEPTH) {
      return {
        __type: "truncated",
        originalType: Array.isArray(value) ? "array" : "object"
      };
    }
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) {
        const truncated = value.slice(0, MAX_ARRAY_LENGTH).map((item) => serializeValue(item, depth + 1, seen));
        return [
          ...truncated,
          {
            __type: "truncated",
            originalType: "array",
            length: value.length
          }
        ];
      }
      return value.map((item) => serializeValue(item, depth + 1, seen));
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message
      };
    }
    if (value instanceof Map) {
      const obj = {};
      let count = 0;
      for (const [k, v] of value.entries()) {
        if (count >= MAX_OBJECT_KEYS) {
          obj.__truncated = { __type: "truncated", originalType: "Map", length: value.size };
          break;
        }
        obj[String(k)] = serializeValue(v, depth + 1, seen);
        count++;
      }
      return obj;
    }
    if (value instanceof Set) {
      const arr = Array.from(value);
      if (arr.length > MAX_ARRAY_LENGTH) {
        return {
          __type: "truncated",
          originalType: "Set",
          length: arr.length
        };
      }
      return arr.map((item) => serializeValue(item, depth + 1, seen));
    }
    if (value instanceof RegExp) {
      return value.toString();
    }
    const keys = Object.keys(value);
    const result = {};
    for (let i = 0; i < Math.min(keys.length, MAX_OBJECT_KEYS); i++) {
      const key = keys[i];
      try {
        result[key] = serializeValue(
          value[key],
          depth + 1,
          seen
        );
      } catch {
        result[key] = { __type: "truncated", originalType: "error" };
      }
    }
    if (keys.length > MAX_OBJECT_KEYS) {
      result.__truncated = {
        __type: "truncated",
        originalType: "object",
        length: keys.length
      };
    }
    return result;
  }
  return { __type: "truncated", originalType: typeof value };
}
function serializeProps(props) {
  const result = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key" || key === "ref") {
      continue;
    }
    if (key.startsWith("__")) {
      continue;
    }
    try {
      result[key] = serializeValue(value);
    } catch (error) {
      console.error(`[FloTrace] Error serializing prop "${key}":`, error);
      result[key] = { __type: "truncated", originalType: "error" };
    }
  }
  return result;
}
function getChangedKeys(prev, next) {
  if (!prev) {
    return Object.keys(next);
  }
  const changed = [];
  const allKeys = /* @__PURE__ */ new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    if (!Object.is(prev[key], next[key])) {
      changed.push(key);
    }
  }
  return changed;
}

// src/fiberConstants.ts
var HOOK_HAS_EFFECT = 1;
var HOOK_INSERTION = 2;
var HOOK_LAYOUT = 4;
var HOOK_PASSIVE = 8;
function collectCircularList(lastEffect) {
  const list = [];
  let effect = lastEffect.next;
  if (!effect) return list;
  do {
    list.push(effect);
    effect = effect.next;
  } while (effect && effect !== lastEffect.next);
  return list;
}

// src/hookInspector.ts
function inspectHooks(fiber) {
  const hooks = [];
  let hookState = fiber.memoizedState;
  const effects = fiber.updateQueue?.lastEffect ? collectCircularList(fiber.updateQueue.lastEffect) : [];
  let effectIndex = 0;
  const debugTypes = fiber._debugHookTypes ?? null;
  let index = 0;
  while (hookState) {
    try {
      const debugLabel = debugTypes?.[index] ?? void 0;
      const hookInfo = classifyHook(hookState, index, effects, effectIndex, debugLabel);
      hooks.push(hookInfo);
      if (hookInfo.type === "useEffect" || hookInfo.type === "useLayoutEffect" || hookInfo.type === "useInsertionEffect") {
        effectIndex++;
      }
    } catch (error) {
      hooks.push({ index, type: "unknown", value: { __type: "truncated", originalType: "error" } });
    }
    hookState = hookState.next;
    index++;
  }
  return hooks;
}
function classifyHook(state, index, effects, effectIdx, debugLabel) {
  const ms = state.memoizedState;
  if (debugLabel) {
    return classifyFromDebugLabel(state, index, effects, effectIdx, debugLabel);
  }
  if (state.queue !== null) {
    const queue = state.queue;
    const isReducer = queue.lastRenderedReducer && typeof queue.lastRenderedReducer === "function" && queue.lastRenderedReducer.name !== "" && queue.lastRenderedReducer.name !== "basicStateReducer";
    return {
      index,
      type: isReducer ? "useReducer" : "useState",
      value: serializeValue(ms, 0, /* @__PURE__ */ new WeakSet())
    };
  }
  if (ms !== null && typeof ms === "object" && !Array.isArray(ms) && "current" in ms) {
    const keys = Object.keys(ms);
    if (keys.length === 1 && keys[0] === "current") {
      return {
        index,
        type: "useRef",
        value: serializeValue(ms.current, 0, /* @__PURE__ */ new WeakSet())
      };
    }
  }
  if (Array.isArray(ms) && ms.length === 2 && Array.isArray(ms[1])) {
    const isCallback = typeof ms[0] === "function";
    return {
      index,
      type: isCallback ? "useCallback" : "useMemo",
      value: serializeValue(ms[0], 0, /* @__PURE__ */ new WeakSet()),
      deps: ms[1].map((d) => serializeValue(d, 0, /* @__PURE__ */ new WeakSet()))
    };
  }
  if (effectIdx < effects.length) {
    const effect = effects[effectIdx];
    if (typeof ms === "number" || isEffectShape(ms)) {
      const type = (effect.tag & HOOK_PASSIVE) !== 0 ? "useEffect" : (effect.tag & HOOK_LAYOUT) !== 0 ? "useLayoutEffect" : (effect.tag & HOOK_INSERTION) !== 0 ? "useInsertionEffect" : "useEffect";
      return {
        index,
        type,
        value: { __type: "function", name: "effect" },
        deps: effect.deps ? effect.deps.map((d) => serializeValue(d, 0, /* @__PURE__ */ new WeakSet())) : void 0
      };
    }
  }
  if (Array.isArray(ms) && ms.length === 2 && typeof ms[0] === "boolean" && typeof ms[1] === "function") {
    return {
      index,
      type: "useTransition",
      value: serializeValue(ms[0], 0, /* @__PURE__ */ new WeakSet())
    };
  }
  if (typeof ms === "string" && ms.startsWith(":")) {
    return {
      index,
      type: "useId",
      value: ms
    };
  }
  return { index, type: "unknown", value: serializeValue(ms, 0, /* @__PURE__ */ new WeakSet()) };
}
function classifyFromDebugLabel(state, index, effects, effectIdx, debugLabel) {
  const ms = state.memoizedState;
  const normalizedLabel = debugLabel.toLowerCase().replace(/\s/g, "");
  const labelMap = {
    "usestate": "useState",
    "usereducer": "useReducer",
    "useref": "useRef",
    "usememo": "useMemo",
    "usecallback": "useCallback",
    "useeffect": "useEffect",
    "uselayouteffect": "useLayoutEffect",
    "useinsertioneffect": "useInsertionEffect",
    "usecontext": "useContext",
    "useimperativehandle": "useImperativeHandle",
    "usedebugvalue": "useDebugValue",
    "usetransition": "useTransition",
    "usedeferredvalue": "useDeferredValue",
    "useid": "useId",
    "usesyncexternalstore": "useSyncExternalStore",
    "useoptimistic": "useOptimistic",
    "useformstatus": "useFormStatus"
  };
  const hookType = labelMap[normalizedLabel] ?? "unknown";
  const base = { index, type: hookType, value: serializeValue(ms, 0, /* @__PURE__ */ new WeakSet()), debugLabel };
  if (hookType === "useEffect" || hookType === "useLayoutEffect" || hookType === "useInsertionEffect") {
    if (effectIdx < effects.length) {
      const effect = effects[effectIdx];
      base.value = { __type: "function", name: "effect" };
      base.deps = effect.deps ? effect.deps.map((d) => serializeValue(d, 0, /* @__PURE__ */ new WeakSet())) : void 0;
    }
  }
  if ((hookType === "useMemo" || hookType === "useCallback") && Array.isArray(ms) && ms.length === 2 && Array.isArray(ms[1])) {
    base.value = serializeValue(ms[0], 0, /* @__PURE__ */ new WeakSet());
    base.deps = ms[1].map((d) => serializeValue(d, 0, /* @__PURE__ */ new WeakSet()));
  }
  if (hookType === "useRef" && ms !== null && typeof ms === "object" && "current" in ms) {
    base.value = serializeValue(ms.current, 0, /* @__PURE__ */ new WeakSet());
  }
  return base;
}
function isEffectShape(ms) {
  if (ms === null || ms === void 0) return false;
  if (typeof ms === "object" && ms !== null) {
    const obj = ms;
    return "tag" in obj && "create" in obj && "deps" in obj;
  }
  return false;
}

// src/effectInspector.ts
function inspectEffects(fiber) {
  const results = [];
  const lastEffect = fiber.updateQueue?.lastEffect;
  if (!lastEffect) return results;
  const currEffects = collectCircularList(lastEffect);
  const prevEffects = fiber.alternate?.updateQueue?.lastEffect ? collectCircularList(fiber.alternate.updateQueue.lastEffect) : [];
  const hookIndexMap = buildEffectToHookIndexMap(fiber, currEffects);
  for (let i = 0; i < currEffects.length; i++) {
    try {
      const curr = currEffects[i];
      const prev = prevEffects[i] ?? null;
      const type = (curr.tag & HOOK_PASSIVE) !== 0 ? "useEffect" : (curr.tag & HOOK_LAYOUT) !== 0 ? "useLayoutEffect" : (curr.tag & HOOK_INSERTION) !== 0 ? "useInsertionEffect" : "useEffect";
      const willRun = (curr.tag & HOOK_HAS_EFFECT) !== 0;
      const changedDepIndices = diffDeps(prev?.deps ?? null, curr.deps);
      const hasCleanup = typeof curr.destroy === "function";
      results.push({
        index: i,
        hookIndex: hookIndexMap.get(i) ?? -1,
        type,
        deps: serializeDeps(curr.deps),
        prevDeps: prev ? serializeDeps(prev.deps) : null,
        changedDepIndices,
        willRun,
        hasCleanup
      });
    } catch (error) {
      results.push({
        index: i,
        hookIndex: -1,
        type: "useEffect",
        deps: null,
        prevDeps: null,
        changedDepIndices: [],
        willRun: false,
        hasCleanup: false
      });
    }
  }
  return results;
}
function buildEffectToHookIndexMap(fiber, effects) {
  const map = /* @__PURE__ */ new Map();
  let hookState = fiber.memoizedState;
  let hookIndex = 0;
  let effectIndex = 0;
  while (hookState && effectIndex < effects.length) {
    const ms = hookState.memoizedState;
    if (isLikelyEffectHook(ms, hookState)) {
      map.set(effectIndex, hookIndex);
      effectIndex++;
    }
    hookState = hookState.next;
    hookIndex++;
  }
  return map;
}
function isLikelyEffectHook(ms, state) {
  if (state.queue !== null) return false;
  if (ms !== null && typeof ms === "object") {
    const obj = ms;
    if ("tag" in obj && "create" in obj && "deps" in obj) return true;
  }
  return false;
}
function diffDeps(prev, curr) {
  if (!prev || !curr) return [];
  const changed = [];
  const len = Math.max(prev.length, curr.length);
  for (let i = 0; i < len; i++) {
    if (!Object.is(prev[i], curr[i])) {
      changed.push(i);
    }
  }
  return changed;
}
function serializeDeps(deps) {
  if (deps === null) return null;
  return deps.map((d) => serializeValue(d, 0, /* @__PURE__ */ new WeakSet()));
}

// src/timelineTracker.ts
var MAX_EVENTS_PER_COMPONENT = 100;
var FLUSH_INTERVAL_MS = 500;
var MAX_PENDING_EVENTS = 200;
var timelines = /* @__PURE__ */ new Map();
var pendingEvents = [];
var client = null;
var flushTimer = null;
var isInstalled = false;
function installTimelineTracker(wsClient) {
  if (isInstalled) return;
  client = wsClient;
  isInstalled = true;
  flushTimer = setInterval(flushPendingEvents, FLUSH_INTERVAL_MS);
}
function uninstallTimelineTracker() {
  if (!isInstalled) return;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flushPendingEvents();
  timelines.clear();
  pendingEvents = [];
  client = null;
  isInstalled = false;
}
function recordTimelineEvent(nodeId, componentName, eventType, detail, duration) {
  if (!isInstalled) return;
  const event = {
    type: eventType,
    timestamp: Date.now(),
    duration,
    detail: detail !== void 0 ? serializeValue(detail, 0, /* @__PURE__ */ new WeakSet()) : void 0
  };
  let events = timelines.get(nodeId);
  if (!events) {
    events = [];
    timelines.set(nodeId, events);
  }
  events.push(event);
  if (events.length > MAX_EVENTS_PER_COMPONENT) {
    events.shift();
  }
  if (pendingEvents.length < MAX_PENDING_EVENTS) {
    pendingEvents.push({ nodeId, componentName, event });
  }
}
function getTimeline(nodeId) {
  return timelines.get(nodeId) ?? [];
}
function flushPendingEvents() {
  if (!client?.connected || pendingEvents.length === 0) return;
  for (const { nodeId, componentName, event } of pendingEvents) {
    client.send({
      type: "runtime:timelineEvent",
      nodeId,
      componentName,
      event
    });
  }
  pendingEvents = [];
}

// src/fiberUtils.ts
function getFiberDisplayName(type) {
  if (!type) return "Unknown";
  if (typeof type === "function") {
    return type.displayName || type.name || "Anonymous";
  }
  if (typeof type === "object") {
    const t = type;
    return t.type?.displayName || t.type?.name || t.render?.name || t.displayName || t.name || "Unknown";
  }
  return "Unknown";
}

// src/dispatchWrapper.ts
var MAX_TRIGGERS = 200;
var triggerBuffer = [];
var triggerSeq = 0;
var wrappedDispatchers = /* @__PURE__ */ new WeakSet();
var currentBatchId = null;
function nextBatchId() {
  if (!currentBatchId) {
    currentBatchId = String(Date.now()) + "-" + (Math.random() * 65535 | 0).toString(16);
    queueMicrotask(() => {
      currentBatchId = null;
    });
  }
  return currentBatchId;
}
function nextTriggerId() {
  return "tr-" + (++triggerSeq).toString(36);
}
var STACK_DEPTH_LIMIT = 15;
var NOISE_PATTERNS = [
  "node_modules",
  "react-dom",
  "react-reconciler",
  "@flotrace/runtime",
  "flotrace/runtime",
  "/runtime/src/",
  "webpack-internal",
  "webpack/bootstrap",
  "<anonymous>"
];
function isUserCodeFrame(fileName) {
  if (!fileName) return false;
  for (const pattern of NOISE_PATTERNS) {
    if (fileName.includes(pattern)) return false;
  }
  return true;
}
function captureStack() {
  const frames = [];
  try {
    const originalPrepare = Error.prepareStackTrace;
    Error.prepareStackTrace = (_err, callSites) => {
      for (const site of callSites) {
        if (frames.length >= STACK_DEPTH_LIMIT) break;
        const fileName = site.getFileName();
        frames.push({
          functionName: site.getFunctionName() ?? site.getMethodName(),
          fileName,
          lineNumber: site.getLineNumber(),
          columnNumber: site.getColumnNumber(),
          isUserCode: isUserCodeFrame(fileName)
        });
      }
      return "";
    };
    const err = new Error();
    void err.stack;
    Error.prepareStackTrace = originalPrepare;
  } catch {
    try {
      const raw = new Error().stack ?? "";
      const lines = raw.split("\n").slice(1);
      for (const line of lines) {
        if (frames.length >= STACK_DEPTH_LIMIT) break;
        const match = line.match(/^\s+at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
        if (match) {
          const fileName = match[2] ?? null;
          frames.push({
            functionName: match[1] ?? null,
            fileName,
            lineNumber: match[3] ? parseInt(match[3], 10) : null,
            columnNumber: match[4] ? parseInt(match[4], 10) : null,
            isUserCode: isUserCodeFrame(fileName)
          });
        }
      }
    } catch {
    }
  }
  return frames;
}
var FIBER_TAG_FUNCTION = 0;
var FIBER_TAG_CLASS = 1;
var FIBER_TAG_FORWARD = 11;
var FIBER_TAG_MEMO = 14;
var FIBER_TAG_SIMPLEMEMO = 15;
function getComponentName(fiber) {
  return getFiberDisplayName(fiber.type);
}
function wrapFunctionComponentDispatchers(fiber) {
  let hookNode = fiber.memoizedState;
  let hookIndex = 0;
  while (hookNode && hookIndex < 100) {
    try {
      const queue = hookNode.queue;
      if (queue && typeof queue.dispatch === "function") {
        const original = queue.dispatch;
        if (!wrappedDispatchers.has(original)) {
          const componentName = getComponentName(fiber);
          const fiberId = getFiberId(fiber);
          const capturedHookIndex = hookIndex;
          const hookType = typeof queue.lastRenderedReducer === "function" && queue.lastRenderedReducer?.toString().includes("action") ? "reducer" : "state";
          const wrapped = function dispatchWithCapture(action) {
            try {
              const stack = captureStack();
              const record = {
                triggerId: nextTriggerId(),
                fiberId,
                componentName,
                hookIndex: capturedHookIndex,
                hookType,
                stack,
                timestamp: performance.now(),
                action: serializeValue(action, 2),
                batchId: nextBatchId()
              };
              addTrigger(record);
            } catch {
            }
            return original(action);
          };
          wrappedDispatchers.add(wrapped);
          queue.dispatch = wrapped;
        }
      }
    } catch {
    }
    hookNode = hookNode.next;
    hookIndex++;
  }
}
function wrapClassComponentInstance(fiber) {
  const instance = fiber.stateNode;
  if (!instance || instance.__ftWrapped) return;
  const componentName = getComponentName(fiber);
  const fiberId = getFiberId(fiber);
  if (typeof instance.setState === "function") {
    const origSetState = instance.setState;
    instance.setState = function wrappedSetState(updater, callback) {
      try {
        const stack = captureStack();
        addTrigger({
          triggerId: nextTriggerId(),
          fiberId,
          componentName,
          hookIndex: 0,
          hookType: "setState",
          stack,
          timestamp: performance.now(),
          action: serializeValue(updater, 2),
          batchId: nextBatchId()
        });
      } catch {
      }
      return origSetState.call(this, updater, callback);
    };
  }
  if (typeof instance.forceUpdate === "function") {
    const origForceUpdate = instance.forceUpdate;
    instance.forceUpdate = function wrappedForceUpdate(callback) {
      try {
        const stack = captureStack();
        addTrigger({
          triggerId: nextTriggerId(),
          fiberId,
          componentName,
          hookIndex: 0,
          hookType: "forceUpdate",
          stack,
          timestamp: performance.now(),
          action: null,
          batchId: nextBatchId()
        });
      } catch {
      }
      return origForceUpdate.call(this, callback);
    };
  }
  instance.__ftWrapped = true;
}
var fiberIds = /* @__PURE__ */ new WeakMap();
var fiberIdSeq = 0;
function getFiberId(fiber) {
  let id = fiberIds.get(fiber);
  if (!id) {
    id = getComponentName(fiber) + "-" + (++fiberIdSeq).toString(36);
    fiberIds.set(fiber, id);
  }
  return id;
}
function addTrigger(record) {
  if (triggerBuffer.length >= MAX_TRIGGERS) {
    triggerBuffer.shift();
  }
  triggerBuffer.push(record);
}
function wrapFiberDispatchers(root) {
  try {
    walkAndWrap(root.current);
  } catch {
  }
}
function walkAndWrap(rootFiber) {
  if (!rootFiber) return;
  const stack = [rootFiber];
  while (stack.length > 0) {
    const fiber = stack.pop();
    try {
      const tag = fiber.tag;
      if (tag === FIBER_TAG_FUNCTION || tag === FIBER_TAG_FORWARD || tag === FIBER_TAG_MEMO || tag === FIBER_TAG_SIMPLEMEMO) {
        wrapFunctionComponentDispatchers(fiber);
      } else if (tag === FIBER_TAG_CLASS) {
        wrapClassComponentInstance(fiber);
      }
    } catch {
    }
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
}
function peekTriggers() {
  return triggerBuffer;
}
function clearTriggers() {
  triggerBuffer.length = 0;
}

// src/laneDetector.ts
var SyncHydrationLane = 1;
var SyncLane = 2;
var InputContinuousHydrationLane = 4;
var InputContinuousLane = 8;
var DefaultHydrationLane = 16;
var DefaultLane = 32;
var TransitionLanes = 4194240;
var RetryLanes = 62914560;
var SelectiveHydrationLane = 67108864;
var IdleHydrationLane = 134217728;
var IdleLane = 268435456;
var OffscreenLane = 536870912;
function classifyLanes(lanes) {
  try {
    if (lanes & SyncHydrationLane || lanes & SyncLane) {
      return { priority: "sync", lanes, isTransition: false, isBlocking: true };
    }
    if (lanes & InputContinuousHydrationLane || lanes & InputContinuousLane) {
      return { priority: "discrete", lanes, isTransition: false, isBlocking: true };
    }
    if (lanes & DefaultHydrationLane || lanes & DefaultLane) {
      return { priority: "default", lanes, isTransition: false, isBlocking: false };
    }
    if (lanes & TransitionLanes) {
      return { priority: "transition", lanes, isTransition: true, isBlocking: false };
    }
    if (lanes & RetryLanes || lanes & SelectiveHydrationLane) {
      return { priority: "deferred", lanes, isTransition: false, isBlocking: false };
    }
    if (lanes & IdleHydrationLane || lanes & IdleLane) {
      return { priority: "idle", lanes, isTransition: false, isBlocking: false };
    }
    if (lanes & OffscreenLane) {
      return { priority: "offscreen", lanes, isTransition: false, isBlocking: false };
    }
  } catch {
  }
  return { priority: "default", lanes, isTransition: false, isBlocking: false };
}
function getFinishedLanes(root) {
  try {
    return root.finishedLanes ?? root.pendingLanes ?? 0;
  } catch {
    return 0;
  }
}

// src/cascadeAnalyzer.ts
var PerformedWork = 1;
var ForceUpdateFlag = 256;
var FunctionComponent = 0;
var ClassComponent = 1;
var ForwardRef = 11;
var MemoComponent = 14;
var SimpleMemoComponent = 15;
var USER_TAGS = /* @__PURE__ */ new Set([FunctionComponent, ClassComponent, ForwardRef, MemoComponent, SimpleMemoComponent]);
function isMemoizedFiber(fiber) {
  return fiber.tag === MemoComponent || fiber.tag === SimpleMemoComponent;
}
function propsChanged(prev, next) {
  if (prev === next) return false;
  if (!prev || !next) return true;
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return true;
  for (const key of nextKeys) {
    if (key === "children") continue;
    if (prev[key] !== next[key]) return true;
  }
  return false;
}
function getChangedPropKeys(prev, next) {
  if (!prev || !next) return [];
  const changed = [];
  const allKeys = /* @__PURE__ */ new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    if (key === "children") continue;
    if (prev[key] !== next[key]) changed.push(key);
  }
  return changed;
}
function hadOwnUpdate(fiber) {
  try {
    const uq = fiber.updateQueue;
    if (!uq) return false;
    if (uq.shared && uq.shared.pending != null) return true;
    if (fiber.lanes !== 0) return true;
    return false;
  } catch {
    return false;
  }
}
function hadContextUpdate(fiber) {
  try {
    return !!fiber.dependencies?.firstContext;
  } catch {
    return false;
  }
}
function classifyFiber(fiber, didRender, parentRerendered) {
  if (!didRender) {
    if (fiber.alternate && isMemoizedFiber(fiber)) return "bailed-out";
    return null;
  }
  if (fiber.flags & ForceUpdateFlag) return "force-update";
  if (hadContextUpdate(fiber)) return "context-update";
  if (hadOwnUpdate(fiber)) return "state-update";
  if (parentRerendered) {
    const alt = fiber.alternate;
    if (alt && propsChanged(alt.memoizedProps, fiber.memoizedProps)) {
      return "props-changed";
    }
    return "parent-cascade";
  }
  return "state-update";
}
function computeSubtreeDuration(node) {
  let total = node.renderDuration;
  for (const child of node.children) {
    total += computeSubtreeDuration(child);
  }
  node.subtreeDuration = total;
  return total;
}
var commitIdSeq = 0;
function nextCommitId() {
  return "c-" + (++commitIdSeq).toString(36) + "-" + (Date.now() % 1e5).toString(36);
}
function buildCascadeTree(rootFiber, triggers) {
  const rootCauses = [];
  let totalComponents = 0;
  let avoidableCount = 0;
  let avoidableDuration = 0;
  const triggerByName = /* @__PURE__ */ new Map();
  for (const t of triggers) {
    if (!triggerByName.has(t.componentName)) {
      triggerByName.set(t.componentName, t);
    }
  }
  const stack = [{
    fiber: rootFiber,
    depth: 0,
    parentRerendered: false,
    parentNode: null,
    isRoot: true
  }];
  while (stack.length > 0) {
    const entry = stack.pop();
    const { fiber, depth, parentRerendered, parentNode, isRoot } = entry;
    if (!fiber) continue;
    if (depth > 150) continue;
    const didRender = !!(fiber.flags & PerformedWork);
    const isNewMount = !fiber.alternate;
    if (isNewMount && !didRender) {
      let child2 = fiber.child;
      while (child2) {
        stack.push({ fiber: child2, depth: depth + 1, parentRerendered: false, parentNode, isRoot: false });
        child2 = child2.sibling;
      }
      continue;
    }
    if (!USER_TAGS.has(fiber.tag)) {
      let child2 = fiber.child;
      while (child2) {
        stack.push({ fiber: child2, depth: depth + 1, parentRerendered: didRender || parentRerendered, parentNode, isRoot: false });
        child2 = child2.sibling;
      }
      continue;
    }
    const reason = classifyFiber(fiber, didRender, parentRerendered);
    if (reason === null) {
      let child2 = fiber.child;
      while (child2) {
        stack.push({ fiber: child2, depth: depth + 1, parentRerendered: false, parentNode, isRoot: false });
        child2 = child2.sibling;
      }
      continue;
    }
    const componentName = getFiberDisplayName(fiber.type);
    const renderDuration = fiber.actualDuration ?? 0;
    let changedProps;
    if (reason === "props-changed" && fiber.alternate) {
      changedProps = getChangedPropKeys(fiber.alternate.memoizedProps, fiber.memoizedProps);
    }
    let triggerId;
    if (reason === "state-update" || reason === "context-update" || reason === "force-update") {
      triggerId = triggerByName.get(componentName)?.triggerId;
    }
    const node = {
      nodeId: componentName + "-" + depth + "-" + totalComponents,
      componentName,
      reason,
      renderDuration,
      subtreeDuration: renderDuration,
      // will be updated from children
      changedProps,
      triggerId,
      children: [],
      depth,
      isMemoized: isMemoizedFiber(fiber)
    };
    totalComponents++;
    if (reason === "parent-cascade") {
      avoidableCount++;
      avoidableDuration += renderDuration;
    }
    if (parentNode) {
      parentNode.children.push(node);
    } else if (reason === "state-update" || reason === "context-update" || reason === "force-update" || isRoot) {
      rootCauses.push(node);
    } else if (parentRerendered) {
      rootCauses.push(node);
    }
    let child = fiber.child;
    while (child) {
      stack.push({
        fiber: child,
        depth: depth + 1,
        parentRerendered: didRender,
        parentNode: reason !== "bailed-out" ? node : parentNode,
        isRoot: false
      });
      child = child.sibling;
    }
  }
  for (const root of rootCauses) computeSubtreeDuration(root);
  return { rootCauses, totalComponents, avoidableCount, avoidableDuration };
}
function analyzeCascade(root, triggers) {
  try {
    const finishedLanes = getFinishedLanes(root);
    const lane = classifyLanes(finishedLanes);
    const { rootCauses, totalComponents, avoidableCount, avoidableDuration } = buildCascadeTree(root.current, triggers);
    if (totalComponents === 0) return null;
    const totalDuration = rootCauses.reduce((sum, n) => sum + n.subtreeDuration, 0);
    const triggerIds = triggers.map((t) => t.triggerId);
    return {
      commitId: nextCommitId(),
      timestamp: performance.now(),
      totalDuration,
      totalComponents,
      avoidableCount,
      avoidableDuration,
      rootCauses,
      lane,
      triggerIds
    };
  } catch {
    return null;
  }
}

// src/fiberTreeWalker.ts
var FIBER_TAGS = {
  FunctionComponent: 0,
  ClassComponent: 1,
  HostRoot: 3,
  // Root of a host tree (e.g., #root DOM node)
  HostComponent: 5,
  // DOM elements (div, span, etc.) - SKIP these
  HostText: 6,
  // Text nodes - SKIP these
  Fragment: 7,
  // React.Fragment - SKIP but traverse children
  Mode: 8,
  // React.StrictMode, ConcurrentMode - SKIP but traverse children
  ContextConsumer: 9,
  ContextProvider: 10,
  ForwardRef: 11,
  Profiler: 12,
  // React.Profiler - SKIP but traverse children
  SuspenseComponent: 13,
  MemoComponent: 14,
  SimpleMemoComponent: 15,
  LazyComponent: 16,
  OffscreenComponent: 22
  // React 18 concurrent features - SKIP but traverse children
};
var USER_COMPONENT_TAGS = /* @__PURE__ */ new Set([
  FIBER_TAGS.FunctionComponent,
  FIBER_TAGS.ClassComponent,
  FIBER_TAGS.ForwardRef,
  FIBER_TAGS.MemoComponent,
  FIBER_TAGS.SimpleMemoComponent
]);
function isLikelyQueryObserver(obj) {
  if (obj === null || typeof obj !== "object") return false;
  const candidate = obj;
  return typeof candidate.getCurrentResult === "function" && typeof candidate.subscribe === "function";
}
function getQueryHashFromObserver(observer) {
  if (observer.options && typeof observer.options === "object") {
    const opts = observer.options;
    if (typeof opts.queryHash === "string") return opts.queryHash;
  }
  if (observer.currentQuery && typeof observer.currentQuery === "object") {
    const q = observer.currentQuery;
    if (typeof q.queryHash === "string") return q.queryHash;
  }
  if (typeof observer.queryHash === "string") return observer.queryHash;
  return null;
}
function detectQueryObserverHashes(fiber) {
  let hookState = fiber.memoizedState;
  if (!hookState) return void 0;
  const seen = /* @__PURE__ */ new Set();
  let iterations = 0;
  while (hookState && iterations < 100) {
    iterations++;
    try {
      const ms = hookState.memoizedState;
      if (isLikelyQueryObserver(ms)) {
        const hash = getQueryHashFromObserver(ms);
        if (hash) seen.add(hash);
      } else if (ms !== null && typeof ms === "object" && !Array.isArray(ms)) {
        const ref = ms.current;
        if (isLikelyQueryObserver(ref)) {
          const hash = getQueryHashFromObserver(ref);
          if (hash) seen.add(hash);
        }
      }
    } catch {
    }
    hookState = hookState.next;
  }
  return seen.size > 0 ? Array.from(seen) : void 0;
}
var MAX_TREE_DEPTH = 100;
var MAX_CHILDREN_PER_NODE = 300;
var debounceTimer = null;
var DEBOUNCE_MS_SMALL = 200;
var DEBOUNCE_MS_MEDIUM = 500;
var DEBOUNCE_MS_LARGE = 1e3;
var currentDebounceMs = DEBOUNCE_MS_SMALL;
var isWalking = false;
var originalOnCommitFiberRoot = null;
var isInstalled2 = false;
var hookedRendererID = null;
var activeStrategy = null;
var lastSnapshotSentTime = 0;
var DEVTOOLS_STALE_THRESHOLD_MS = 2e3;
var debugEnabled = false;
try {
  debugEnabled = !!globalThis.__FLOTRACE_DEBUG__;
} catch {
}
function debugLog(...args) {
  if (debugEnabled) console.log(...args);
}
var fiberRefMap = /* @__PURE__ */ new Map();
function getComponentName2(fiber) {
  const type = fiber.type;
  if (!type) return "Unknown";
  if (typeof type === "function") {
    return type.displayName || type.name || "Anonymous";
  }
  if (typeof type === "object" && type !== null) {
    const t = type;
    if (t.type) {
      return t.type.displayName || t.type.name || "Memo";
    }
    if (t.render) {
      return t.render.displayName || t.render.name || "ForwardRef";
    }
    return t.displayName || t.name || "Unknown";
  }
  if (typeof type === "string") {
    return type;
  }
  return "Unknown";
}
function isUserComponent(fiber) {
  if (!USER_COMPONENT_TAGS.has(fiber.tag)) return false;
  const name = getComponentName2(fiber);
  if (name === "Anonymous" || name === "Unknown" || name === "ForwardRef" || name === "Memo")
    return false;
  if (name.startsWith("FloTrace")) return false;
  if (name.startsWith("@") || name.includes("/")) return false;
  if (fiber._debugSource?.fileName?.includes("node_modules")) return false;
  return true;
}
var FRAMEWORK_COMPONENT_NAMES = /* @__PURE__ */ new Set([
  // Next.js App Router internals
  "InnerLayoutRouter",
  "OuterLayoutRouter",
  "HotReload",
  "RedirectBoundary",
  "NotFoundBoundary",
  "RenderFromTemplateContext",
  "ScrollAndFocusHandler",
  "AppRouter",
  "ServerRoot",
  "ReactDevOverlay",
  "PathnameContextProviderAdapter",
  "MetadataBoundary",
  "ViewportBoundary",
  "NotFoundErrorBoundary",
  "RedirectErrorBoundary",
  "InnerScrollAndFocusHandler",
  "GlobalError",
  // React Router v6
  "Routes",
  "Route",
  "Router",
  "BrowserRouter",
  "HashRouter",
  "MemoryRouter",
  "Outlet",
  "Navigate",
  "RenderedRoute",
  "RouterProvider",
  // Common wrappers
  "Suspense",
  "ErrorBoundary",
  "QueryClientProvider",
  "PersistGate"
]);
var FRAMEWORK_PATH_PATTERNS = [
  /next[\\/]dist/,
  /react-router/,
  /react-dom/,
  /@tanstack[\\/]/,
  /react-redux/
];
function isFrameworkComponent(fiber, name) {
  if (FRAMEWORK_COMPONENT_NAMES.has(name)) return true;
  const filePath = fiber._debugSource?.fileName;
  if (filePath) {
    for (const pattern of FRAMEWORK_PATH_PATTERNS) {
      if (pattern.test(filePath)) return true;
    }
  }
  return false;
}
function buildNodeId(name, sameNameIndex, parentId) {
  const segment = `${name}-${sameNameIndex}`;
  return parentId ? `${parentId}/${segment}` : segment;
}
function shallowPropsChanged(prev, next) {
  if (prev === next) return false;
  if (!prev || !next) return true;
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return true;
  for (const key of nextKeys) {
    if (key === "children") continue;
    if (prev[key] !== next[key]) return true;
  }
  return false;
}
function detectRenderReason(fiber, renderPhase) {
  if (renderPhase === "mount") return "mount";
  const prev = fiber.alternate;
  if (!prev) return "mount";
  if (shallowPropsChanged(prev.memoizedProps, fiber.memoizedProps)) {
    return "props-changed";
  }
  return "state-or-context";
}
function walkFiber(fiber, parentId, sharedNameCountMap, depth = 0) {
  if (!fiber) return [];
  if (depth >= MAX_TREE_DEPTH) return [];
  const nodes = [];
  let current = fiber;
  const nameCountMap = sharedNameCountMap || /* @__PURE__ */ new Map();
  while (current) {
    try {
      const tag = current.tag;
      if (isUserComponent(current)) {
        const name = getComponentName2(current);
        const nameCount = nameCountMap.get(name) || 0;
        nameCountMap.set(name, nameCount + 1);
        const nodeId = buildNodeId(name, nameCount, parentId);
        fiberRefMap.set(nodeId, current);
        const renderPhase = current.alternate ? "update" : "mount";
        const renderReason = detectRenderReason(current, renderPhase);
        recordTimelineEvent(
          nodeId,
          name,
          renderPhase === "mount" ? "mount" : "render",
          { reason: renderReason },
          current.actualDuration
        );
        const children = walkFiber(
          current.child,
          nodeId,
          void 0,
          depth + 1
        );
        const truncatedChildren = children.length > MAX_CHILDREN_PER_NODE ? children.slice(0, MAX_CHILDREN_PER_NODE) : children;
        const framework = isFrameworkComponent(current, name) || void 0;
        const queryHashes = detectQueryObserverHashes(current);
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
          reactKey: typeof current.key === "string" ? current.key : void 0,
          queryHashes
        });
      } else if (tag === FIBER_TAGS.HostText) {
      } else {
        const childNodes = walkFiber(
          current.child,
          parentId,
          nameCountMap,
          depth
        );
        nodes.push(...childNodes);
      }
    } catch (error) {
      console.error("[FloTrace] Error processing fiber node, skipping:", error);
    }
    current = current.sibling;
  }
  return nodes;
}
function buildTreeFromFiberRoot(root) {
  const rootFiber = root.current;
  if (!rootFiber || !rootFiber.child) {
    console.warn("[FloTrace] No root fiber or no child:", {
      hasRoot: !!rootFiber,
      hasChild: !!rootFiber?.child
    });
    return null;
  }
  fiberRefMap.clear();
  const topLevelNodes = walkFiber(rootFiber.child, "");
  debugLog(
    "[FloTrace] walkFiber found",
    topLevelNodes.length,
    "top-level nodes"
  );
  if (topLevelNodes.length === 1) {
    return topLevelNodes[0];
  }
  if (topLevelNodes.length > 0) {
    return {
      id: "Root",
      name: "Root",
      children: topLevelNodes,
      fiberTag: FIBER_TAGS.HostRoot
    };
  }
  return null;
}
function findFiberRootFromDOM() {
  try {
    if (typeof document === "undefined") return null;
    const selectors = ["#root", "#__next", "#app", "#__nuxt", "[data-reactroot]"];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      debugLog(
        `[FloTrace] Trying selector "${selector}" \u2192 found element`,
        element.tagName,
        element.id
      );
      const reactKeys = Object.keys(element).filter(
        (k) => k.startsWith("__react") || k.startsWith("_react")
      );
      debugLog(`[FloTrace] React keys on element:`, reactKeys);
      const fiberRoot = getFiberRootFromElement(element);
      if (fiberRoot) {
        debugLog("[FloTrace] Found fiber root from selector:", selector);
        return fiberRoot;
      }
    }
    const allBodyChildren = document.body?.children;
    if (allBodyChildren) {
      debugLog(
        "[FloTrace] Scanning all",
        allBodyChildren.length,
        "body children for React root..."
      );
      for (const child of Array.from(allBodyChildren)) {
        const reactKeys = Object.keys(child).filter(
          (k) => k.startsWith("__react") || k.startsWith("_react")
        );
        if (reactKeys.length > 0) {
          debugLog(
            "[FloTrace] React keys on",
            child.tagName,
            child.id || "(no id)",
            ":",
            reactKeys
          );
        }
        const fiberRoot = getFiberRootFromElement(child);
        if (fiberRoot) {
          debugLog(
            "[FloTrace] Found fiber root from body child scan:",
            child.tagName,
            child.id || "(no id)"
          );
          return fiberRoot;
        }
      }
    }
    console.warn(
      "[FloTrace] Could not find React fiber root from any DOM element"
    );
    return null;
  } catch (error) {
    console.error("[FloTrace] Error finding fiber root from DOM:", error);
    return null;
  }
}
function getFiberRootFromElement(element) {
  const keys = Object.keys(element);
  const containerKey = keys.find((k) => k.startsWith("__reactContainer$"));
  if (containerKey) {
    const hostRootFiber = element[containerKey];
    if (hostRootFiber?.stateNode) {
      return hostRootFiber.stateNode;
    }
  }
  const fiberKey = keys.find(
    (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
  );
  if (fiberKey) {
    const fiber = element[fiberKey];
    if (fiber) {
      let current = fiber;
      while (current?.return) {
        current = current.return;
      }
      if (current && current.tag === FIBER_TAGS.HostRoot && current.stateNode) {
        return current.stateNode;
      }
    }
  }
  const el = element;
  if (el._reactRootContainer?._internalRoot) {
    return el._reactRootContainer._internalRoot;
  }
  return null;
}
function sendDebouncedSnapshot(root) {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (isWalking) {
      debugLog("[FloTrace] Skipped snapshot: already walking");
      return;
    }
    isWalking = true;
    try {
      const tree = buildTreeFromFiberRoot(root);
      if (!tree) {
        console.warn("[FloTrace] buildTreeFromFiberRoot returned null");
        return;
      }
      const nodeCount = fiberRefMap.size;
      if (nodeCount >= 200) {
        currentDebounceMs = DEBOUNCE_MS_LARGE;
      } else if (nodeCount >= 50) {
        currentDebounceMs = DEBOUNCE_MS_MEDIUM;
      } else {
        currentDebounceMs = DEBOUNCE_MS_SMALL;
      }
      const client4 = getWebSocketClient();
      if (!client4.connected) {
        console.warn(
          "[FloTrace] WebSocket not connected, cannot send tree snapshot"
        );
        return;
      }
      const currentFlatTree = flattenTree(tree);
      const sendFull = previousFlatTree === null || snapshotCounter % FULL_SNAPSHOT_INTERVAL === 0;
      if (sendFull) {
        debugLog(
          "[FloTrace] Sending FULL tree snapshot, root:",
          tree.name,
          "nodes:",
          nodeCount,
          "seq:",
          snapshotCounter,
          "nextDebounce:",
          currentDebounceMs + "ms"
        );
        client4.sendImmediate({
          type: "runtime:treeSnapshot",
          tree,
          timestamp: Date.now()
        });
        lastSnapshotSentTime = Date.now();
        diffSeq = 0;
      } else {
        const diff = computeTreeDiff(previousFlatTree, currentFlatTree);
        if (diff) {
          debugLog(
            "[FloTrace] Sending tree diff, seq:",
            diffSeq,
            "added:",
            diff.added.length,
            "removed:",
            diff.removed.length,
            "updated:",
            diff.updated.length
          );
          client4.sendImmediate({
            type: "runtime:treeDiff",
            seq: diffSeq,
            added: diff.added,
            removed: diff.removed,
            updated: diff.updated,
            timestamp: Date.now()
          });
          lastSnapshotSentTime = Date.now();
          diffSeq++;
        } else {
          debugLog("[FloTrace] Tree unchanged, skipping diff");
        }
      }
      previousFlatTree = currentFlatTree;
      snapshotCounter++;
    } catch (error) {
      console.error("[FloTrace] Error walking fiber tree:", error);
    } finally {
      isWalking = false;
    }
  }, currentDebounceMs);
}
var previousFlatTree = null;
var diffSeq = 0;
var snapshotCounter = 0;
var FULL_SNAPSHOT_INTERVAL = 10;
function flattenTree(root, out = /* @__PURE__ */ new Map()) {
  out.set(root.id, root);
  for (const child of root.children) {
    flattenTree(child, out);
  }
  return out;
}
function getParentId(nodeId) {
  const lastSlash = nodeId.lastIndexOf("/");
  return lastSlash === -1 ? "" : nodeId.substring(0, lastSlash);
}
function computeTreeDiff(prev, curr) {
  const added = [];
  const removed = [];
  const updated = [];
  for (const [id, currNode] of curr) {
    const prevNode = prev.get(id);
    if (!prevNode) {
      added.push({ ...currNode, children: [], parentId: getParentId(id) });
    } else {
      if (prevNode.renderDuration !== currNode.renderDuration || prevNode.renderPhase !== currNode.renderPhase || prevNode.renderReason !== currNode.renderReason) {
        updated.push({
          id,
          renderDuration: currNode.renderDuration,
          renderPhase: currNode.renderPhase,
          renderReason: currNode.renderReason
        });
      }
    }
  }
  for (const id of prev.keys()) {
    if (!curr.has(id)) {
      removed.push(id);
    }
  }
  if (added.length === 0 && removed.length === 0 && updated.length === 0) {
    return null;
  }
  return { added, removed, updated };
}
function requestTreeSnapshot() {
  if (!isInstalled2) {
    return;
  }
  if (activeStrategy === "devtools") {
    const elapsed = Date.now() - lastSnapshotSentTime;
    if (elapsed < DEVTOOLS_STALE_THRESHOLD_MS) return;
    debugLog("[FloTrace] DevTools hook stale (" + elapsed + "ms), falling back to DOM snapshot");
  }
  const root = findFiberRootFromDOM();
  if (root) {
    sendDebouncedSnapshot(root);
  }
}
function requestFullSnapshot() {
  previousFlatTree = null;
  snapshotCounter = 0;
  diffSeq = 0;
}
function installFiberTreeWalker() {
  if (isInstalled2) {
    console.warn("[FloTrace] Fiber tree walker already installed");
    return () => uninstallFiberTreeWalker();
  }
  if (typeof window === "undefined") {
    console.warn(
      "[FloTrace] Not in browser environment, cannot install fiber tree walker"
    );
    return () => {
    };
  }
  isInstalled2 = true;
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook && typeof hook.onCommitFiberRoot === "function") {
    originalOnCommitFiberRoot = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = (rendererID, root, priority) => {
      if (originalOnCommitFiberRoot) {
        try {
          originalOnCommitFiberRoot(rendererID, root, priority);
        } catch (error) {
          console.error(
            "[FloTrace] Error in original onCommitFiberRoot:",
            error
          );
        }
      }
      if (hookedRendererID === null) {
        hookedRendererID = rendererID;
      }
      if (rendererID !== hookedRendererID) return;
      try {
        const client4 = getWebSocketClient();
        if (client4.connected) {
          const triggers = peekTriggers();
          for (const trigger of triggers) {
            client4.sendImmediate({ type: "runtime:renderTrigger", trigger });
          }
          const cascade = analyzeCascade(root, triggers);
          if (cascade) {
            client4.sendImmediate({ type: "runtime:renderCascade", cascade });
          }
          wrapFiberDispatchers(root);
          clearTriggers();
        }
      } catch {
      }
      sendDebouncedSnapshot(root);
    };
    activeStrategy = "devtools";
    console.log(
      "[FloTrace] Fiber tree walker installed (DevTools hook strategy)"
    );
    setTimeout(() => {
      try {
        const root = findFiberRootFromDOM();
        if (root) {
          sendDebouncedSnapshot(root);
        }
      } catch (error) {
        console.error("[FloTrace] Error sending initial DevTools snapshot:", error);
      }
    }, 100);
  } else {
    activeStrategy = "dom";
    console.log(
      "[FloTrace] Fiber tree walker installed (DOM fallback strategy)"
    );
    setTimeout(() => {
      try {
        const root = findFiberRootFromDOM();
        if (root) {
          sendDebouncedSnapshot(root);
        }
      } catch (error) {
        console.error("[FloTrace] Error sending initial DOM fallback snapshot:", error);
      }
    }, 100);
  }
  return () => uninstallFiberTreeWalker();
}
function getNodeProps(nodeId) {
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
function detectDetailedRenderReason(fiber) {
  if (!fiber.alternate) return { type: "mount" };
  const prev = fiber.alternate;
  if (shallowPropsChanged(prev.memoizedProps, fiber.memoizedProps)) {
    const changedProps = diffProps(prev.memoizedProps, fiber.memoizedProps);
    return { type: "props-changed", changedProps };
  }
  const changedHookIndices = diffHookStates(prev.memoizedState, fiber.memoizedState);
  if (changedHookIndices.length > 0) {
    return { type: "state-changed", changedHookIndices };
  }
  const changedContexts = detectContextChanges(fiber);
  if (changedContexts.length > 0) {
    return { type: "context-changed", contextNames: changedContexts };
  }
  const parentName = fiber.return ? getComponentName2(fiber.return) : void 0;
  return { type: "parent-render", parentName };
}
function diffProps(prev, next) {
  const changes = [];
  if (!prev || !next) return changes;
  const allKeys = /* @__PURE__ */ new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    if (key === "children") continue;
    if (!Object.is(prev[key], next[key])) {
      changes.push({
        key,
        prev: serializeValue(prev[key], 0, /* @__PURE__ */ new WeakSet()),
        next: serializeValue(next[key], 0, /* @__PURE__ */ new WeakSet())
      });
    }
  }
  return changes;
}
function diffHookStates(prev, next) {
  const changed = [];
  let prevHook = prev;
  let nextHook = next;
  let index = 0;
  while (prevHook && nextHook) {
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
function detectContextChanges(fiber) {
  const changed = [];
  if (!fiber.dependencies?.firstContext) return changed;
  let ctx = fiber.dependencies.firstContext;
  while (ctx) {
    try {
      if (!Object.is(ctx.memoizedValue, ctx.context._currentValue)) {
        const name = ctx.context.displayName || "UnknownContext";
        changed.push(name);
      }
    } catch {
    }
    ctx = ctx.next;
  }
  return changed;
}
function getDetailedRenderReason(nodeId) {
  const fiber = fiberRefMap.get(nodeId);
  if (!fiber) return null;
  try {
    return detectDetailedRenderReason(fiber);
  } catch (error) {
    console.error(`[FloTrace] Error detecting render reason for "${nodeId}":`, error);
    return null;
  }
}
function getNodeHooks(nodeId) {
  const fiber = fiberRefMap.get(nodeId);
  if (!fiber) return null;
  try {
    return inspectHooks(fiber);
  } catch (error) {
    console.error(`[FloTrace] Error inspecting hooks for node "${nodeId}":`, error);
    return null;
  }
}
function getNodeEffects(nodeId) {
  const fiber = fiberRefMap.get(nodeId);
  if (!fiber) return null;
  try {
    return inspectEffects(fiber);
  } catch (error) {
    console.error(`[FloTrace] Error inspecting effects for node "${nodeId}":`, error);
    return null;
  }
}
function getFiberRefMap() {
  return fiberRefMap;
}
function uninstallFiberTreeWalker() {
  if (!isInstalled2) return;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
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
  fiberRefMap = /* @__PURE__ */ new Map();
  previousFlatTree = null;
  snapshotCounter = 0;
  diffSeq = 0;
  lastSnapshotSentTime = 0;
  isInstalled2 = false;
  console.log("[FloTrace] Fiber tree walker uninstalled");
}

// src/storeUtils.ts
function serializeStoreState(state, logPrefix) {
  const serialized = {};
  for (const [key, value] of Object.entries(state)) {
    try {
      serialized[key] = serializeValue(value);
    } catch (error) {
      console.error(`[FloTrace] Error serializing ${logPrefix} key "${key}":`, error);
      serialized[key] = { __type: "error", value: "Serialization failed" };
    }
  }
  return serialized;
}

// src/zustandTracker.ts
var activeUnsubscribers = [];
var isInstalled3 = false;
var debounceTimers = /* @__PURE__ */ new Map();
var DEBOUNCE_MS = 200;
function installZustandTracker(stores, client4) {
  if (isInstalled3) {
    console.warn("[FloTrace] Zustand tracker already installed, reinstalling");
    uninstallZustandTracker();
  }
  isInstalled3 = true;
  console.log("[FloTrace] Installing Zustand tracker for stores:", Object.keys(stores));
  for (const [storeName, store] of Object.entries(stores)) {
    if (!store || typeof store !== "object" && typeof store !== "function" || typeof store.getState !== "function" || typeof store.subscribe !== "function") {
      console.warn(
        `[FloTrace] Skipping "${storeName}" \u2014 not a valid Zustand store (missing getState/subscribe). Ensure you pass Zustand stores like: stores={{ myStore: useMyStore }}`
      );
      continue;
    }
    try {
      const initialState = store.getState();
      sendStoreUpdate(storeName, initialState, Object.keys(initialState), client4);
      const unsubscribe = store.subscribe((newState, prevState) => {
        try {
          scheduleStoreUpdate(storeName, prevState, newState, client4);
        } catch (error) {
          console.error(`[FloTrace] Error in Zustand subscribe callback for "${storeName}":`, error);
        }
      });
      activeUnsubscribers.push(unsubscribe);
    } catch (error) {
      console.error(`[FloTrace] Failed to install tracker for Zustand store "${storeName}":`, error);
    }
  }
}
function uninstallZustandTracker() {
  if (!isInstalled3) return;
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  for (const unsubscribe of activeUnsubscribers) {
    try {
      unsubscribe();
    } catch (error) {
      console.error("[FloTrace] Error unsubscribing from Zustand store:", error);
    }
  }
  activeUnsubscribers = [];
  isInstalled3 = false;
  console.log("[FloTrace] Zustand tracker uninstalled");
}
function scheduleStoreUpdate(storeName, prevState, newState, client4) {
  let changedKeys;
  try {
    changedKeys = getChangedKeys(prevState, newState);
  } catch (error) {
    console.error(`[FloTrace] Error diffing Zustand state for "${storeName}":`, error);
    return;
  }
  if (changedKeys.length === 0) return;
  const existing = debounceTimers.get(storeName);
  if (existing) clearTimeout(existing);
  debounceTimers.set(storeName, setTimeout(() => {
    debounceTimers.delete(storeName);
    sendStoreUpdate(storeName, newState, changedKeys, client4);
  }, DEBOUNCE_MS));
}
function sendStoreUpdate(storeName, state, changedKeys, client4) {
  try {
    if (!client4.connected) return;
    client4.sendImmediate({
      type: "runtime:zustand",
      storeName,
      state: serializeStoreState(state, `Zustand "${storeName}"`),
      changedKeys,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error(`[FloTrace] Error sending Zustand update for "${storeName}":`, error);
  }
}

// src/reduxTracker.ts
var activeUnsubscribe = null;
var isInstalled4 = false;
var debounceTimer2 = null;
var previousState = null;
var DEBOUNCE_MS2 = 200;
function isReduxStore(obj) {
  return typeof obj === "object" && obj !== null && typeof obj.getState === "function" && typeof obj.subscribe === "function" && typeof obj.dispatch === "function";
}
function installReduxTracker(store, client4) {
  if (isInstalled4) {
    console.warn("[FloTrace] Redux tracker already installed, reinstalling");
    uninstallReduxTracker();
  }
  isInstalled4 = true;
  console.log("[FloTrace] Installing Redux tracker");
  try {
    const initialState = store.getState();
    previousState = initialState;
    sendReduxUpdate(initialState, Object.keys(initialState), client4);
    activeUnsubscribe = store.subscribe(() => {
      try {
        const newState = store.getState();
        scheduleReduxUpdate(newState, client4);
      } catch (error) {
        console.error("[FloTrace] Error in Redux subscribe callback:", error);
      }
    });
  } catch (error) {
    console.error("[FloTrace] Failed to install Redux tracker:", error);
    isInstalled4 = false;
  }
}
function uninstallReduxTracker() {
  if (!isInstalled4) return;
  if (debounceTimer2) {
    clearTimeout(debounceTimer2);
    debounceTimer2 = null;
  }
  if (activeUnsubscribe) {
    try {
      activeUnsubscribe();
    } catch (error) {
      console.error("[FloTrace] Error unsubscribing from Redux store:", error);
    }
    activeUnsubscribe = null;
  }
  previousState = null;
  isInstalled4 = false;
  console.log("[FloTrace] Redux tracker uninstalled");
}
function scheduleReduxUpdate(newState, client4) {
  let changedKeys;
  try {
    changedKeys = getChangedKeys(previousState ?? {}, newState);
  } catch (error) {
    console.error("[FloTrace] Error diffing Redux state:", error);
    return;
  }
  if (changedKeys.length === 0) return;
  previousState = newState;
  if (debounceTimer2) clearTimeout(debounceTimer2);
  debounceTimer2 = setTimeout(() => {
    debounceTimer2 = null;
    sendReduxUpdate(newState, changedKeys, client4);
  }, DEBOUNCE_MS2);
}
function sendReduxUpdate(state, changedKeys, client4) {
  try {
    if (!client4.connected) return;
    client4.sendImmediate({
      type: "runtime:redux",
      state: serializeStoreState(state, "Redux"),
      changedKeys,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error("[FloTrace] Error sending Redux update:", error);
  }
}

// src/tanstackQueryTracker.ts
var isInstalled5 = false;
var queryUnsubscribe = null;
var mutationUnsubscribe = null;
var debounceTimer3 = null;
var DEBOUNCE_MS3 = 300;
var MAX_EVENTS_PER_QUERY = 50;
var queryTracking = /* @__PURE__ */ new Map();
var CORRELATION_WINDOW_MS = 500;
var MAX_COMPLETED_CORRELATIONS = 20;
var correlationCounter = 0;
var pendingCorrelations = /* @__PURE__ */ new Map();
var completedCorrelations = [];
var mutationPrevStatus = /* @__PURE__ */ new Map();
var mutationCorrelationMap = /* @__PURE__ */ new Map();
function isTanStackQueryClient(obj) {
  if (!obj || typeof obj !== "object") return false;
  const candidate = obj;
  return typeof candidate.getQueryCache === "function" && typeof candidate.getMutationCache === "function";
}
function installTanStackQueryTracker(queryClient, client4) {
  if (isInstalled5) {
    console.warn("[FloTrace] TanStack Query tracker already installed, reinstalling");
    uninstallTanStackQueryTracker();
  }
  isInstalled5 = true;
  console.log("[FloTrace] Installing TanStack Query tracker");
  try {
    const queryCache = queryClient.getQueryCache();
    const mutationCache = queryClient.getMutationCache();
    for (const query of queryCache.getAll()) {
      if (!queryTracking.has(query.queryHash)) {
        initQueryTracking(query);
      }
    }
    for (const mutation of mutationCache.getAll()) {
      mutationPrevStatus.set(mutation.mutationId, mutation.state.status);
    }
    sendSnapshot(queryCache, mutationCache, client4);
    queryUnsubscribe = queryCache.subscribe((event) => {
      try {
        if (event.type === "added" || event.type === "removed" || event.type === "updated") {
          if (event.query) {
            updateQueryTracking(event.query, event.type);
          }
          scheduleSnapshot(queryCache, mutationCache, client4);
        }
      } catch (error) {
        console.error("[FloTrace] Error in TanStack Query cache subscribe callback:", error);
      }
    });
    mutationUnsubscribe = mutationCache.subscribe((event) => {
      try {
        if (event.mutation) {
          updateMutationTracking(event.mutation, queryCache, mutationCache, client4);
        }
        scheduleSnapshot(queryCache, mutationCache, client4);
      } catch (error) {
        console.error("[FloTrace] Error in TanStack Mutation cache subscribe callback:", error);
      }
    });
  } catch (error) {
    console.error("[FloTrace] Failed to install TanStack Query tracker:", error);
    isInstalled5 = false;
  }
}
function uninstallTanStackQueryTracker() {
  if (!isInstalled5) return;
  if (debounceTimer3) {
    clearTimeout(debounceTimer3);
    debounceTimer3 = null;
  }
  if (queryUnsubscribe) {
    try {
      queryUnsubscribe();
    } catch (e) {
      console.error("[FloTrace] Error unsubscribing from QueryCache:", e);
    }
    queryUnsubscribe = null;
  }
  if (mutationUnsubscribe) {
    try {
      mutationUnsubscribe();
    } catch (e) {
      console.error("[FloTrace] Error unsubscribing from MutationCache:", e);
    }
    mutationUnsubscribe = null;
  }
  for (const pending of pendingCorrelations.values()) {
    clearTimeout(pending.timeoutId);
  }
  pendingCorrelations.clear();
  isInstalled5 = false;
  console.log("[FloTrace] TanStack Query tracker uninstalled");
}
function computeDataHash(data) {
  if (data === null || data === void 0) return "__null__";
  try {
    return JSON.stringify(data);
  } catch {
    return "__unhashable__";
  }
}
function initQueryTracking(query) {
  const state = {
    lastDataHash: computeDataHash(query.state.data),
    lastDataUpdatedAt: query.state.dataUpdatedAt,
    prevStatus: query.state.status,
    prevFetchStatus: query.state.fetchStatus,
    totalFetchCount: 0,
    wastedRefetchCount: 0,
    events: []
  };
  queryTracking.set(query.queryHash, state);
  return state;
}
function updateQueryTracking(query, eventType) {
  let tracking = queryTracking.get(query.queryHash);
  if (eventType === "removed") {
    queryTracking.delete(query.queryHash);
    return;
  }
  if (!tracking) {
    tracking = initQueryTracking(query);
  }
  const currentStatus = query.state.status;
  const currentFetchStatus = query.state.fetchStatus;
  const statusChanged = tracking.prevStatus !== currentStatus;
  const fetchStatusChanged = tracking.prevFetchStatus !== currentFetchStatus;
  if (statusChanged || fetchStatusChanged) {
    const currentDataHash = computeDataHash(query.state.data);
    const dataChanged = currentDataHash !== tracking.lastDataHash;
    const event = {
      timestamp: Date.now(),
      fromStatus: tracking.prevStatus,
      toStatus: currentStatus,
      fromFetchStatus: tracking.prevFetchStatus,
      toFetchStatus: currentFetchStatus,
      dataChanged
    };
    tracking.events.push(event);
    if (tracking.events.length > MAX_EVENTS_PER_QUERY) {
      tracking.events.shift();
    }
    if (tracking.prevFetchStatus === "fetching" && currentFetchStatus === "idle" && currentStatus === "success") {
      tracking.totalFetchCount++;
      if (!dataChanged) {
        tracking.wastedRefetchCount++;
      }
      tracking.lastDataHash = currentDataHash;
      tracking.lastDataUpdatedAt = query.state.dataUpdatedAt;
    }
    if (tracking.prevFetchStatus === "idle" && currentFetchStatus === "fetching") {
      const now = Date.now();
      for (const pending of pendingCorrelations.values()) {
        if (pending.idleQueryHashes.has(query.queryHash)) {
          pending.affectedQueries.set(query.queryHash, {
            fetchStartedAt: now,
            queryKey: query.queryKey
          });
        }
      }
    }
    tracking.prevStatus = currentStatus;
    tracking.prevFetchStatus = currentFetchStatus;
  }
}
function openCorrelationWindow(mutation, queryCache, mutationCache, client4) {
  const correlationId = `corr-${++correlationCounter}`;
  const now = Date.now();
  const idleQueryHashes = /* @__PURE__ */ new Set();
  for (const query of queryCache.getAll()) {
    if (query.state.fetchStatus === "idle") {
      idleQueryHashes.add(query.queryHash);
    }
  }
  const timeoutId = setTimeout(() => {
    resolveCorrelation(correlationId, queryCache, mutationCache, client4);
  }, CORRELATION_WINDOW_MS);
  pendingCorrelations.set(correlationId, {
    correlationId,
    mutationId: mutation.mutationId,
    mutationKey: mutation.options.mutationKey,
    completedAt: now,
    idleQueryHashes,
    affectedQueries: /* @__PURE__ */ new Map(),
    timeoutId
  });
  mutationCorrelationMap.set(mutation.mutationId, correlationId);
}
function resolveCorrelation(correlationId, queryCache, mutationCache, client4) {
  const pending = pendingCorrelations.get(correlationId);
  if (!pending) return;
  pendingCorrelations.delete(correlationId);
  if (pending.affectedQueries.size === 0) return;
  const affectedQueries = [];
  for (const [queryHash, info] of pending.affectedQueries) {
    const tracking = queryTracking.get(queryHash);
    let queryKeySerialized;
    try {
      queryKeySerialized = serializeValue(info.queryKey);
    } catch {
      queryKeySerialized = "[serialization failed]";
    }
    affectedQueries.push({
      queryHash,
      queryKey: queryKeySerialized,
      fetchStartedAt: info.fetchStartedAt,
      latencyMs: info.fetchStartedAt - pending.completedAt,
      // dataChanged is resolved from the latest tracking state if the fetch completed
      dataChanged: tracking?.events.length ? tracking.events[tracking.events.length - 1].dataChanged : void 0
    });
  }
  let mutationKeySerialized;
  if (pending.mutationKey) {
    try {
      mutationKeySerialized = serializeValue(pending.mutationKey);
    } catch {
      mutationKeySerialized = "[serialization failed]";
    }
  }
  const correlation = {
    correlationId,
    mutationId: pending.mutationId,
    mutationKey: mutationKeySerialized,
    mutationCompletedAt: pending.completedAt,
    affectedQueries,
    resolvedAt: Date.now()
  };
  completedCorrelations.push(correlation);
  if (completedCorrelations.length > MAX_COMPLETED_CORRELATIONS) {
    completedCorrelations = completedCorrelations.slice(-MAX_COMPLETED_CORRELATIONS);
  }
  scheduleSnapshot(queryCache, mutationCache, client4);
}
function updateMutationTracking(mutation, queryCache, mutationCache, client4) {
  const currentStatus = mutation.state.status;
  const prevStatus = mutationPrevStatus.get(mutation.mutationId);
  mutationPrevStatus.set(mutation.mutationId, currentStatus);
  if (prevStatus && prevStatus !== "success" && currentStatus === "success") {
    openCorrelationWindow(mutation, queryCache, mutationCache, client4);
  }
}
function scheduleSnapshot(queryCache, mutationCache, client4) {
  if (debounceTimer3) clearTimeout(debounceTimer3);
  debounceTimer3 = setTimeout(() => {
    debounceTimer3 = null;
    sendSnapshot(queryCache, mutationCache, client4);
  }, DEBOUNCE_MS3);
}
function serializeQueryData(data) {
  if (data === null || data === void 0) return null;
  try {
    return serializeValue(data);
  } catch {
    return { __type: "truncated", originalType: typeof data };
  }
}
function extractErrorMessage(error) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown error";
  }
}
function serializeQuery(query) {
  let queryKeySerialized;
  try {
    queryKeySerialized = serializeValue(query.queryKey);
  } catch {
    queryKeySerialized = "[serialization failed]";
  }
  const errorMessage = query.state.error ? extractErrorMessage(query.state.error) : void 0;
  const tracking = queryTracking.get(query.queryHash);
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
    // Phase 1: additional config for health analysis
    refetchInterval: query.options.refetchInterval,
    refetchOnWindowFocus: query.options.refetchOnWindowFocus,
    refetchOnMount: query.options.refetchOnMount,
    refetchOnReconnect: query.options.refetchOnReconnect,
    networkMode: query.options.networkMode,
    enabled: query.options.enabled,
    retry: query.options.retry,
    dataShape: serializeQueryData(query.state.data),
    // Phase 2: wasted refetch tracking
    wastedRefetchCount: tracking?.wastedRefetchCount,
    totalFetchCount: tracking?.totalFetchCount,
    // Phase 3: query timeline
    events: tracking?.events.length ? [...tracking.events] : void 0
  };
}
function serializeMutation(mutation) {
  const errorMessage = mutation.state.error ? extractErrorMessage(mutation.state.error) : void 0;
  let mutationKey;
  if (mutation.options.mutationKey) {
    try {
      mutationKey = serializeValue(mutation.options.mutationKey);
    } catch {
      mutationKey = "[serialization failed]";
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
    lastCorrelationId: mutationCorrelationMap.get(mutation.mutationId)
  };
}
function sendSnapshot(queryCache, mutationCache, client4) {
  try {
    if (!client4.connected) return;
    const queries = [];
    for (const query of queryCache.getAll()) {
      try {
        queries.push(serializeQuery(query));
      } catch (error) {
        console.error(`[FloTrace] Error serializing query "${query.queryHash}":`, error);
      }
    }
    const mutations = [];
    const activeMutationIds = /* @__PURE__ */ new Set();
    for (const mutation of mutationCache.getAll()) {
      try {
        activeMutationIds.add(mutation.mutationId);
        mutations.push(serializeMutation(mutation));
      } catch (error) {
        console.error(`[FloTrace] Error serializing mutation ${mutation.mutationId}:`, error);
      }
    }
    for (const id of mutationPrevStatus.keys()) {
      if (!activeMutationIds.has(id)) {
        mutationPrevStatus.delete(id);
        mutationCorrelationMap.delete(id);
      }
    }
    const correlations = completedCorrelations.length > 0 ? [...completedCorrelations] : void 0;
    if (correlations) {
      completedCorrelations = [];
    }
    client4.sendImmediate({
      type: "runtime:tanstackQuery",
      queries,
      mutations,
      correlations,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error("[FloTrace] Error sending TanStack Query snapshot:", error);
  }
}
function safeCall(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// src/routerTracker.ts
var isInstalled6 = false;
var debounceTimer4 = null;
var client2 = null;
var originalPushState = null;
var originalReplaceState = null;
var popstateHandler = null;
var DEBOUNCE_MS4 = 200;
function installRouterTracker(wsClient) {
  if (isInstalled6) {
    console.warn("[FloTrace] Router tracker already installed, reinstalling");
    uninstallRouterTracker();
  }
  if (typeof window === "undefined" || typeof history === "undefined") {
    console.warn("[FloTrace] Router tracker requires a browser environment");
    return;
  }
  console.log("[FloTrace] Installing router tracker");
  try {
    isInstalled6 = true;
    client2 = wsClient;
    originalPushState = history.pushState.bind(history);
    originalReplaceState = history.replaceState.bind(history);
    history.pushState = function(data, unused, url) {
      originalPushState(data, unused, url);
      try {
        scheduleRouterUpdate();
      } catch (error) {
        console.error("[FloTrace] Error in pushState handler:", error);
      }
    };
    history.replaceState = function(data, unused, url) {
      originalReplaceState(data, unused, url);
      try {
        scheduleRouterUpdate();
      } catch (error) {
        console.error("[FloTrace] Error in replaceState handler:", error);
      }
    };
    popstateHandler = () => {
      try {
        scheduleRouterUpdate();
      } catch (error) {
        console.error("[FloTrace] Error in popstate handler:", error);
      }
    };
    window.addEventListener("popstate", popstateHandler);
    sendRouterUpdate();
  } catch (error) {
    console.error("[FloTrace] Failed to install router tracker:", error);
    try {
      uninstallRouterTracker();
    } catch (_) {
    }
  }
}
function uninstallRouterTracker() {
  if (!isInstalled6) return;
  if (debounceTimer4) {
    clearTimeout(debounceTimer4);
    debounceTimer4 = null;
  }
  try {
    if (originalPushState) {
      history.pushState = originalPushState;
      originalPushState = null;
    }
  } catch (error) {
    console.error("[FloTrace] Error restoring pushState:", error);
  }
  try {
    if (originalReplaceState) {
      history.replaceState = originalReplaceState;
      originalReplaceState = null;
    }
  } catch (error) {
    console.error("[FloTrace] Error restoring replaceState:", error);
  }
  try {
    if (popstateHandler) {
      window.removeEventListener("popstate", popstateHandler);
      popstateHandler = null;
    }
  } catch (error) {
    console.error("[FloTrace] Error removing popstate listener:", error);
  }
  client2 = null;
  isInstalled6 = false;
  console.log("[FloTrace] Router tracker uninstalled");
}
function scheduleRouterUpdate() {
  if (debounceTimer4) clearTimeout(debounceTimer4);
  debounceTimer4 = setTimeout(() => {
    debounceTimer4 = null;
    sendRouterUpdate();
  }, DEBOUNCE_MS4);
}
function sendRouterUpdate() {
  try {
    if (!client2?.connected) return;
    const pathname = window.location.pathname;
    const searchParams = {};
    const urlSearchParams = new URLSearchParams(window.location.search);
    for (const [key, value] of urlSearchParams.entries()) {
      searchParams[key] = value;
    }
    client2.sendImmediate({
      type: "runtime:router",
      pathname,
      // Matched route params (e.g., :id) are not available from the History API.
      // Future enhancement: extract from React Router's fiber context.
      params: {},
      searchParams,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error("[FloTrace] Error sending router update:", error);
  }
}

// src/consoleTracker.ts
var METHODS = ["log", "warn", "error", "info", "debug"];
var MAX_BATCH_SIZE = 50;
var FLUSH_INTERVAL_MS2 = 500;
var MAX_ARGS_PER_ENTRY = 10;
var MAX_BUFFER_SIZE = 300;
var originals = /* @__PURE__ */ new Map();
var client3 = null;
var isInstalled7 = false;
var buffer = [];
var flushTimer2 = null;
function installConsoleTracker(wsClient) {
  if (isInstalled7) return;
  client3 = wsClient;
  isInstalled7 = true;
  for (const method of METHODS) {
    originals.set(method, console[method].bind(console));
    console[method] = (...args) => {
      originals.get(method)(...args);
      captureEntry(method, args);
    };
  }
  flushTimer2 = setInterval(flushBuffer, FLUSH_INTERVAL_MS2);
}
function uninstallConsoleTracker() {
  if (!isInstalled7) return;
  for (const [method, original] of originals) {
    console[method] = original;
  }
  originals.clear();
  if (flushTimer2) {
    clearInterval(flushTimer2);
    flushTimer2 = null;
  }
  flushBuffer();
  buffer = [];
  client3 = null;
  isInstalled7 = false;
}
function captureEntry(level, args) {
  if (args.length > 0 && typeof args[0] === "string" && args[0].startsWith("[FloTrace]")) {
    return;
  }
  const attribution = getCurrentFiberAttribution();
  const entry = {
    level,
    args: args.slice(0, MAX_ARGS_PER_ENTRY).map((a) => {
      try {
        return serializeValue(a, 0, /* @__PURE__ */ new WeakSet());
      } catch {
        return { __type: "truncated", originalType: typeof a };
      }
    }),
    timestamp: Date.now(),
    ...attribution
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer = buffer.slice(-MAX_BATCH_SIZE);
  }
  if (buffer.length >= MAX_BATCH_SIZE) {
    flushBuffer();
  }
}
function getCurrentFiberAttribution() {
  try {
    const internals = window.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
    const currentFiber = internals?.ReactCurrentOwner?.current;
    if (!currentFiber) return {};
    const componentName = getComponentNameFromFiber(currentFiber);
    const ancestorChain = buildAncestorChain(currentFiber);
    return {
      componentName: componentName || void 0,
      ancestorChain: ancestorChain.length > 0 ? ancestorChain : void 0
    };
  } catch {
    return {};
  }
}
function getComponentNameFromFiber(fiber) {
  const type = fiber.type;
  if (!type) return null;
  if (typeof type === "function") {
    return type.displayName || type.name || null;
  }
  if (typeof type === "object" && type !== null) {
    if (type.type) {
      return type.type.displayName || type.type.name || null;
    }
    if (type.render) {
      return type.render.displayName || type.render.name || null;
    }
    return type.displayName || type.name || null;
  }
  return null;
}
function buildAncestorChain(fiber) {
  const chain = [];
  let current = fiber;
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
function flushBuffer() {
  if (buffer.length === 0 || !client3?.connected) return;
  client3.send({
    type: "runtime:consoleCapture",
    entries: [...buffer],
    timestamp: Date.now()
  });
  buffer = [];
}

// src/FloTraceProvider.tsx
import { jsx } from "react/jsx-runtime";
var pendingCleanupTimer = null;
var FloTraceContext = createContext(null);
function useFloTrace() {
  return useContext(FloTraceContext);
}
function FloTraceProvider({ children, config = {}, stores, reduxStore, queryClient }) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const [connected, setConnected] = React.useState(false);
  const trackingOptionsRef = useRef({});
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
    if (pendingCleanupTimer) {
      clearTimeout(pendingCleanupTimer);
      pendingCleanupTimer = null;
    }
    const client4 = getWebSocketClient(mergedConfig);
    const unsubConnection = client4.onConnectionChange((isConnected) => {
      setConnected(isConnected);
    });
    const unsubMessage = client4.onMessage((message) => {
      try {
        switch (message.type) {
          case "ext:ping":
            client4.sendImmediate({ type: "runtime:ready", appName: mergedConfig.appName });
            break;
          case "ext:startTracking":
            trackingOptionsRef.current = message.options || {};
            if (message.options?.trackZustand && storesRef.current && Object.keys(storesRef.current).length > 0) {
              try {
                installZustandTracker(storesRef.current, client4);
              } catch (error) {
                console.error("[FloTrace] Failed to install Zustand tracker:", error);
              }
            }
            if (message.options?.trackRedux && reduxStoreRef.current) {
              try {
                installReduxTracker(reduxStoreRef.current, client4);
              } catch (error) {
                console.error("[FloTrace] Failed to install Redux tracker:", error);
              }
            }
            if (message.options?.trackTanstackQuery && queryClientRef.current) {
              try {
                installTanStackQueryTracker(queryClientRef.current, client4);
              } catch (error) {
                console.error("[FloTrace] Failed to install TanStack Query tracker:", error);
              }
            }
            if (message.options?.trackRouter) {
              try {
                installRouterTracker(client4);
              } catch (error) {
                console.error("[FloTrace] Failed to install Router tracker:", error);
              }
            }
            try {
              installTimelineTracker(client4);
            } catch (error) {
              console.error("[FloTrace] Failed to install Timeline tracker:", error);
            }
            console.log("[FloTrace] Tracking started with options:", message.options);
            break;
          case "ext:stopTracking":
            trackingOptionsRef.current = {};
            try {
              uninstallZustandTracker();
            } catch (e) {
              console.error("[FloTrace] Error uninstalling Zustand tracker:", e);
            }
            try {
              uninstallReduxTracker();
            } catch (e) {
              console.error("[FloTrace] Error uninstalling Redux tracker:", e);
            }
            try {
              uninstallTanStackQueryTracker();
            } catch (e) {
              console.error("[FloTrace] Error uninstalling TanStack Query tracker:", e);
            }
            try {
              uninstallRouterTracker();
            } catch (e) {
              console.error("[FloTrace] Error uninstalling Router tracker:", e);
            }
            try {
              uninstallTimelineTracker();
            } catch (e) {
              console.error("[FloTrace] Error uninstalling Timeline tracker:", e);
            }
            try {
              uninstallConsoleTracker();
            } catch (e) {
              console.error("[FloTrace] Error uninstalling Console tracker:", e);
            }
            console.log("[FloTrace] Tracking stopped");
            break;
          case "ext:startTreeTracking":
            installFiberTreeWalker();
            console.log("[FloTrace] Tree tracking started");
            break;
          case "ext:stopTreeTracking":
            uninstallFiberTreeWalker();
            console.log("[FloTrace] Tree tracking stopped");
            break;
          case "ext:requestNodeProps": {
            const nodeId = message.nodeId;
            if (nodeId) {
              const props = getNodeProps(nodeId);
              client4.sendImmediate({
                type: "runtime:nodeProps",
                nodeId,
                props: props || {},
                timestamp: Date.now()
              });
            }
            break;
          }
          case "ext:requestNodeHooks": {
            const hookNodeId = message.nodeId;
            if (hookNodeId) {
              const hooks = getNodeHooks(hookNodeId);
              client4.sendImmediate({
                type: "runtime:nodeHooks",
                nodeId: hookNodeId,
                hooks: hooks || [],
                timestamp: Date.now()
              });
            }
            break;
          }
          case "ext:requestNodeEffects": {
            const effectNodeId = message.nodeId;
            if (effectNodeId) {
              const effects = getNodeEffects(effectNodeId);
              client4.sendImmediate({
                type: "runtime:nodeEffects",
                nodeId: effectNodeId,
                effects: effects || [],
                timestamp: Date.now()
              });
            }
            break;
          }
          case "ext:requestDetailedRenderReason": {
            const reasonNodeId = message.nodeId;
            if (reasonNodeId) {
              const reason = getDetailedRenderReason(reasonNodeId);
              if (reason) {
                client4.sendImmediate({
                  type: "runtime:detailedRenderReason",
                  nodeId: reasonNodeId,
                  reason,
                  timestamp: Date.now()
                });
              }
            }
            break;
          }
          case "ext:requestFullSnapshot":
            requestFullSnapshot();
            console.log("[FloTrace] Full snapshot requested by extension");
            break;
          case "ext:requestTimeline": {
            const timelineNodeId = message.nodeId;
            if (timelineNodeId) {
              const events = getTimeline(timelineNodeId);
              const componentName = timelineNodeId.split("/").pop()?.replace(/-\d+$/, "") ?? "Unknown";
              for (const event of events) {
                client4.sendImmediate({
                  type: "runtime:timelineEvent",
                  nodeId: timelineNodeId,
                  componentName,
                  event
                });
              }
            }
            break;
          }
          case "ext:startConsoleCapture":
            try {
              installConsoleTracker(client4);
              console.log("[FloTrace] Console capture started");
            } catch (error) {
              console.error("[FloTrace] Failed to install Console tracker:", error);
            }
            break;
          case "ext:stopConsoleCapture":
            try {
              uninstallConsoleTracker();
              console.log("[FloTrace] Console capture stopped");
            } catch (error) {
              console.error("[FloTrace] Error stopping Console tracker:", error);
            }
            break;
          case "ext:requestState":
            break;
        }
      } catch (error) {
        console.error(`[FloTrace] Error handling message type "${message.type}":`, error);
      }
    });
    client4.connect();
    return () => {
      unsubConnection();
      unsubMessage();
      pendingCleanupTimer = setTimeout(() => {
        pendingCleanupTimer = null;
        try {
          uninstallFiberTreeWalker();
        } catch (e) {
          console.error("[FloTrace] Error during cleanup (fiberTreeWalker):", e);
        }
        try {
          uninstallZustandTracker();
        } catch (e) {
          console.error("[FloTrace] Error during cleanup (zustandTracker):", e);
        }
        try {
          uninstallReduxTracker();
        } catch (e) {
          console.error("[FloTrace] Error during cleanup (reduxTracker):", e);
        }
        try {
          uninstallTanStackQueryTracker();
        } catch (e) {
          console.error("[FloTrace] Error during cleanup (tanstackQueryTracker):", e);
        }
        try {
          uninstallRouterTracker();
        } catch (e) {
          console.error("[FloTrace] Error during cleanup (routerTracker):", e);
        }
        try {
          uninstallTimelineTracker();
        } catch (e) {
          console.error("[FloTrace] Error during cleanup (timelineTracker):", e);
        }
        try {
          uninstallConsoleTracker();
        } catch (e) {
          console.error("[FloTrace] Error during cleanup (consoleTracker):", e);
        }
        try {
          disposeWebSocketClient();
        } catch (e) {
          console.error("[FloTrace] Error during cleanup (websocketClient):", e);
        }
      }, 100);
    };
  }, [mergedConfig.enabled, mergedConfig.port, mergedConfig.appName]);
  const onRenderCallback = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
    try {
      if (!mergedConfig.enabled) {
        return;
      }
      const client4 = getWebSocketClient();
      if (!client4.connected) {
        return;
      }
      const normalizedPhase = phase === "nested-update" ? "update" : phase;
      client4.send({
        type: "runtime:render",
        componentName: id,
        phase: normalizedPhase,
        actualDuration,
        baseDuration,
        timestamp: commitTime
      });
      requestTreeSnapshot();
    } catch (error) {
      console.error("[FloTrace] Error in Profiler callback:", error);
    }
  };
  const contextValue = {
    connected,
    enabled: mergedConfig.enabled,
    config: mergedConfig
  };
  return /* @__PURE__ */ jsx(FloTraceContext.Provider, { value: contextValue, children: /* @__PURE__ */ jsx(Profiler, { id: "FloTrace-Root", onRender: onRenderCallback, children }) });
}
function withFloTrace(Component, displayName) {
  const name = displayName || Component.displayName || Component.name || "Unknown";
  const WrappedComponent = (props) => {
    const floTrace = useFloTrace();
    const onRender = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
      try {
        if (!floTrace?.enabled) {
          return;
        }
        const client4 = getWebSocketClient();
        if (!client4.connected) {
          return;
        }
        const normalizedPhase = phase === "nested-update" ? "update" : phase;
        client4.send({
          type: "runtime:render",
          componentName: id,
          phase: normalizedPhase,
          actualDuration,
          baseDuration,
          timestamp: commitTime
        });
        if (floTrace.config.includeProps) {
          client4.send({
            type: "runtime:props",
            componentName: id,
            props: serializeProps(props),
            timestamp: commitTime
          });
        }
      } catch (error) {
        console.error("[FloTrace] Error in withFloTrace render callback:", error);
      }
    };
    return /* @__PURE__ */ jsx(Profiler, { id: name, onRender, children: /* @__PURE__ */ jsx(Component, { ...props }) });
  };
  WrappedComponent.displayName = `FloTrace(${name})`;
  return WrappedComponent;
}
function useTrackProps(componentName, props) {
  const floTrace = useFloTrace();
  const prevPropsRef = useRef();
  useEffect(() => {
    try {
      if (!floTrace?.enabled || !floTrace.config.includeProps) {
        return;
      }
      const client4 = getWebSocketClient();
      if (!client4.connected) {
        return;
      }
      const changedKeys = getChangedKeys(prevPropsRef.current, props);
      if (changedKeys.length > 0) {
        client4.send({
          type: "runtime:props",
          componentName,
          props: serializeProps(props),
          changedKeys,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error("[FloTrace] Error in useTrackProps:", error);
    } finally {
      prevPropsRef.current = { ...props };
    }
  }, [componentName, props, floTrace?.enabled, floTrace?.config.includeProps]);
}
export {
  DEFAULT_CONFIG,
  FloTraceProvider,
  FloTraceWebSocketClient,
  disposeWebSocketClient,
  getDetailedRenderReason,
  getFiberRefMap,
  getNodeEffects,
  getNodeHooks,
  getTimeline,
  getWebSocketClient,
  inspectEffects,
  inspectHooks,
  installConsoleTracker,
  installFiberTreeWalker,
  installReduxTracker,
  installRouterTracker,
  installTanStackQueryTracker,
  installTimelineTracker,
  installZustandTracker,
  isReduxStore,
  isTanStackQueryClient,
  recordTimelineEvent,
  requestTreeSnapshot,
  serializeProps,
  serializeValue,
  uninstallConsoleTracker,
  uninstallFiberTreeWalker,
  uninstallReduxTracker,
  uninstallRouterTracker,
  uninstallTanStackQueryTracker,
  uninstallTimelineTracker,
  uninstallZustandTracker,
  useFloTrace,
  useTrackProps,
  withFloTrace
};
