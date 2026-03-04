# @flotrace/runtime

Runtime package for [FloTrace](https://marketplace.visualstudio.com/items?itemName=flotrace.flotrace) — enables real-time React component tree visualization, render tracking, and state management monitoring directly in VS Code.

## Installation

```bash
npm install @flotrace/runtime
# or
yarn add @flotrace/runtime
# or
pnpm add @flotrace/runtime
```

**Peer dependencies:** React >= 16.9.0 (requires `<Profiler>` API)

## Quick Start

Wrap your app with `<FloTraceProvider>`:

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

Then open the FloTrace panel in VS Code — your component tree will appear automatically.

## Configuration

All config options are optional. Pass them via the `config` prop:

```tsx
<FloTraceProvider config={{ port: 3457, appName: 'My App' }}>
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | `3457` | WebSocket server port |
| `appName` | `string` | `'React App'` | App name displayed in FloTrace |
| `enabled` | `boolean` | `true` in dev | Enable/disable tracking |
| `autoReconnect` | `boolean` | `true` | Auto-reconnect on disconnect |
| `reconnectInterval` | `number` | `2000` | Reconnect interval (ms) |
| `trackAllRenders` | `boolean` | `true` | Track all component renders |
| `includeProps` | `boolean` | `true` | Include props in render events |
| `trackZustand` | `boolean` | `true` | Enable Zustand state tracking |
| `trackRedux` | `boolean` | `true` | Enable Redux state tracking |
| `trackRouter` | `boolean` | `true` | Enable URL navigation tracking |
| `trackContext` | `boolean` | `true` | Enable React Context tracking |

## Framework Setup

### Vite + React

```tsx
// src/main.tsx
import { FloTraceProvider } from '@flotrace/runtime';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <FloTraceProvider config={{ appName: 'My Vite App' }}>
    <App />
  </FloTraceProvider>
);
```

### Next.js (App Router)

```tsx
// app/providers.tsx
'use client';

import { FloTraceProvider } from '@flotrace/runtime';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <FloTraceProvider config={{ appName: 'My Next.js App' }}>
      {children}
    </FloTraceProvider>
  );
}

// app/layout.tsx
import { Providers } from './providers';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
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

### Create React App

```tsx
// src/index.tsx
import { FloTraceProvider } from '@flotrace/runtime';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <FloTraceProvider config={{ appName: 'My CRA App' }}>
    <App />
  </FloTraceProvider>
);
```

## State Management Integration

### Zustand

Pass Zustand stores via the `stores` prop. Keys become store names in FloTrace:

```tsx
import { FloTraceProvider } from '@flotrace/runtime';
import { useBearStore } from './store/bearStore';
import { useUserStore } from './store/userStore';

<FloTraceProvider
  stores={{ bearStore: useBearStore, userStore: useUserStore }}
  config={{ appName: 'My App' }}
>
  <App />
</FloTraceProvider>
```

### Redux

Pass your Redux store via the `reduxStore` prop:

```tsx
import { FloTraceProvider } from '@flotrace/runtime';
import { store } from './store';

<FloTraceProvider
  reduxStore={store}
  config={{ appName: 'My App' }}
>
  <App />
</FloTraceProvider>
```

### Combined (Zustand + Redux + Router)

```tsx
import { FloTraceProvider } from '@flotrace/runtime';
import { store } from './reduxStore';
import { useBearStore } from './zustandStore';

<FloTraceProvider
  config={{ appName: 'My App' }}
  stores={{ bearStore: useBearStore }}
  reduxStore={store}
>
  <App />
</FloTraceProvider>
```

Router tracking is automatic — no configuration needed. It works with any SPA router (React Router, TanStack Router, Next.js, etc.) by patching the browser's History API.

## Advanced Usage

### `withFloTrace()` — HOC for targeted profiling

Wrap specific components to track their renders and props individually:

```tsx
import { withFloTrace } from '@flotrace/runtime';

const ProfiledComponent = withFloTrace(MyComponent, 'MyComponent');
```

### `useTrackProps()` — Track prop changes

Call at the top of a component to track its prop changes:

```tsx
import { useTrackProps } from '@flotrace/runtime';

function MyComponent(props: MyProps) {
  useTrackProps('MyComponent', props);
  // ... rest of component
}
```

### `useFloTrace()` — Access runtime context

```tsx
import { useFloTrace } from '@flotrace/runtime';

function DebugInfo() {
  const floTrace = useFloTrace();
  return <div>Connected: {floTrace?.connected ? 'Yes' : 'No'}</div>;
}
```

## Production Safety

By default, FloTrace is **disabled in production** (`enabled` defaults to `process.env.NODE_ENV === 'development'`).

For explicit control, use a conditional import pattern:

```tsx
// src/main.tsx
const FloTraceProvider = process.env.NODE_ENV === 'development'
  ? (await import('@flotrace/runtime')).FloTraceProvider
  : ({ children }: { children: React.ReactNode }) => <>{children}</>;
```

## Troubleshooting

### "Not connected" in VS Code

1. Ensure the FloTrace extension is running in VS Code
2. Check the port matches (default: 3457)
3. Verify `config.enabled` is `true`
4. Check browser console for `[FloTrace]` logs

### Zustand stores not appearing

- Stores must be passed explicitly via the `stores` prop
- Each value must be a Zustand hook (function with `.getState()` and `.subscribe()` methods)
- Check console for `[FloTrace] Skipping "..." — not a valid Zustand store` warnings

### Component tree is missing or incomplete

- The fiber tree walker needs React DevTools hook or DOM-based fiber access
- React DevTools extension (or standalone) improves reliability
- Tree depth is capped at 100 levels, children at 300 per node
- Reload the page if the tree appears empty

### WebSocket keeps reconnecting

- FloTrace uses exponential backoff (2s → 4s → 8s... up to 30s) with a 10-attempt budget
- After 10 failed attempts, reload the page or restart the extension to retry
- Check that no firewall or proxy is blocking `ws://localhost:3457`

## API Reference

### Components

| Export | Description |
|--------|-------------|
| `FloTraceProvider` | Main provider — wraps your app, manages WebSocket connection |
| `withFloTrace(Component, name?)` | HOC for targeted component profiling |

### Hooks

| Export | Description |
|--------|-------------|
| `useFloTrace()` | Access connection state and config |
| `useTrackProps(name, props)` | Track prop changes for a component |

### Types

| Export | Description |
|--------|-------------|
| `FloTraceConfig` | Configuration options interface |
| `FloTraceProviderProps` | Props for FloTraceProvider |
| `SerializedValue` | Serialized value type for safe WebSocket transmission |
| `LiveTreeNode` | Node in the live component tree |
| `ReduxStoreApi` | Minimal Redux store interface |
| `TrackingOptions` | Tracking options from extension |
| `DEFAULT_CONFIG` | Default configuration values |

### Advanced Exports

| Export | Description |
|--------|-------------|
| `getWebSocketClient(config?)` | Get singleton WebSocket client |
| `disposeWebSocketClient()` | Dispose the WebSocket client |
| `installFiberTreeWalker()` | Manually install fiber tree walker |
| `uninstallFiberTreeWalker()` | Uninstall fiber tree walker |
| `requestTreeSnapshot()` | Request a tree snapshot (DOM fallback) |
| `serializeValue(value)` | Serialize a value for WebSocket |
| `serializeProps(props)` | Serialize props object |

## License

MIT
