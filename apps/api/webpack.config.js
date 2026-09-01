/**
 * Stage build: NestJS webpack-сборка с поддержкой ESM-импортов вида
 * `from './foo.js'` (TS source пишется так, чтобы было совместимо
 * с ESM, но bundle-ится для production — см. apps/api/package.json
 * "build": "nest build --webpack").
 *
 * Без extensionAlias webpack не находит './foo.js' для './foo.ts'.
 *
 * externals для Swagger: webpack инлайнил swagger-ui-dist в bundle, и его
 * getAbsoluteFSPath() переставал указывать на реальную папку со статикой —
 * на проде /api/docs отдавал HTML, а swagger-ui.css/-bundle.js были 404
 * (пустая страница). Оставляем оба пакета runtime-require (node_modules
 * в prod-образе есть — см. apps/api/Dockerfile.prod). Матчим и сабпути
 * (`swagger-ui-dist/absolute-path.js`), поэтому функция, а не object-map.
 */
const SWAGGER_EXTERNALS = /^(@nestjs\/swagger|swagger-ui-dist)(\/|$)/;

module.exports = function (options /*, webpack */) {
  const baseExternals = Array.isArray(options.externals)
    ? options.externals
    : options.externals
      ? [options.externals]
      : [];
  return {
    ...options,
    externals: [
      ...baseExternals,
      ({ request }, callback) => {
        if (request && SWAGGER_EXTERNALS.test(request)) {
          return callback(null, 'commonjs ' + request);
        }
        return callback();
      },
    ],
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
