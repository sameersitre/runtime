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
  trackContext: true
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
    // 30s cap
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
      const url = `ws://localhost:${this.config.port}`;
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
    if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => {
        this.flush();
      }, this.config.reconnectInterval || 100);
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
var MAX_TREE_DEPTH = 100;
var MAX_CHILDREN_PER_NODE = 300;
var debounceTimer = null;
var DEBOUNCE_MS_SMALL = 200;
var DEBOUNCE_MS_MEDIUM = 500;
var DEBOUNCE_MS_LARGE = 1e3;
var currentDebounceMs = DEBOUNCE_MS_SMALL;
var isWalking = false;
var originalOnCommitFiberRoot = null;
var isInstalled = false;
var hookedRendererID = null;
var activeStrategy = null;
var fiberRefMap = /* @__PURE__ */ new Map();
function getComponentName(fiber) {
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
  const name = getComponentName(fiber);
  if (name === "Anonymous" || name === "Unknown" || name === "ForwardRef" || name === "Memo")
    return false;
  if (name.startsWith("@") || name.includes("/")) return false;
  if (fiber._debugSource?.fileName?.includes("node_modules")) return false;
  return true;
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
        const name = getComponentName(current);
        const nameCount = nameCountMap.get(name) || 0;
        nameCountMap.set(name, nameCount + 1);
        const nodeId = buildNodeId(name, nameCount, parentId);
        fiberRefMap.set(nodeId, current);
        const renderPhase = current.alternate ? "update" : "mount";
        const renderReason = detectRenderReason(current, renderPhase);
        const children = walkFiber(
          current.child,
          nodeId,
          void 0,
          depth + 1
        );
        const truncatedChildren = children.length > MAX_CHILDREN_PER_NODE ? children.slice(0, MAX_CHILDREN_PER_NODE) : children;
        nodes.push({
          id: nodeId,
          name,
          children: truncatedChildren,
          fiberTag: tag,
          renderPhase,
          renderReason,
          renderDuration: current.actualDuration,
          filePath: current._debugSource?.fileName,
          lineNumber: current._debugSource?.lineNumber
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
  fiberRefMap = /* @__PURE__ */ new Map();
  const topLevelNodes = walkFiber(rootFiber.child, "");
  console.log(
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
      console.log(
        `[FloTrace] Trying selector "${selector}" \u2192 found element`,
        element.tagName,
        element.id
      );
      const reactKeys = Object.keys(element).filter(
        (k) => k.startsWith("__react") || k.startsWith("_react")
      );
      console.log(`[FloTrace] React keys on element:`, reactKeys);
      const fiberRoot = getFiberRootFromElement(element);
      if (fiberRoot) {
        console.log("[FloTrace] Found fiber root from selector:", selector);
        return fiberRoot;
      }
    }
    const allBodyChildren = document.body?.children;
    if (allBodyChildren) {
      console.log(
        "[FloTrace] Scanning all",
        allBodyChildren.length,
        "body children for React root..."
      );
      for (const child of Array.from(allBodyChildren)) {
        const reactKeys = Object.keys(child).filter(
          (k) => k.startsWith("__react") || k.startsWith("_react")
        );
        if (reactKeys.length > 0) {
          console.log(
            "[FloTrace] React keys on",
            child.tagName,
            child.id || "(no id)",
            ":",
            reactKeys
          );
        }
        const fiberRoot = getFiberRootFromElement(child);
        if (fiberRoot) {
          console.log(
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
      const nodeCount = fiberRefMap.size;
      if (nodeCount >= 200) {
        currentDebounceMs = DEBOUNCE_MS_LARGE;
      } else if (nodeCount >= 50) {
        currentDebounceMs = DEBOUNCE_MS_MEDIUM;
      } else {
        currentDebounceMs = DEBOUNCE_MS_SMALL;
      }
      const client2 = getWebSocketClient();
      if (!client2.connected) {
        console.warn(
          "[FloTrace] WebSocket not connected, cannot send tree snapshot"
        );
        return;
      }
      const currentFlatTree = flattenTree(tree);
      const sendFull = previousFlatTree === null || snapshotCounter % FULL_SNAPSHOT_INTERVAL === 0;
      if (sendFull) {
        console.log(
          "[FloTrace] Sending FULL tree snapshot, root:",
          tree.name,
          "nodes:",
          nodeCount,
          "seq:",
          snapshotCounter,
          "nextDebounce:",
          currentDebounceMs + "ms"
        );
        client2.sendImmediate({
          type: "runtime:treeSnapshot",
          tree,
          timestamp: Date.now()
        });
        diffSeq = 0;
      } else {
        const diff = computeTreeDiff(previousFlatTree, currentFlatTree);
        if (diff) {
          console.log(
            "[FloTrace] Sending tree diff, seq:",
            diffSeq,
            "added:",
            diff.added.length,
            "removed:",
            diff.removed.length,
            "updated:",
            diff.updated.length
          );
          client2.sendImmediate({
            type: "runtime:treeDiff",
            seq: diffSeq,
            added: diff.added,
            removed: diff.removed,
            updated: diff.updated,
            timestamp: Date.now()
          });
          diffSeq++;
        } else {
          console.log("[FloTrace] Tree unchanged, skipping diff");
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
  if (!isInstalled) {
    return;
  }
  if (activeStrategy === "devtools") return;
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
  if (isInstalled) {
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
  isInstalled = true;
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
function uninstallFiberTreeWalker() {
  if (!isInstalled) return;
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
  isInstalled = false;
  console.log("[FloTrace] Fiber tree walker uninstalled");
}

// src/zustandTracker.ts
var activeUnsubscribers = [];
var isInstalled2 = false;
var debounceTimers = /* @__PURE__ */ new Map();
var DEBOUNCE_MS = 200;
function installZustandTracker(stores, client2) {
  if (isInstalled2) {
    console.warn("[FloTrace] Zustand tracker already installed, reinstalling");
    uninstallZustandTracker();
  }
  isInstalled2 = true;
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
      sendStoreUpdate(storeName, initialState, Object.keys(initialState), client2);
      const unsubscribe = store.subscribe((newState, prevState) => {
        try {
          scheduleStoreUpdate(storeName, prevState, newState, client2);
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
  if (!isInstalled2) return;
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
  isInstalled2 = false;
  console.log("[FloTrace] Zustand tracker uninstalled");
}
function scheduleStoreUpdate(storeName, prevState, newState, client2) {
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
    sendStoreUpdate(storeName, newState, changedKeys, client2);
  }, DEBOUNCE_MS));
}
function sendStoreUpdate(storeName, state, changedKeys, client2) {
  try {
    if (!client2.connected) return;
    const serializedState = {};
    for (const [key, value] of Object.entries(state)) {
      try {
        serializedState[key] = serializeValue(value);
      } catch (error) {
        console.error(`[FloTrace] Error serializing Zustand key "${storeName}.${key}":`, error);
        serializedState[key] = { __type: "error", value: "Serialization failed" };
      }
    }
    client2.sendImmediate({
      type: "runtime:zustand",
      storeName,
      state: serializedState,
      changedKeys,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error(`[FloTrace] Error sending Zustand update for "${storeName}":`, error);
  }
}

// src/reduxTracker.ts
var activeUnsubscribe = null;
var isInstalled3 = false;
var debounceTimer2 = null;
var previousState = null;
var DEBOUNCE_MS2 = 200;
function isReduxStore(obj) {
  return typeof obj === "object" && obj !== null && typeof obj.getState === "function" && typeof obj.subscribe === "function" && typeof obj.dispatch === "function";
}
function installReduxTracker(store, client2) {
  if (isInstalled3) {
    console.warn("[FloTrace] Redux tracker already installed, reinstalling");
    uninstallReduxTracker();
  }
  isInstalled3 = true;
  console.log("[FloTrace] Installing Redux tracker");
  try {
    const initialState = store.getState();
    previousState = initialState;
    sendReduxUpdate(initialState, Object.keys(initialState), client2);
    activeUnsubscribe = store.subscribe(() => {
      try {
        const newState = store.getState();
        scheduleReduxUpdate(newState, client2);
      } catch (error) {
        console.error("[FloTrace] Error in Redux subscribe callback:", error);
      }
    });
  } catch (error) {
    console.error("[FloTrace] Failed to install Redux tracker:", error);
    isInstalled3 = false;
  }
}
function uninstallReduxTracker() {
  if (!isInstalled3) return;
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
  isInstalled3 = false;
  console.log("[FloTrace] Redux tracker uninstalled");
}
function scheduleReduxUpdate(newState, client2) {
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
    sendReduxUpdate(newState, changedKeys, client2);
  }, DEBOUNCE_MS2);
}
function sendReduxUpdate(state, changedKeys, client2) {
  try {
    if (!client2.connected) return;
    const serializedState = {};
    for (const [key, value] of Object.entries(state)) {
      try {
        serializedState[key] = serializeValue(value);
      } catch (error) {
        console.error(`[FloTrace] Error serializing Redux key "${key}":`, error);
        serializedState[key] = { __type: "error", value: "Serialization failed" };
      }
    }
    client2.sendImmediate({
      type: "runtime:redux",
      state: serializedState,
      changedKeys,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error("[FloTrace] Error sending Redux update:", error);
  }
}

// src/routerTracker.ts
var isInstalled4 = false;
var debounceTimer3 = null;
var client = null;
var originalPushState = null;
var originalReplaceState = null;
var popstateHandler = null;
var DEBOUNCE_MS3 = 200;
function installRouterTracker(wsClient) {
  if (isInstalled4) {
    console.warn("[FloTrace] Router tracker already installed, reinstalling");
    uninstallRouterTracker();
  }
  if (typeof window === "undefined" || typeof history === "undefined") {
    console.warn("[FloTrace] Router tracker requires a browser environment");
    return;
  }
  console.log("[FloTrace] Installing router tracker");
  try {
    isInstalled4 = true;
    client = wsClient;
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
  if (!isInstalled4) return;
  if (debounceTimer3) {
    clearTimeout(debounceTimer3);
    debounceTimer3 = null;
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
  client = null;
  isInstalled4 = false;
  console.log("[FloTrace] Router tracker uninstalled");
}
function scheduleRouterUpdate() {
  if (debounceTimer3) clearTimeout(debounceTimer3);
  debounceTimer3 = setTimeout(() => {
    debounceTimer3 = null;
    sendRouterUpdate();
  }, DEBOUNCE_MS3);
}
function sendRouterUpdate() {
  try {
    if (!client?.connected) return;
    const pathname = window.location.pathname;
    const searchParams = {};
    const urlSearchParams = new URLSearchParams(window.location.search);
    for (const [key, value] of urlSearchParams.entries()) {
      searchParams[key] = value;
    }
    client.sendImmediate({
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

// src/FloTraceProvider.tsx
import { jsx } from "react/jsx-runtime";
var pendingCleanupTimer = null;
var FloTraceContext = createContext(null);
function useFloTrace() {
  return useContext(FloTraceContext);
}
function FloTraceProvider({ children, config = {}, stores, reduxStore }) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const [connected, setConnected] = React.useState(false);
  const trackingOptionsRef = useRef({});
  const storesRef = useRef(stores);
  storesRef.current = stores;
  const reduxStoreRef = useRef(reduxStore);
  reduxStoreRef.current = reduxStore;
  useEffect(() => {
    if (!mergedConfig.enabled) {
      return;
    }
    if (pendingCleanupTimer) {
      clearTimeout(pendingCleanupTimer);
      pendingCleanupTimer = null;
    }
    const client2 = getWebSocketClient(mergedConfig);
    const unsubConnection = client2.onConnectionChange((isConnected) => {
      setConnected(isConnected);
    });
    const unsubMessage = client2.onMessage((message) => {
      try {
        switch (message.type) {
          case "ext:ping":
            client2.sendImmediate({ type: "runtime:ready", appName: mergedConfig.appName });
            break;
          case "ext:startTracking":
            trackingOptionsRef.current = message.options || {};
            if (message.options?.trackZustand && storesRef.current && Object.keys(storesRef.current).length > 0) {
              try {
                installZustandTracker(storesRef.current, client2);
              } catch (error) {
                console.error("[FloTrace] Failed to install Zustand tracker:", error);
              }
            }
            if (message.options?.trackRedux && reduxStoreRef.current) {
              try {
                installReduxTracker(reduxStoreRef.current, client2);
              } catch (error) {
                console.error("[FloTrace] Failed to install Redux tracker:", error);
              }
            }
            if (message.options?.trackRouter) {
              try {
                installRouterTracker(client2);
              } catch (error) {
                console.error("[FloTrace] Failed to install Router tracker:", error);
              }
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
              uninstallRouterTracker();
            } catch (e) {
              console.error("[FloTrace] Error uninstalling Router tracker:", e);
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
              client2.sendImmediate({
                type: "runtime:nodeProps",
                nodeId,
                props: props || {},
                timestamp: Date.now()
              });
            }
            break;
          }
          case "ext:requestFullSnapshot":
            requestFullSnapshot();
            console.log("[FloTrace] Full snapshot requested by extension");
            break;
          case "ext:requestState":
            break;
        }
      } catch (error) {
        console.error(`[FloTrace] Error handling message type "${message.type}":`, error);
      }
    });
    client2.connect();
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
          uninstallRouterTracker();
        } catch (e) {
          console.error("[FloTrace] Error during cleanup (routerTracker):", e);
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
      const client2 = getWebSocketClient();
      if (!client2.connected) {
        return;
      }
      const normalizedPhase = phase === "nested-update" ? "update" : phase;
      client2.send({
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
        const client2 = getWebSocketClient();
        if (!client2.connected) {
          return;
        }
        const normalizedPhase = phase === "nested-update" ? "update" : phase;
        client2.send({
          type: "runtime:render",
          componentName: id,
          phase: normalizedPhase,
          actualDuration,
          baseDuration,
          timestamp: commitTime
        });
        if (floTrace.config.includeProps) {
          client2.send({
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
      const client2 = getWebSocketClient();
      if (!client2.connected) {
        return;
      }
      const changedKeys = getChangedKeys(prevPropsRef.current, props);
      if (changedKeys.length > 0) {
        client2.send({
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
  getWebSocketClient,
  installFiberTreeWalker,
  installReduxTracker,
  installRouterTracker,
  installZustandTracker,
  isReduxStore,
  requestTreeSnapshot,
  serializeProps,
  serializeValue,
  uninstallFiberTreeWalker,
  uninstallReduxTracker,
  uninstallRouterTracker,
  uninstallZustandTracker,
  useFloTrace,
  useTrackProps,
  withFloTrace
};
