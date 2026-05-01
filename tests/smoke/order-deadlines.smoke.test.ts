/**
 * Smoke-тесты для управленческого слоя «Order Deadlines + Risk
 * Detection» (см. ТЗ «Order Deadlines + Risk Detection»).
 *
 * Проверяем source-level, что:
 *   - shared-helper `evaluateOrderDeadline` существует и поддерживает
 *     все 5 бакетов;
 *   - DTO заказов отдают вычисленный `deadline`;
 *   - admin-страницы `/admin`, `/admin/orders` и `/admin/orders/[id]`
 *     рендерят бейдж/фильтр/карточку;
 *   - CSS-классы `admin-deadline-card` / `admin-deadline-progress`
 *     описаны в `globals.css`;
 *   - shopfloor/display, master и /orders/[id] (старая карточка) НЕ
 *     получают новых упоминаний deadline-фичи (см. блок «НЕ ДЕЛАТЬ»).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(p: string): string {
  return readFileSync(path.join(repoRoot, p), 'utf8');
}
function exists(p: string): boolean {
  return existsSync(path.join(repoRoot, p));
}

// ---------------------------------------------------------------------------
// 1. Shared helper
// ---------------------------------------------------------------------------

describe('shared — order-deadlines helper', () => {
  const shared = 'packages/shared/src/order-deadlines.ts';

  test('packages/shared/src/order-deadlines.ts существует', () => {
    expect(exists(shared)).toBe(true);
  });

  test('helper экспортирует evaluateOrderDeadline и все 5 бакетов', () => {
    const src = read(shared);
    expect(src).toMatch(/export function evaluateOrderDeadline/);
    for (const s of [
      'OVERDUE',
      'AT_RISK',
      'ON_TRACK',
      'NO_DUE_DATE',
      'DONE',
    ]) {
      expect(src).toContain(`'${s}'`);
    }
    // Тон-таблица существует и покрывает все бакеты.
    expect(src).toMatch(/ORDER_DEADLINE_TONES/);
    expect(src).toMatch(/ORDER_DEADLINE_LABELS/);
    expect(src).toMatch(/ORDER_DEADLINE_SORT_PRIORITY/);
  });

  test('shared/index.ts реэкспортирует ./order-deadlines', () => {
    const src = read('packages/shared/src/index.ts');
    expect(src).toMatch(/from '\.\/order-deadlines'/);
  });
});

// ---------------------------------------------------------------------------
// 2. Backend DTO + service
// ---------------------------------------------------------------------------

describe('backend — DTO заказов содержит deadline', () => {
  test('packages/shared/src/orders.ts экспортирует OrderDeadlineDto', () => {
    const src = read('packages/shared/src/orders.ts');
    expect(src).toMatch(/OrderDeadlineDto/);
    expect(src).toMatch(/deadline\?:\s*OrderDeadlineDto/);
    expect(src).toMatch(/qtyFinishedTotal/);
    expect(src).toMatch(/OrderDeadlineStatusSchema/);
  });

  test('OrdersService использует evaluateOrderDeadline и пробрасывает deadline в list/detail', () => {
    const src = read('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/evaluateOrderDeadline/);
    expect(src).toMatch(/evaluateDeadlineForDto/);
    // Helper вызывается и для list (toListItemDto), и для detail (toDetailDto).
    const calls = src.match(/evaluateDeadlineForDto/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // qtyFinished считается из паспортов в статусе PACKED.
    expect(src).toMatch(/PassportStatus\.PACKED/);
  });
});

// ---------------------------------------------------------------------------
// 3. Web — date-format helper + admin pages
// ---------------------------------------------------------------------------

describe('web — date-format helper', () => {
  test('apps/web/lib/date-format.ts существует и экспортирует formatDateRu / formatDaysLeft', () => {
    const p = 'apps/web/lib/date-format.ts';
    expect(exists(p)).toBe(true);
    const src = read(p);
    expect(src).toMatch(/export function formatDateRu/);
    expect(src).toMatch(/export function formatDaysLeft/);
    expect(src).toMatch(/export function formatProgressPercent/);
  });
});

describe('web — /admin/orders (список)', () => {
  const src = read('apps/web/app/admin/orders/page.tsx');

  test('страница рендерит фильтр deadline (DeadlineTabs)', () => {
    expect(src).toMatch(/DeadlineTabs/);
    // Все 4 кликабельных бакета фильтра упомянуты в DEADLINE_FILTER_TABS
    // (DONE из фильтра намеренно исключён, см. комментарий в page.tsx).
    expect(src).toMatch(/value:\s*'OVERDUE'/);
    expect(src).toMatch(/value:\s*'AT_RISK'/);
    expect(src).toMatch(/value:\s*'ON_TRACK'/);
    expect(src).toMatch(/value:\s*'NO_DUE_DATE'/);
    // URL-параметр фильтра используется в parsing/preserve.
    expect(src).toMatch(/deadline:\s*query\.deadline/);
    expect(src).toMatch(/parseDeadline/);
  });

  test('таблица содержит колонку "Срок" и DeadlineCell', () => {
    expect(src).toMatch(/header:\s*'Срок'/);
    expect(src).toMatch(/DeadlineCell/);
  });

  test('сортировка по дефолту использует ORDER_DEADLINE_SORT_PRIORITY', () => {
    expect(src).toMatch(/ORDER_DEADLINE_SORT_PRIORITY/);
  });

  test('listOrders в orders-api пробрасывает deadline и clientId', () => {
    const src = read('apps/web/lib/orders-api.ts');
    expect(src).toMatch(/deadline:\s*query\.deadline/);
    expect(src).toMatch(/clientId:\s*query\.clientId/);
  });
});

describe('web — /admin/orders/[id] (карточка)', () => {
  const headerSrc = read(
    'apps/web/components/orders/view/order-management-header.tsx',
  );

  test('OrderManagementHeader показывает срок + бейдж deadline', () => {
    // Order management redesign: «Срок» теперь — поле компактной
    // шапки `OrderManagementHeader`, а не отдельный блок «Сроки» в
    // summary tab. Бейдж и прогресс берутся из `order.deadline`.
    expect(headerSrc).toMatch(/label="Срок"/);
    expect(headerSrc).toMatch(/<AdminStatusBadge/);
    expect(headerSrc).toMatch(/admin-deadline-progress/);
  });

  test('используется bool-поток через order.deadline (без локального isOverdue)', () => {
    expect(headerSrc).toMatch(/order\.deadline/);
    expect(headerSrc).not.toMatch(/function isOverdue\b/);
  });
});

describe('web — /admin (Dashboard KPI «Контроль сроков»)', () => {
  const src = read('apps/web/app/admin/page.tsx');

  test('страница содержит блок «Контроль сроков» и DeadlineKpiBlock', () => {
    expect(src).toMatch(/Контроль сроков/);
    expect(src).toMatch(/DeadlineKpiBlock/);
    expect(src).toMatch(/admin-deadline-kpis/);
  });

  test('каждая KPI-карточка ссылается на /admin/orders?deadline=…', () => {
    expect(src).toMatch(/\/admin\/orders\?deadline=/);
  });
});

// ---------------------------------------------------------------------------
// 4. CSS
// ---------------------------------------------------------------------------

describe('web — globals.css содержит классы deadline-фичи', () => {
  const css = read('apps/web/app/globals.css');

  test.each([
    '.admin-deadline-card',
    '.admin-deadline-card--danger',
    '.admin-deadline-card--warning',
    '.admin-deadline-progress',
    '.admin-deadline-progress__bar',
    '.admin-deadline-kpis',
    '.admin-deadline-kpi',
    '.admin-deadline-tabs',
    '.admin-deadline-tab',
  ])('класс %s присутствует', (cls) => {
    expect(css).toContain(cls);
  });
});

// ---------------------------------------------------------------------------
// 5. Не задеваем production flow / master / shopfloor / display
// ---------------------------------------------------------------------------

describe('safety — задача не трогает passport flow и shopfloor display', () => {
  test('shopfloor display page не упоминает deadline/контроль срока', () => {
    const candidates = [
      'apps/web/app/shopfloor/display/page.tsx',
    ];
    for (const p of candidates) {
      if (!exists(p)) continue;
      const src = read(p);
      expect(src).not.toMatch(/admin-deadline/);
      expect(src).not.toMatch(/Контроль сроков/);
    }
  });

  test('master pages не упоминают deadline-классы', () => {
    const masterPages = [
      'apps/web/app/master/page.tsx',
    ];
    for (const p of masterPages) {
      if (!exists(p)) continue;
      const src = read(p);
      expect(src).not.toMatch(/admin-deadline/);
    }
  });

  test('старая карточка /orders/[id] не модифицирована под новый Контроль срока', () => {
    const p = 'apps/web/app/orders/[id]/page.tsx';
    if (!exists(p)) return;
    const src = read(p);
    // Допускается, что старая карточка не знает про deadline.
    expect(src).not.toMatch(/admin-deadline-card/);
  });
});
