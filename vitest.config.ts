import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Workspace packages follow the "internal packages" pattern: they export their
 * TypeScript sources directly (see ARCHITECTURE.md). The aliases below let vitest
 * resolve those sources without a build step.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@dream\/core$/, replacement: r('packages/core/src/index.ts') },
      { find: /^@dream\/kernel$/, replacement: r('packages/kernel/src/index.ts') },
      { find: /^@dream\/policies$/, replacement: r('packages/policies/src/index.ts') },
      { find: /^@dream\/plugin-kit$/, replacement: r('packages/plugin-kit/src/index.ts') },
      { find: /^@dream\/store-sqlite$/, replacement: r('packages/store-sqlite/src/index.ts') },
      { find: /^@dream\/eval$/, replacement: r('packages/eval/src/index.ts') },
      { find: /^@dream\/plugin-scripted$/, replacement: r('packages/plugins/scripted/src/index.ts') },
    ],
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/plugins/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
    ],
    environment: 'node',
  },
});
