/**
 * HTML-этикетка с QR-кодом сотрудника.
 *
 * Применение — мастер цеха сканирует этот QR на `/master`, чтобы
 * закрыть открытый вызов конкретного рабочего (см.
 * `apps/api/src/modules/master-calls/*`,
 * `prisma/schema.prisma::MasterCall`, `docs/flows.md §«Вызов мастера»`).
 *
 * Стратегия рендеринга — та же, что у `equipment-print.ts` и
 * `passport-print.ts` (ADR-0010): отдаём HTML, печать запускается
 * системным диалогом браузера. На лицевой стороне крупный QR и ФИО,
 * чтобы мастер цеха легко находил нужную карточку даже на расстоянии,
 * без скана.
 */

import type { EmployeeDetailDto } from '@sewing/shared/employees';

interface RenderOptions {
  employee: EmployeeDetailDto;
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

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SHOP_MANAGER: 'Начальник цеха',
  CUTTER: 'Раскройщик',
  CUTTER_ASSISTANT: 'Помощник раскройщика',
  SEAMSTRESS: 'Швея',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
  SHOPFLOOR_MASTER: 'Мастер цеха',
  DISPLAY: 'Экран цеха',
};

export function renderEmployeePrintHtml(opts: RenderOptions): string {
  const e = opts.employee;
  const roleLabel = ROLE_LABELS[e.role] ?? e.role;

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>QR сотрудника ${escapeHtml(e.login)}</title>
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
    .label__name {
      font-size: 1.6rem;
      font-weight: 800;
      line-height: 1.15;
      margin: 4px 0 8px;
    }
    .label__role {
      font-size: 1rem;
      font-weight: 600;
      margin: 0 0 12px;
      color: #333;
    }
    .label__qr { margin: 8px auto 12px; }
    .label__qr img {
      width: 220px;
      height: 220px;
      image-rendering: pixelated;
    }
    .label__login {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.95rem;
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
    <div class="label__caption">Сотрудник</div>
    <div class="label__name">${escapeHtml(e.fullName)}</div>
    <div class="label__role">${escapeHtml(roleLabel)}</div>
    <div class="label__qr">
      <img src="${opts.qrDataUrl}" alt="QR ${escapeHtml(e.login)}" />
    </div>
    <div class="label__login">@${escapeHtml(e.login)}</div>
    <div class="actions">
      <a href="javascript:window.print()" class="btn">Печать</a>
    </div>
  </div>
</body>
</html>`;
}
