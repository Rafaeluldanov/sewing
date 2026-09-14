#!/usr/bin/env node
/**
 * Вшивает настоящие QR рабочих мест в выставочную схему
 * `docs/mockups/sewing-shopfloor-steps.html`.
 *
 * Источник истины — атрибут `data-qr` на каждом `<svg class="qr">` в
 * макете: `data-qr="equipment:cutting-table-01"`. Скрипт генерирует QR
 * (`qrcode`, тот же пакет, что печатает этикетки в API) и заменяет
 * содержимое svg. Повторный запуск идемпотентен.
 *
 * Payload `equipment:<Equipment.code>` понимают и форма «Начать смену»
 * (`apps/web/lib/equipment-operations.ts::matchEquipmentByCode`), и
 * `POST /api/me/switch-workplace` (`MeService.resolveEquipmentByCode`):
 * префикс срезается, дальше поиск по id ИЛИ по коду. Поэтому схема
 * работает на любом тенанте, где оборудование засеяно теми же кодами
 * (`prisma/seed.ts::EQUIPMENT`). Другой тенант с другими кодами —
 * поправить `data-qr` в макете и перезапустить:
 *
 *   node scripts/docs/shopfloor-scheme-qr.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// `qrcode` — зависимость apps/api; корневой резолв через workspace hoisting.
const QRCode = require('qrcode');

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '../../docs/mockups/sewing-shopfloor-steps.html');

const html = await readFile(target, 'utf8');
const re = /<svg class="qr"([^>]*?)data-qr="([^"]+)"([^>]*)>[\s\S]*?<\/svg>/g;

let count = 0;
const out = await replaceAsync(html, re, async (_m, pre, payload, post) => {
  const svg = await QRCode.toString(payload, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
  });
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  const dark = /<path stroke="#000000" d="([^"]+)"/.exec(svg)?.[1];
  if (!viewBox || !dark) throw new Error(`qrcode: неожиданный svg для ${payload}`);
  count += 1;
  // Машинный код, не оформление: всегда чёрное на белом, независимо от темы
  // страницы — инвертированный QR (тёмная тема) часть сканеров не читает.
  return (
    `<svg class="qr"${pre}data-qr="${payload}"${post} viewBox="${viewBox}" shape-rendering="crispEdges" role="img" aria-label="QR: ${payload}">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>` +
    `<path stroke="#000000" d="${dark}"/>` +
    `</svg>`
  );
});

await writeFile(target, out, 'utf8');
console.log(`QR вшито: ${count} → ${path.relative(process.cwd(), target)}`);

async function replaceAsync(str, regex, fn) {
  const jobs = [];
  str.replace(regex, (...args) => {
    jobs.push(fn(...args));
    return '';
  });
  const results = await Promise.all(jobs);
  let i = 0;
  return str.replace(regex, () => results[i++]);
}
