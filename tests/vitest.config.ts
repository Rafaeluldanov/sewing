import { defineConfig } from 'vitest/config';
import path from 'node:path';
import swc from 'unplugin-swc';
import fs from 'node:fs';

/**
 * Vitest config для MVP 1.1.
 *
 * Принципы:
 *   - один пакет `@sewing/tests` хранит smoke и integration сценарии;
 *   - тесты импортируют `AppModule` напрямую из `apps/api/src` и
 *     поднимают NestJS через `@nestjs/testing`;
 *   - SWC-плагин нужен, чтобы корректно эмитить decorator metadata
 *     (esbuild это делает не везде → DI Nest падает);
 *   - кастомный мини-плагин `resolveJsAsTs` мапит NodeNext-импорты
 *     `./foo.js` → `./foo.ts` для исходников `apps/api/src` и
 *     `packages/shared/src` (там tsconfig.module = NodeNext);
 *   - integration-тесты автоматически skip-аются, если не задан
 *     `TEST_DATABASE_URL` (см. `tests/utils/db.ts`).
 */
const apiSrc = path.resolve(__dirname, '../apps/api/src');
const sharedSrc = path.resolve(__dirname, '../packages/shared/src');

const resolveJsAsTs = {
  name: 'sewing-resolve-js-as-ts',
  enforce: 'pre' as const,
  resolveId(source: string, importer: string | undefined) {
    if (!importer) return null;
    if (!source.startsWith('.')) return null;
    if (!source.endsWith('.js')) return null;
    if (!importer.startsWith(apiSrc) && !importer.startsWith(sharedSrc)) return null;
    const resolved = path.resolve(path.dirname(importer), source);
    const candidate = resolved.replace(/\.js$/, '.ts');
    return fs.existsSync(candidate) ? candidate : null;
  },
};

export default defineConfig({
  plugins: [
    resolveJsAsTs,
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        target: 'es2022',
        keepClassNames: true,
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 60_000,
    testTimeout: 30_000,
    setupFiles: ['./setup.ts'],
    sequence: { concurrent: false },
  },
  resolve: {
    alias: [
      {
        find: /^@sewing\/shared$/,
        replacement: path.resolve(sharedSrc, 'index.ts'),
      },
      {
        find: /^@sewing\/shared\/(.+)$/,
        replacement: path.resolve(sharedSrc, '$1'),
      },
      {
        find: /^@sewing\/api\/(.+)$/,
        replacement: path.resolve(apiSrc, '$1'),
      },
    ],
    extensions: ['.ts', '.js', '.json'],
  },
});
