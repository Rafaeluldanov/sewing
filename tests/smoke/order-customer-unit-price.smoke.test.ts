/**
 * Smoke-тесты «Цена продажи за единицу» в заказе покупателя
 * (см. ТЗ §C, `prisma/schema.prisma::Order.customerUnitPrice`,
 * `apps/api/src/modules/orders/orders.service.ts`,
 * `packages/shared/src/orders.ts`,
 * `apps/web/app/admin/orders/new/admin-create-order-form.tsx`,
 * `apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx`,
 * `apps/web/components/orders/order-cost-estimate-card.tsx`).
 *
 * Покрытие:
 *   1. Prisma-схема и миграция добавляют два nullable-поля
 *      `customerUnitPrice` (DECIMAL(14,2)) и `customerCurrency` (TEXT).
 *      Backward-compatibility: ничего не бэкафиллим.
 *   2. Shared `CreateOrderSchema` / `UpdateOrderSchema` принимают
 *      оба поля как optional + nullable; валюта сужена через
 *      `MoneyCurrencySchema` (RUB/USD).
 *   3. `OrderListItemDto` / `OrderDetailDto` отдают `customerUnitPrice`
 *      / `customerCurrency` (Decimal как строка, валюта `MoneyCurrency
 *      | null`).
 *   4. Backend пишет и читает оба поля в `OrdersService.create` и
 *      `update` (включая default RUB при `price > 0`).
 *   5. Admin create / edit формы рендерят поле + select валюты.
 *   6. Карточка заказа показывает цену + выручку + маржу через
 *      `OrderCostEstimateCard` (расширенный блок «Продажа»).
 *   7. Список заказов получил колонку «Цена».
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function exists(relativePath: string): boolean {
  return existsSync(path.join(repoRoot, relativePath));
}

const MIGRATION =
  'prisma/migrations/20260521100000_add_order_customer_unit_price/migration.sql';
const SCHEMA = 'prisma/schema.prisma';
const SHARED_ORDERS = 'packages/shared/src/orders.ts';
const SERVICE = 'apps/api/src/modules/orders/orders.service.ts';
const ADMIN_NEW =
  'apps/web/app/admin/orders/new/admin-create-order-form.tsx';
const ADMIN_EDIT =
  'apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx';
const ADMIN_EDIT_ACTIONS =
  'apps/web/app/admin/orders/[id]/edit/actions.ts';
const ORDER_DETAIL = 'apps/web/app/admin/orders/[id]/page.tsx';
const ORDER_LIST = 'apps/web/app/admin/orders/page.tsx';
const COST_CARD =
  'apps/web/components/orders/order-cost-estimate-card.tsx';
const ORDERS_ACTIONS = 'apps/web/app/orders/actions.ts';

// ---------------------------------------------------------------------------
// 1. Prisma migration + schema
// ---------------------------------------------------------------------------

describe('Prisma — Order.customerUnitPrice / customerCurrency', () => {
  test('миграция 20260521100000 добавляет два nullable-поля без destructive-изменений', () => {
    expect(exists(MIGRATION)).toBe(true);
    const sql = read(MIGRATION);
    expect(sql).toMatch(/ALTER TABLE "Order"/);
    expect(sql).toMatch(/ADD COLUMN "customerUnitPrice"\s+DECIMAL\(14,\s*2\)/);
    expect(sql).toMatch(/ADD COLUMN "customerCurrency"\s+TEXT/);
    // Никаких DROP / NOT NULL / DEFAULT-back-fill — поле остаётся
    // nullable, исторические заказы не трогаем.
    expect(sql).not.toMatch(/DROP\b/);
    expect(sql).not.toMatch(/NOT NULL/);
  });

  test('schema.prisma объявляет оба поля как nullable Decimal/String на model Order', () => {
    const src = read(SCHEMA);
    expect(src).toMatch(/customerUnitPrice\s+Decimal\?\s+@db\.Decimal\(14,\s*2\)/);
    expect(src).toMatch(/customerCurrency\s+String\?/);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared DTO + schemas
// ---------------------------------------------------------------------------

describe('Shared — CreateOrderSchema / UpdateOrderSchema / DTOs', () => {
  test('CreateOrderSchema принимает customerUnitPrice / customerCurrency', () => {
    const src = read(SHARED_ORDERS);
    expect(src).toMatch(/CustomerUnitPriceField/);
    expect(src).toMatch(/CustomerCurrencyField/);
    expect(src).toMatch(/MoneyCurrencySchema/);
    expect(src).toMatch(/customerUnitPrice:\s*CustomerUnitPriceField/);
    expect(src).toMatch(/customerCurrency:\s*CustomerCurrencyField/);
  });

  test('UpdateOrderSchema тоже принимает оба поля', () => {
    const src = read(SHARED_ORDERS);
    // Внутри UpdateOrderSchema (вторая встреча) поле тоже есть.
    const matchPriceCount =
      (src.match(/customerUnitPrice:\s*CustomerUnitPriceField/g) ?? [])
        .length;
    expect(matchPriceCount).toBeGreaterThanOrEqual(2);
    const matchCurrencyCount =
      (src.match(/customerCurrency:\s*CustomerCurrencyField/g) ?? [])
        .length;
    expect(matchCurrencyCount).toBeGreaterThanOrEqual(2);
  });

  test('OrderListItemDto / OrderDetailDto отдают customerUnitPrice + customerCurrency', () => {
    const src = read(SHARED_ORDERS);
    expect(src).toMatch(
      /customerUnitPrice\?:\s*string\s*\|\s*number\s*\|\s*null/,
    );
    expect(src).toMatch(
      /customerCurrency\?:\s*MoneyCurrency\s*\|\s*null/,
    );
  });

  test('CustomerCurrencyField сужает валюту до RUB/USD (MoneyCurrencySchema)', () => {
    const src = read(SHARED_ORDERS);
    expect(src).toMatch(
      /CustomerCurrencyField[\s\S]{0,400}MoneyCurrencySchema\.nullable\(\)\.optional\(\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Backend service
// ---------------------------------------------------------------------------

describe('OrdersService — пишет и читает customer unit price', () => {
  test('create сохраняет customerUnitPrice / customerCurrency через resolveCustomerPriceAndCurrency', () => {
    const src = read(SERVICE);
    expect(src).toMatch(/resolveCustomerPriceAndCurrency/);
    // В data create блока заказа.
    expect(src).toMatch(/customerUnitPrice:\s*\n?\s*customerUnitPrice/);
    expect(src).toMatch(/customerCurrency:\s*customerCurrency/);
  });

  test('update тоже передаёт оба поля и default RUB при price > 0', () => {
    const src = read(SERVICE);
    expect(src).toMatch(/customerUnitPrice:\s*customerPriceForPrisma/);
    expect(src).toMatch(/customerCurrency:\s*customerCurrencyForPrisma/);
    expect(src).toMatch(/customerCurrencyForPrisma\s*=\s*'RUB'/);
  });

  test('toListItemDto и toDetailDto возвращают оба поля', () => {
    const src = read(SERVICE);
    // toListItemDto.
    expect(src).toMatch(
      /customerUnitPrice:\s*o\.customerUnitPrice/,
    );
    // toDetailDto.
    expect(src).toMatch(
      /customerUnitPrice:\s*order\.customerUnitPrice/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Admin create / edit
// ---------------------------------------------------------------------------

describe('Admin — /admin/orders/new + /admin/orders/[id]/edit', () => {
  test('admin-create-order-form содержит цену продажи + select валюты', () => {
    const src = read(ADMIN_NEW);
    expect(src).toMatch(/name="customerUnitPrice"/);
    expect(src).toMatch(/name="customerCurrency"/);
    // Order workspace v2: компактный лейбл «Цена за 1 шт» в hero.
    // Длинная подпись «Цена продажи за единицу» осталась в KPI hint
    // и доке для совместимости со смежными тестами.
    expect(src).toMatch(/Цена за 1 шт|Цена продажи за единицу/);
    expect(src).toMatch(/MONEY_CURRENCIES/);
  });

  test('admin-edit-order-form также содержит оба поля + дефолт из order', () => {
    const src = read(ADMIN_EDIT);
    expect(src).toMatch(/name="customerUnitPrice"/);
    expect(src).toMatch(/name="customerCurrency"/);
    expect(src).toMatch(/Цена за 1 шт|Цена продажи за единицу/);
    expect(src).toMatch(/order\.customerUnitPrice/);
    expect(src).toMatch(/order\.customerCurrency/);
  });

  test('admin-edit actions парсит оба поля с правильной семантикой пусто/нет/значение', () => {
    const src = read(ADMIN_EDIT_ACTIONS);
    expect(src).toMatch(/customerUnitPrice/);
    expect(src).toMatch(/customerCurrency/);
    // Пустая строка → null, отсутствующее поле → undefined.
    expect(src).toMatch(/customerUnitPrice\s*=\s*v === ''\s*\?\s*null\s*:\s*v/);
  });

  test('orders/actions.ts (legacy + admin create) парсит customerUnitPrice через общий helper', () => {
    const src = read(ORDERS_ACTIONS);
    expect(src).toMatch(/parseCustomerPriceFromForm/);
    expect(src).toMatch(/customerUnitPrice/);
    expect(src).toMatch(/customerCurrency/);
  });
});

// ---------------------------------------------------------------------------
// 5. Admin detail + list
// ---------------------------------------------------------------------------

describe('Admin — карточка и список заказов показывают цену продажи', () => {
  test('order detail page рендерит OrderNeedsTab + OrderSummaryTab (финансовый deep-dive в costSummary)', () => {
    // Order management redesign: блок «Продажа» / выручка / маржа
    // собран в `OrderSummaryUnifiedTable`, который теперь живёт в
    // отдельной финансовой вкладке «Сводно по заказу»
    // (`?tab=costSummary` → `<OrderSummaryTab>`). В Needs он
    // по-прежнему запрещён, потому что дублировал бы материалы
    // (рендер по строкам) рядом с `OrderMaterialsUnifiedTable`.
    // В Needs остаётся компактный aggregate-only блок
    // `OrderPlannedCostSummaryCard` (материалы / фурнитура /
    // нанесение / операции / итого + «за 1 изделие»). Stand-alone
    // `OrderCostEstimateCard` тоже не используется — карточка
    // остаётся в репо как legacy.
    const src = read(ORDER_DETAIL);
    expect(src).toMatch(/OrderNeedsTab/);
    expect(src).toMatch(/OrderSummaryTab/);
    expect(src).toMatch(/activeTab === 'costSummary'/);
    expect(src).not.toMatch(/<OrderCostEstimateCard\b/);
    const needsTabSrc = read(
      'apps/web/components/orders/view/tabs/order-needs-tab.tsx',
    );
    expect(needsTabSrc).toMatch(/<OrderPlannedCostSummaryCard\b/);
    expect(needsTabSrc).not.toMatch(/<OrderSummaryUnifiedTable\b/);
  });

  test('OrderCostEstimateCard файл (legacy) всё ещё содержит блок «Продажа» с Цена / Количество / Выручка / Себестоимость / Маржа', () => {
    const src = read(COST_CARD);
    expect(src).toMatch(/CustomerPriceSection/);
    expect(src).toMatch(/Цена продажи за единицу/);
    expect(src).toMatch(/>Количество</);
    expect(src).toMatch(/>Выручка</);
    expect(src).toMatch(/>Себестоимость</);
    expect(src).toMatch(/>Маржа</);
    // Маржа в RUB только если currency = RUB (для USD без курса).
    expect(src).toMatch(/isRub/);
  });

  test('Сводная таблица «Сводно по заказу» считает выручку / маржу для RUB-цены', () => {
    const helperPath =
      'apps/web/components/orders/summary/build-order-summary-rows.ts';
    const helper = read(helperPath);
    expect(helper).toMatch(/revenueTotalRub/);
    expect(helper).toMatch(/marginTotalRub/);
    expect(helper).toMatch(/marginPerUnitRub/);
    expect(helper).toMatch(/marginPercent/);
    // USD-цена без курса не считается в RUB margin.
    expect(helper).toMatch(/USD/);
  });

  test('Список заказов имеет колонку «Цена» с символом валюты', () => {
    const src = read(ORDER_LIST);
    expect(src).toMatch(/<PriceCell\b/);
    expect(src).toMatch(/customerUnitPrice/);
    // Символ ₽ / $ зависит от customerCurrency.
    expect(src).toMatch(/'\$'|'₽'/);
  });
});
