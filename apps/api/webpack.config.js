/**
 * Stage build: NestJS webpack-сборка с поддержкой ESM-импортов вида
 * `from './foo.js'` (TS source пишется так, чтобы было совместимо
 * с ESM, но bundle-ится для production — см. apps/api/package.json
 * "build": "nest build --webpack").
 *
 * Без extensionAlias webpack не находит './foo.js' для './foo.ts'.
 */
module.exports = function (options /*, webpack */) {
  return {
    ...options,
    resolve: {
      ...(options.resolve || {}),
      extensionAlias: {
        ...((options.resolve && options.resolve.extensionAlias) || {}),
        '.js': ['.ts', '.js'],
        '.mjs': ['.mts', '.mjs'],
      },
    },
  };
};
