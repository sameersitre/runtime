# @flotrace/runtime

**Stop guessing why your React app re-renders.**

FloTrace is a desktop app that shows you, live, what your React tree is doing — every render, every prop change, every state mutation, every cascade — without leaving your editor and without uploading your source code anywhere.

This package is the runtime that wires your app into the desktop. Drop it in once and you get:

- **A live component tree graph** — not a flat fiber list. See parent/child structure as it changes in real time.
- **Render reasons that actually answer "why?"** — props/state/context diffs, render frequency coloring, render-cascade tracing across files.
- **All your state in one panel** — Zustand, Redux, TanStack Query, Context, Router. No four browser extensions, no console.log.
- **Hooks + effects, classified and diffed** — 14 hook types, effect dep diffing, "did this effect re-run because X changed."
- **Network → state correlation** — every fetch/XHR mapped to the store update it caused.
- **Copy-as-Prompt** — turn any panel into an AI-ready prompt for Cursor/Claude/ChatGPT in one click.

Source code never leaves your machine. The runtime sends only metadata over `ws://localhost:3457` to the desktop app.

> **Using React Native?** Install [`@flotrace/runtime-native`](https://www.npmjs.com/package/@flotrace/runtime-native) instead. This package patches `fetch`/`XMLHttpRequest` in ways that crash the RN bridge.

[**Download the desktop app →**](https://flotrace.dev/download) · [Docs](https://flotrace.dev/docs) · [Compare to React DevTools](https://flotrace.dev/compare/react-devtools)

---

## About FloTrace Desktop

[**FloTrace Desktop**](https://flotrace.dev) is a free Electron app (macOS / Windows / Linux) that visualizes your React app's component hierarchy in real time. This runtime package is the bridge: drop `<FloTraceProvider>` into your app and the desktop renders the live tree, with full inspection of props, hooks, effects, state, network calls, and render cascades.

When `@flotrace/runtime` (this package) is paired with the desktop, you get:

- **Live component tree** — React Flow graph, render-flash animation, frequency-based heatmap, breadcrumb bar, search-with-fitView.
- **Per-node inspection** — props (with diff history), hooks (14 classified types + dep diffs), effects (willRun + dep diffs), component timeline.
- **State tracking** — Zustand (per-store), Redux (with change highlighting), Router, TanStack Query (with health warnings + wasted-refetch detection), Context.
- **Render cascade tracing** — trigger log, cascade tree, flame chart, cascade compare modal.
- **Prop drilling detection** — chain detection (≥3 levels deep), severity badges, heatmap overlay, refactor recommendations.
- **Network health** — fetch / XHR tracking, method badges, status dots, duplicate detection, API → store causal correlation, pin-to-watch.
- **React 19 + Next.js** — Actions monitor, concurrent-update signals (useTransition / Suspense), compiler memo health, Next.js App Router detection, RSC payload interception.
- **Watch expressions** — pin values from 8 sources (Zustand / Redux / Router / Context / Props / Hooks / TanStack Query / API), max 20.
- **AI Code Review Dashboard** — 6-tab review (Re-renders, Memo, Drilling, Effects, Compiler, Network) with Lighthouse-style scores.
- **Copy-as-Prompt** — turn any panel into an AI-ready prompt for Cursor / Claude / ChatGPT in one click.

How it fits together:

```
your React app  ←→  @flotrace/runtime  ←→  ws://localhost:3457  ←→  FloTrace Desktop
                       (this package — open source, MIT)         (closed-source commercial)
```

The desktop is free and binds to `127.0.0.1` only by default — your source code, props, and state never leave your machine.

---

## 30-second setup

```bash
npm install -D @flotrace/runtime
```

```tsx
import { FloTraceProvider } from '@flotrace/runtime';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <FloTraceProvider config={{ appName: 'My App' }}>
    <App />
  </FloTraceProvider>
);
```

Launch the FloTrace desktop app. Reload your dev server. Done — your tree appears.

**Peer dependencies:** React >= 16.9.0 (uses `<Profiler>` API). Auto-disables in production via `process.env.NODE_ENV`.

---

## Framework recipes

### Next.js (App Router)

```tsx
// app/providers.tsx
'use client';
import { FloTraceProvider } from '@flotrace/runtime';

export function Providers({ children }: { children: React.ReactNode }) {
  return <FloTraceProvider config={{ appName: 'My Next.js App' }}>{children}</FloTraceProvider>;
}

// app/layout.tsx
import { Providers } from './providers';
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body><Providers>{children}</Providers></body></html>;
}
```

### Next.js (Pages Router)

```tsx
// pages/_app.tsx
import { FloTraceProvider } from '@flotrace/runtime';
import type { AppProps } from 'next/app';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <FloTraceProvider config={{ appName: 'My Next.js App' }}>
      <Component {...pageProps} />
    </FloTraceProvider>
  );
}
```

### Vite / Create React App

Same as the 30-second setup above — wrap `<App />` at the root.

---

## Wire up your state stores

State tracking is the killer feature. Pass your stores to the provider and they show up in the desktop's State panel with live diffs:

```tsx
import { FloTraceProvider } from '@flotrace/runtime';
import { useBearStore } from './zustandStore';
import { store as reduxStore } from './reduxStore';
import { queryClient } from './queryClient';

<FloTraceProvider
  config={{ appName: 'My App' }}
  stores={{ bearStore: useBearStore }}     // Zustand — keys become store names
  reduxStore={reduxStore}                   // Redux — pass your store directly
  queryClient={queryClient}                 // TanStack Query — pass your client
>
  <App />
</FloTraceProvider>
```

Router tracking is automatic — it patches the History API and works with React Router, TanStack Router, Next.js, etc.

---

## Configuration

All options optional. Sensible defaults for development.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `appName` | `string` | `'React App'` | Shown in the FloTrace connection pill |
| `port` | `number` | `3457` | WebSocket server port |
| `enabled` | `boolean` | dev only | `false` to hard-disable |
| `autoReconnect` | `boolean` | `true` | Reconnect on disconnect |
| `reconnectInterval` | `number` | `2000` | Base reconnect delay (ms, exponential backoff) |
| `trackAllRenders` | `boolean` | `true` | Track every commit via `<Profiler>` |
| `includeProps` | `boolean` | `true` | Include prop values in render events |
| `trackZustand` / `trackRedux` / `trackRouter` / `trackContext` / `trackTanstackQuery` | `boolean` | `true` | Per-tracker toggles |

---

## Production safety

FloTrace is **disabled in production** by default (`enabled` defaults to `process.env.NODE_ENV === 'development'`). For belt-and-braces tree-shaking, dynamic-import in dev only:

```tsx
const FloTraceProvider = process.env.NODE_ENV === 'development'
  ? (await import('@flotrace/runtime')).FloTraceProvider
  : ({ children }: { children: React.ReactNode }) => <>{children}</>;
```

---

## Targeted profiling

For one-off component tracking without the full provider:

```tsx
import { withFloTrace, useTrackProps } from '@flotrace/runtime';

const Profiled = withFloTrace(MyComponent, 'MyComponent');

function MyComponent(props: MyProps) {
  useTrackProps('MyComponent', props);
  // ...
}
```

---

## Privacy & security

- Source code never leaves your machine. The runtime sends only metadata (component names, prop types, render counts) over `ws://localhost:3457`.
- Desktop app binds to `127.0.0.1` only. LAN connections (physical devices) require an opt-in auth token.
- The desktop is closed-source commercial; this runtime package is **MIT-licensed** and open at [github.com/sameersitre/runtime](https://github.com/sameersitre/runtime).

---

## Troubleshooting

**"Not connected"** — Is the desktop app running? Is `enabled: true`? Check browser console for `[FloTrace]` logs.

**Zustand stores missing** — Stores must be passed via the `stores` prop, and each value must be a Zustand hook (has `.getState()` and `.subscribe()`).

**Tree empty or partial** — Reload the page. The walker uses React DevTools hook or DOM-based fiber access; depth is capped at 100, children at 300/node.

**WebSocket reconnecting** — Exponential backoff (2s → 30s, 10 attempts). After that, reload the page or restart the desktop.

---

## API reference

See [flotrace.dev/docs/runtime](https://flotrace.dev/docs/runtime) for the full export surface (40+ hooks, trackers, and types). Quick index:

| Export | Description |
|---|---|
| `FloTraceProvider` | Main provider component |
| `withFloTrace(Component, name?)` | HOC for targeted profiling |
| `useFloTrace()` | Connection state + config |
| `useTrackProps(name, props)` | Track prop changes |
| `installXxxTracker()` / `uninstallXxxTracker()` | Manual tracker control (Zustand, Redux, Router, TanStack Query, Network, Timeline) |
| `getNodeHooks(nodeId)` / `getNodeEffects(nodeId)` / `getDetailedRenderReason(nodeId)` | Inspector accessors |

Type exports: `FloTraceConfig`, `LiveTreeNode`, `SerializedValue`, `HookInfo`, `EffectInfo`, `TimelineEvent`, `NetworkRequestEntry`, `Fiber`, etc.

---

## License

MIT — see [LICENSE](./LICENSE). Issues and PRs welcome at [github.com/sameersitre/runtime](https://github.com/sameersitre/runtime).

---

> **Mirrored from the [flotrace-desktop](https://github.com/sameersitre/flotrace-desktop) monorepo.** This repo is read-only — every release is regenerated by the lockstep publisher in the desktop monorepo. Issues filed here are tracked, but PRs are best opened against the upstream monorepo where the canonical source lives.
