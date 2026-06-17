/**
 * Server-rendered HTML печатная форма паспорта (Шаг 5 MVP).
 *
 * Стратегия выбрана сознательно вместо PDF — см. ADR-0010:
 * - не тащим тяжёлые runtime-зависимости (pdfkit / chromium);
 * - браузер сам отдаёт «Печать» через системный диалог;
 * - layout зафиксирован под физический размер термоэтикетки 70×120 мм
 *   (`@page size: 70mm 120mm`, без полей).
 *
 * QR-код вставляется как `<img src="data:image/png;base64,...">` —
 * payload генерируется через `qrcode` (см. ADR-0008: `passport:{id}`).
 * Дополнительно отображается человекочитаемый URL на UI-домене.
 *
 * Помимо одиночной формы (`renderPassportPrintHtml`) экспортируем
 * пакетную (`renderPassportsPrintHtml`) — один HTML-документ, в котором
 * каждый паспорт печатается своей этикеткой (новая страница на каждый
 * лист). Её открывает кнопка «Распечатать» помощника раскройщика, когда
 * на рабочем месте нет настроенного принтера-агента (браузерный fallback,
 * как у одиночного `<PrintButton>`).
 */

import type { PassportDetailDto } from '@sewing/shared/passports';

interface RenderOptions {
  passport: PassportDetailDto;
  qrDataUrl: string;
  webUrl: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU');
}

