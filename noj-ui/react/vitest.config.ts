import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' } },
  },
  test: { environment: 'node', include: ['react/**/*.spec.tsx'] },
});
