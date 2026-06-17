/**
 * Source-level smoke-тесты итерации «Фильтр статуса расчёта на
 * странице `/admin/workshop-needs`».
 *
 * Контекст: верхний фильтр страницы переехал с
 * `WorkshopNeed.status` (статус строки) на «Статус расчёта» —
 * управленческий фильтр по `Order.status`:
 *   - `ACTIVE` (default) — `Order.status = CALCULATION`;
 *   - `DONE`             — `Order.status = CALCULATION_DONE`;
 *   - `ALL`              — без фильтра по статусу заказа.
 *
 * `WorkshopNeed.status` остаётся в shared / inline-edit-row /
 * detail-форме — мы убираем только верхний фильтр страницы.
 *
 * Эти проверки — source-level (без поднятия БД), как и остальные
 * smoke-тесты в этой папке.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  WORKSHOP_NEED_ORDER_CALCULATION_FILTERS,
  WORKSHOP_NEED_ORDER_CALCULATION_FILTER_LABELS,
  WORKSHOP_NEED_STATUSES,
  WORKSHOP_NEED_STATUS_LABELS,
  ListWorkshopNeedsQuerySchema,
} from '@sewing/shared/workshop-needs';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

/**
 * Удаляет JSDoc / line-комментарии из исходника. Нужен, чтобы
 * проверить, что определённые токены (например, `WORKSHOP_NEED_STATUSES`)
 * отсутствуют именно в коде страницы, а не в JSDoc-описании
 * прежнего поведения. Простой rough-strip; для smoke-тестов хватает.
 */
