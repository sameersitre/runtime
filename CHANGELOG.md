# @flotrace/runtime

## 0.2.0

### Breaking

- Internal modules (fiber walker, analyzers, trackers, serializer, WebSocket client) moved to `@flotrace/runtime-core`. `@flotrace/runtime` now re-exports them. If you imported from the full path like `@flotrace/runtime/dist/fiberTreeWalker`, switch to a named import from `@flotrace/runtime` or depend on `@flotrace/runtime-core` directly.
- `FloTraceProvider` refuses to attach in React Native environments (`navigator.product === 'ReactNative'`). Shared RN + web codebases should use `@flotrace/runtime-native`'s `FloTraceProviderNative` on the native side.

### Features

- Thinned down to the web-only surface: `FloTraceProvider`, fetch/XHR network tracker, History-API router tracker, RSC payload interceptor, Next.js detector. Everything else re-exports from `@flotrace/runtime-core`.
- New `authToken` config option for LAN connections to the desktop app (needed when the desktop is bound to `0.0.0.0`).
- Connection pill in the desktop app now reflects per-client `platform` / `appId` / `appVersion` metadata when supplied via config.

### Internal

- Depends on `@flotrace/runtime-core@0.1.x`.

---

## 0.1.x

Earlier releases. See git history.
