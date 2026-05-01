/**
 * Server-rendered HTML печатная форма QR-этикетки ячейки.
 *
 * Стратегия совпадает с `passport-print.ts` и `equipment-print.ts`
 * (см. ADR-0010): отдаём HTML, агент или системный диалог браузера
 * запускает печать. PDF-стек на этом шаге не заводим.
 *
 * Формат этикетки — фиксированный 38×58 мм горизонтально:
 *   - левая половина  — QR-код (`cell:{id}` ADR-0008);
 *   - правая половина — крупный номер ячейки (`A1`, `B-02`, …);
 *   - больше ничего: ни имени склада, ни internal id, ни footer-текста,
 *     ни кнопки «Печать» в реальной печати — это термоэтикетка, и
 *     лишний шум на ней режет читаемость.
 *
 * Используется и для single-cell печати (кнопка «Печать QR» в
 * карточке склада, открывает HTML в новой вкладке) и для массовой
 * печати «Печать всех ячеек» (агент скачивает ту же страницу и
 * печатает на термопринтере 38×58).
 */

import type { CellDetailDto } from '@sewing/shared/passports';

interface RenderOptions {
  cell: CellDetailDto;
  qrDataUrl: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Подбираем размер шрифта под длину номера, чтобы и короткие коды
 * («A1») были крупными, и длинные («WH-MAIN-12») влезли без
 * обрезки. Высота этикетки 38mm, правая половина ~28mm ширины —
 * больше 12mm шрифта рискует обрезать дескендеры.
 */
function pickCodeFontMm(code: string): number {
  const len = code.length;
  if (len <= 3) return 12;
  if (len <= 4) return 11;
  if (len <= 6) return 9;
  if (len <= 8) return 7;
  return 6;
}

export function renderCellPrintHtml(opts: RenderOptions): string {
  const c = opts.cell;
  const fontMm = pickCodeFontMm(c.code);

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(c.code)}</title>
  <style>
    /* Жёсткий формат термоэтикетки 38×58 мм, ориентация горизонтальная.
       margin: 0 — критично, иначе принтер режет чёрно-белые края.
       print-color-adjust: exact + overflow: hidden + break-inside —
       страховка от ухода контента на вторую страницу и от того, что
       драйвер «оптимизирует» сплошной чёрный QR в серый. */
    @page { size: 58mm 38mm; margin: 0; }
    html, body {
      width: 58mm;
      height: 38mm;
      margin: 0;
      padding: 0;
      background: #fff;
      color: #000;
      overflow: hidden;
      page-break-inside: avoid;
      break-inside: avoid;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    * { box-sizing: border-box; }
    body {
      display: flex;
      flex-direction: row;
      align-items: stretch;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .label__qr {
      flex: 1 1 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5mm;
    }
    .label__qr img {
      width: 34mm;
      height: 34mm;
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      image-rendering: pixelated;
    }
    .label__code {
      flex: 1 1 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5mm 1mm;
      font-weight: 900;
      letter-spacing: -0.02em;
      line-height: 1;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: ${fontMm}mm;
      text-align: center;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    /* Кнопка «Печать» нужна только в screen-режиме (single-cell flow:
       менеджер открыл этикетку в новой вкладке и хочет руками
       подтвердить печать). На самой этикетке в реальной печати
       никаких UI-элементов быть не должно. */
    .actions {
      position: fixed;
      right: 8px;
      bottom: 8px;
      z-index: 10;
    }
    .actions .btn {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 6px;
      background: #000;
      color: #fff;
      text-decoration: none;
      font-size: 0.85rem;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    @media print {
      .actions { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="label__qr">
    <img src="${opts.qrDataUrl}" alt="" />
  </div>
  <div class="label__code">${escapeHtml(c.code)}</div>
  <div class="actions">
    <a href="javascript:window.print()" class="btn">Печать</a>
  </div>
</body>
</html>`;
}
