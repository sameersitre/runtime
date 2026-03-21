import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: false,
  clean: true,
  external: ['react', 'react-dom'],
  // Don't bundle React types - let the consumer provide them
  esbuildOptions(options) {
    options.external = ['react', 'react-dom', 'react/jsx-runtime'];
  },
});