function formatNowDateTime(): string {
  const d = new Date();
  // Компактный формат под узкую этикетку: dd.mm.yyyy HH:MM.
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${date} ${time}`;
}

/**
 * Общая вёрстка этикетки. Едина для одиночной и пакетной печати, чтобы
 * лист выглядел одинаково независимо от точки входа.
 *
 * `.sheet + .sheet { page-break-before: always }` ниже гарантирует, что в
 * пакетном документе каждый следующий паспорт начинается с новой
 * страницы; для одиночного документа это правило безвредно (второго
 * `.sheet` нет, лишних пустых страниц не добавляется).
 */
const PASSPORT_PRINT_STYLES = `
    @page { size: 70mm 120mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body {
      width: 70mm;
      margin: 0;
      padding: 0;
      background: #fff;
      color: #000;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .sheet {
      width: 70mm;
      height: 120mm;
      padding: 2.8mm;
      margin: 0;
      background: #fff;
      color: #000;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .sheet + .sheet {
      page-break-before: always;
      break-before: page;
    }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 2mm;
      font-size: 7pt;
      line-height: 1.1;
      font-weight: 600;
    }
    .top .ts { color: #000; }
    .top .no {
      text-align: right;
      font-weight: 700;
      word-break: break-all;
    }
    .rule {
      border: 0;
      border-top: 0.25mm solid #000;
      margin: 1mm 0;
      width: 100%;
    }
    .title {
      font-size: 12pt;
      font-weight: 800;
      line-height: 1.1;
      text-align: center;
      letter-spacing: 0.2px;
      margin: 0.5mm 0 1mm;
      word-break: break-all;
    }
    .qr {
      text-align: center;
      margin: 0.5mm 0 0;
      flex: 0 0 auto;
    }
    .qr img {
      width: 30mm;
      height: 30mm;
      display: block;
      margin: 0 auto;
      image-rendering: pixelated;
    }
    .qr .url {
      font-size: 6pt;
      color: #000;
      word-break: break-all;
      margin-top: 0.5mm;
      line-height: 1.1;
    }
    .fields {
      flex: 1 1 auto;
      width: 100%;
      border-collapse: collapse;
      margin-top: 1mm;
      table-layout: fixed;
      overflow: hidden;
    }
    .fields th, .fields td {
      padding: 0.5mm 1mm;
      vertical-align: top;
      font-size: 7.5pt;
      line-height: 1.15;
      border-bottom: 0.15mm dashed #000;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .fields tr:last-child th,
    .fields tr:last-child td {
      border-bottom: none;
    }
    .fields th {
      text-align: left;
      color: #000;
      font-weight: 500;
      width: 38%;
    }
    .fields td {
      font-weight: 700;
    }
    .bottom-rule {
      border: 0;
      border-top: 0.25mm solid #000;
      margin: 1mm 0 0;
      width: 100%;
    }
    .actions {
      margin-top: 2mm;
      text-align: right;
    }
    .btn {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 4px;
      background: #2563eb;
      color: #fff;
      text-decoration: none;
      font-size: 9pt;
      border: 0;
      cursor: pointer;
    }
    @media screen {
      body { background: #e5e7eb; padding: 8px; width: auto; }
      .sheet {
        margin: 0 auto 8px;
        border: 1px solid #cbd5e1;
        box-shadow: 0 1px 4px rgba(0,0,0,0.1);
      }
    }
    @media print {
      .actions { display: none !important; }
      .sheet {
        border: none;
        box-shadow: none;
        page-break-inside: avoid;
        break-inside: avoid;
      }
    }`;

/**
 * Вёрстка одной этикетки (`<div class="sheet">…`).
 *
 * `withPrintButton` управляет встроенной кнопкой «Печать»: у одиночной
 * формы она внутри листа (как было), у пакетной — листы без кнопок, одна
 * общая кнопка «Печать всех» рендерится в шапке документа.
 */
function renderPassportSheet(
  opts: RenderOptions,
  withPrintButton: boolean,
): string {
  const p = opts.passport;
  const rows: Array<[string, string]> = [
    ['Заказ', p.orderNumber],
    ['Изделие', p.productName],
    ['Цвет', p.color],
    ['Размер', p.sizeCode],
    ['Количество', String(p.qtyCut)],
    ['Номер рулона', p.rollNumber],
    ['Дата кроя', formatDate(p.cutDate)],
    ['Раскройщик', p.cutterName],
    ['Создал', p.creatorName],
  ];
  const tableRows = rows
    .map(
      ([k, v]) =>
        `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`,
    )
    .join('');

  const printedAt = formatNowDateTime();

  return `<div class="sheet">
    <div class="top">
      <span class="ts">${escapeHtml(printedAt)}</span>
      <span class="no">${escapeHtml(p.number)}</span>
    </div>
    <hr class="rule" />
    <div class="title">Паспорт ${escapeHtml(p.number)}</div>
    <div class="qr">
      <img src="${opts.qrDataUrl}" alt="QR ${escapeHtml(p.number)}" />
      <div class="url">${escapeHtml(opts.webUrl)}</div>
    </div>
    <table class="fields">${tableRows}</table>
    <hr class="bottom-rule" />${
      withPrintButton
        ? `
    <div class="actions">
      <a href="javascript:window.print()" class="btn">Печать</a>
    </div>`
        : ''
    }
  </div>`;
}

export function renderPassportPrintHtml(opts: RenderOptions): string {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>Паспорт ${escapeHtml(opts.passport.number)}</title>
  <style>${PASSPORT_PRINT_STYLES}
  </style>
</head>
<body>
  ${renderPassportSheet(opts, true)}
</body>
</html>`;
}

/**
 * Пакетная печать: один документ, в нём по одной этикетке на паспорт.
 * Открывается помощником раскройщика как браузерный fallback кнопки
 * «Распечатать» (когда принтер-агент не настроен). Каждая этикетка — на
 * своей странице 70×120 мм; одна общая кнопка «Печать всех» в шапке
 * (видна только на экране, скрыта при печати).
 */
export function renderPassportsPrintHtml(items: RenderOptions[]): string {
  const sheets = items
    .map((it) => renderPassportSheet(it, false))
    .join('\n  ');
  const count = items.length;
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>Паспорта (${count})</title>
  <style>${PASSPORT_PRINT_STYLES}
    /* В пакетном документе высота тела растёт под все листы; фикс 120mm
       из общих стилей нужен только одиночной этикетке. */
    html, body { height: auto; }
    .toolbar {
      position: sticky;
      top: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      max-width: 70mm;
      margin: 0 auto 8px;
      padding: 6px 8px;
      background: #fff;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      font-size: 10pt;
    }
    @media print {
      .toolbar { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span>Паспортов к печати: ${count}</span>
    <a href="javascript:window.print()" class="btn">Печать всех</a>
  </div>
  ${sheets}
</body>
</html>`;
}
