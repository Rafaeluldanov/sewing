/**
 * Dev-only CJS preload для `node --watch` + `@swc-node/register`.
 *
 * В TypeScript-источниках мы пишем относительные импорты с расширением
 * `.js` (ESM-совместимый стиль TS), но сами файлы — `.ts`. `tsx` (esbuild)
 * разрешал это прозрачно; @swc-node/register в CJS-режиме этого не делает —
 * hook `pirates` компилирует уже найденные файлы, но Node-резолвер
 * ищет именно `foo.js` и не находит `foo.ts`.
 *
 * Патчим `Module._resolveFilename`: если строгий резолв упал с
 * MODULE_NOT_FOUND и запрос оканчивается на `.js`/`.mjs`/`.cjs` —
 * пробуем эквивалент `.ts`/`.mts`/`.cts`/`.tsx`. Поведение
 * ограничено локальными (относительными/абсолютными) импортами,
 * пакеты из `node_modules` не трогаем.
 */
const Module = require('node:module');

const origResolve = Module._resolveFilename;

const EXT_MAP = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

Module._resolveFilename = function patchedResolveFilename(request, parent, ...rest) {
  try {
    return origResolve.call(this, request, parent, ...rest);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && typeof request === 'string') {
      const isRelative = request.startsWith('./') || request.startsWith('../') || request.startsWith('/');
      if (isRelative) {
        for (const [fromExt, toExts] of Object.entries(EXT_MAP)) {
          if (request.endsWith(fromExt)) {
            const base = request.slice(0, -fromExt.length);
            for (const toExt of toExts) {
              try {
                return origResolve.call(this, base + toExt, parent, ...rest);
              } catch {}
            }
          }
        }
      }
    }
    throw err;
  }
};