function stripJsdoc(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const PAGE = 'apps/web/app/admin/workshop-needs/page.tsx';
const SHARED = 'packages/shared/src/workshop-needs.ts';
const SERVICE = 'apps/api/src/modules/workshop-needs/workshop-needs.service.ts';
const ORDER_CTRL =
  'apps/api/src/modules/workshop-needs/workshop-needs.order-controller.ts';
const API_CLIENT = 'apps/web/lib/workshop-needs-api.ts';

// ---------------------------------------------------------------------------
// 1. Shared
// ---------------------------------------------------------------------------

describe('Shared workshop-needs — Статус расчёта', () => {
  test('Экспортирует константы и лейблы фильтра', () => {
    expect(WORKSHOP_NEED_ORDER_CALCULATION_FILTERS).toEqual([
      'ACTIVE',
      'DONE',
      'ALL',
    ]);
    expect(WORKSHOP_NEED_ORDER_CALCULATION_FILTER_LABELS).toEqual({
      ACTIVE: 'В расчёте',
      DONE: 'Расчёт завершён',
      ALL: 'Все',
    });
  });

  test('Источник содержит экспорты констант и Zod-схему', () => {
    const src = read(SHARED);
    expect(src).toMatch(/WORKSHOP_NEED_ORDER_CALCULATION_FILTERS/);
    expect(src).toMatch(/WORKSHOP_NEED_ORDER_CALCULATION_FILTER_LABELS/);
    expect(src).toMatch(/WorkshopNeedOrderCalculationFilterSchema/);
  });

  test('ListWorkshopNeedsQuerySchema принимает orderCalculationStatus', () => {
    const ok = ListWorkshopNeedsQuerySchema.safeParse({
      orderCalculationStatus: 'ACTIVE',
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.orderCalculationStatus).toBe('ACTIVE');
    }
    expect(
      ListWorkshopNeedsQuerySchema.safeParse({
        orderCalculationStatus: 'DONE',
      }).success,
    ).toBe(true);
    expect(
      ListWorkshopNeedsQuerySchema.safeParse({
        orderCalculationStatus: 'ALL',
      }).success,
    ).toBe(true);
    // Невалидное значение — отбивается Zod-ом.
    expect(
      ListWorkshopNeedsQuerySchema.safeParse({
        orderCalculationStatus: 'GARBAGE',
      }).success,
    ).toBe(false);
    // Отсутствие — поле опционально.
    expect(
      ListWorkshopNeedsQuerySchema.safeParse({}).success,
    ).toBe(true);
  });

  test('Старый WorkshopNeed.status оставлен (не сломан backward-compat)', () => {
    expect(WORKSHOP_NEED_STATUSES).toContain('CALCULATED');
    expect(WORKSHOP_NEED_STATUSES).toContain('PURCHASE_PLANNED');
    expect(WORKSHOP_NEED_STATUS_LABELS.CALCULATED).toBe('Рассчитано');
    // ListWorkshopNeedsQuerySchema всё ещё принимает технический
    // фильтр `status` — его используют внутренние API-консьюмеры.
    expect(
      ListWorkshopNeedsQuerySchema.safeParse({ status: 'CALCULATED' })
        .success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Backend service
// ---------------------------------------------------------------------------

describe('WorkshopNeedsService.list — фильтр Статус расчёта', () => {
  const src = read(SERVICE);

  test('Сервис вычисляет effectiveOrderCalculationStatus с default по orderId', () => {
    expect(src).toMatch(/effectiveOrderCalculationStatus/);
    // Ключевая ветка: default = `ALL` если `orderId`, иначе `ACTIVE`.
    expect(src).toMatch(
      /query\.orderCalculationStatus\s*\?\?\s*\(query\.orderId\s*\?\s*'ALL'\s*:\s*'ACTIVE'\)/,
    );
  });

  test('Применяет фильтр order.status для ACTIVE / DONE и пропускает для ALL', () => {
    // Конкретные значения статуса заказа подставляются для ACTIVE/DONE.
    expect(src).toMatch(/'CALCULATION'/);
    expect(src).toMatch(/'CALCULATION_DONE'/);
    // Аккуратное объединение с уже существующим where.order.
    expect(src).toMatch(/mergeOrderWhere/);
  });

  test('order-controller передаёт orderCalculationStatus = ALL', () => {
    const ctrl = read(ORDER_CTRL);
    expect(ctrl).toMatch(
      /this\.needs\.list\(\{[^}]*orderCalculationStatus:\s*'ALL'/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. API client
// ---------------------------------------------------------------------------

describe('workshop-needs API client — orderCalculationStatus', () => {
  const src = read(API_CLIENT);

  test('listWorkshopNeeds прокидывает orderCalculationStatus в searchParams', () => {
    expect(src).toMatch(/orderCalculationStatus:\s*query\.orderCalculationStatus/);
    // Старый status оставлен (технический параметр).
    expect(src).toMatch(/status:\s*query\.status/);
  });
});

// ---------------------------------------------------------------------------
// 4. UI page
// ---------------------------------------------------------------------------

describe('/admin/workshop-needs — UI «Статус расчёта»', () => {
  const src = read(PAGE);

  test('Импорт констант фильтра из shared', () => {
    expect(src).toMatch(/WORKSHOP_NEED_ORDER_CALCULATION_FILTERS/);
    expect(src).toMatch(/WORKSHOP_NEED_ORDER_CALCULATION_FILTER_LABELS/);
  });

  test('Верхний select имеет label «Статус расчёта» и name=orderCalculationStatus', () => {
    expect(src).toMatch(/Статус расчёта/);
    expect(src).toMatch(/name="orderCalculationStatus"/);
    // Опции рендерятся из shared.
    expect(src).toMatch(
      /WORKSHOP_NEED_ORDER_CALCULATION_FILTERS\.map\(/,
    );
  });

  test('Default фильтр = ACTIVE', () => {
    expect(src).toMatch(/parseOrderCalculationStatus/);
    expect(src).toMatch(/return 'ACTIVE'/);
  });

  test('Старый верхний фильтр по WorkshopNeed.status убран из UI', () => {
    // 1) Никакого визуального label-а «Статус строки» / `name="status"`
    //    в форме фильтра больше нет (label был именно так подписан).
    //    Допускаем упоминание в комментарии — оно нужно, чтобы
    //    последующий разработчик не вернул фильтр обратно.
    const codeOnly = stripJsdoc(src);
    expect(codeOnly).not.toMatch(/name="status"/);
    expect(codeOnly).not.toMatch(/<label[^>]*>\s*Статус строки\s*</);
    // 2) `WORKSHOP_NEED_STATUSES` / `WORKSHOP_NEED_STATUS_LABELS` не
    //    используются в коде страницы — они нужны только внутри
    //    inline-edit-row / detail-формы.
    expect(codeOnly).not.toMatch(/WORKSHOP_NEED_STATUSES/);
    expect(codeOnly).not.toMatch(/WORKSHOP_NEED_STATUS_LABELS/);
    // 3) А значит и опций «Проверено закупщиком» / «К закупке» / …
    //    в верхнем select-е страницы быть не может.
    expect(codeOnly).not.toMatch(/Проверено закупщиком/);
    expect(codeOnly).not.toMatch(/К закупке/);
    expect(codeOnly).not.toMatch(/Заказано поставщику/);
    expect(codeOnly).not.toMatch(/Частично получено/);
    expect(codeOnly).not.toMatch(/Получено/);
    expect(codeOnly).not.toMatch(/Отменено/);
  });

  test('Страница НЕ читает searchParams.status и не передаёт его в listWorkshopNeeds', () => {
    // Никакой попытки прочитать `searchParams.status.trim()`.
    expect(src).not.toMatch(/searchParams\?\.status/);
    // Никакой передачи `status` в listWorkshopNeeds.
    expect(src).not.toMatch(/listWorkshopNeeds\(\{[\s\S]*?status:/);
  });

  test('Фильтр сохраняет orderCalculationStatus, но не status', () => {
    // preserveFilters-объект удалён вместе с переключателем режимов;
    // orderCalculationStatus берётся из searchParams и проставляется
    // в форму фильтра, а старый `status` строки не используется.
    expect(src).toMatch(/orderCalculationStatus/);
    expect(src).toMatch(/defaultValue=\{orderCalculationStatus\}/);
    expect(src).not.toMatch(/status:\s*status\s*\|\|\s*undefined/);
  });

  test('В шапке фильтра есть подсказка про default = ACTIVE', () => {
    expect(src).toMatch(/По умолчанию показаны только заказы в статусе «Расчёт»/);
    expect(src).toMatch(/Завершённые расчёты скрыты/);
  });

  test('Empty states по фильтру ACTIVE/DONE/ALL', () => {
    expect(src).toMatch(/Нет заказов в расчёте/);
    expect(src).toMatch(/Нет завершённых расчётов/);
    expect(src).toMatch(/Потребностей пока нет/);
  });
});

// ---------------------------------------------------------------------------
// 5. WorkshopNeed.status остаётся в строках/деталях
// ---------------------------------------------------------------------------

describe('WorkshopNeed.status — оставлен внутри строки/детали', () => {
  test('inline-edit-row всё ещё рендерит select со статусом строки', () => {
    const src = read(
      'apps/web/app/admin/workshop-needs/inline-edit-row.tsx',
    );
    // Импорт статусов — на месте.
    expect(src).toMatch(/WORKSHOP_NEED_STATUSES/);
    expect(src).toMatch(/WORKSHOP_NEED_STATUS_LABELS/);
    // Select со статусом строки.
    expect(src).toMatch(/<select[\s\S]*?name="status"[\s\S]*?WORKSHOP_NEED_STATUSES\.map/);
  });

  test('detail-форма /admin/workshop-needs/[id] всё ещё умеет статус строки', () => {
    const src = read(
      'apps/web/app/admin/workshop-needs/[id]/edit-form.tsx',
    );
    expect(src).toMatch(/WORKSHOP_NEED_STATUSES|WORKSHOP_NEED_STATUS_LABELS|name="status"/);
  });

  test('UpdateWorkshopNeedSchema по-прежнему принимает status', () => {
    const src = read(SHARED);
    expect(src).toMatch(/UpdateWorkshopNeedSchema/);
    expect(src).toMatch(
      /UpdateWorkshopNeedSchema[\s\S]*?status:\s*WorkshopNeedStatusSchema\.optional/,
    );
  });
});
