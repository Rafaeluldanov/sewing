/**
 * Server-rendered HTML печатная форма QR-этикетки оборудования.
 *
 * Стратегия — та же, что для паспорта (см. `passport-print.ts` и
 * ADR-0010): отдаём HTML, а печать запускается системным диалогом
 * браузера. Тяжёлый PDF-стек на этом шаге не заводим.
 *
 * Главная цель этикетки — человек на расстоянии метра должен
 * мгновенно различать «станок №1» и «станок №2». Поэтому
 * `displayNumber` — самый крупный визуальный элемент (после QR
 * по площади, но первый по «бросаемости в глаза»). QR-код кодирует
 * текущий equipment QR payload (`equipment:{id}` по ADR-0008) —
 * формат не меняется, scan flow остаётся совместимым.
 */

import type { EquipmentDetailDto } from '@sewing/shared/equipment';

interface RenderOptions {
  equipment: EquipmentDetailDto;
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

export function renderEquipmentPrintHtml(opts: RenderOptions): string {
  const eq = opts.equipment;
  // Если номера нет — покажем явный плейсхолдер, чтобы при печати
  // сразу было видно, что номер ещё не задан, а не пустое место.
  const numberText = eq.displayNumber && eq.displayNumber.length > 0
    ? eq.displayNumber
    : '—';
  const numberLabel = eq.displayNumber && eq.displayNumber.length > 0
    ? `Оборудование №${escapeHtml(eq.displayNumber)}`
    : 'Оборудование (номер не задан)';

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>QR оборудования ${escapeHtml(eq.code)}</title>
  <style>
    @page { size: A6; margin: 8mm; }
    * { box-sizing: border-box; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #000;
      background: #fff;
      margin: 0;
      padding: 16px;
    }
    .label {
      max-width: 360px;
      margin: 0 auto;
      background: #fff;
      border: 1px solid #000;
      border-radius: 8px;
      padding: 16px;
      text-align: center;
    }
    .label__caption {
      font-size: 0.85rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .label__number {
      font-size: 6rem;
      font-weight: 900;
      line-height: 1;
      margin: 4px 0 12px;
      letter-spacing: -0.02em;
    }
    .label__qr { margin: 8px auto 12px; }
    .label__qr img {
      width: 200px;
      height: 200px;
      image-rendering: pixelated;
    }
    .label__name {
      font-size: 1.1rem;
      font-weight: 700;
      margin: 8px 0 2px;
    }
    .label__code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.85rem;
      color: #000;
    }
    .actions { margin-top: 12px; text-align: right; }
    .btn {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 6px;
      background: #000;
      color: #fff;
      text-decoration: none;
      font-size: 0.85rem;
    }
    @media print {
      body { padding: 0; }
      .label { border: none; padding: 0; max-width: none; }
      .actions { display: none; }
    }
  </style>
</head>
<body>
  <div class="label">
    <div class="label__caption">${escapeHtml(numberLabel)}</div>
    <div class="label__number">№${escapeHtml(numberText)}</div>
    <div class="label__qr">
      <img src="${opts.qrDataUrl}" alt="QR ${escapeHtml(eq.code)}" />
    </div>
    <div class="label__name">${escapeHtml(eq.name)}</div>
    <div class="label__code">${escapeHtml(eq.code)}</div>
    <div class="actions">
      <a href="javascript:window.print()" class="btn">Печать</a>
    </div>
  </div>
</body>
</html>`;
}
