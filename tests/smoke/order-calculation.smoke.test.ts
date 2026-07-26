/**
 * Smoke-тесты этапа «Расчёт» — переход заказа из `DRAFT` в `CALCULATION`
 * с автоматическим вызовом `WorkshopNeedsService.calculateForOrder`.
 *
 * Source-of-truth:
 *   - Prisma:        `prisma/schema.prisma` (`enum OrderStatus`),
 *                    миграция
 *                    `prisma/migrations/20260514100000_add_order_status_calculation`.
 *   - Shared:        `packages/shared/src/orders.ts`
 *                    (`ORDER_STATUSES`, `ORDER_STATUS_LABELS`).
 *   - Backend:       `apps/api/src/modules/orders/orders.service.ts`
 *                    (`OrdersService.startCalculation`),
 *                    `apps/api/src/modules/orders/orders.controller.ts`
 *                    (`POST /api/orders/:id/start-calculation`),
 *                    `apps/api/src/modules/orders/orders.module.ts`
 *                    (импорт `WorkshopNeedsModule`).
 *   - Frontend:      `apps/web/components/orders/start-calculation-button.tsx`,
 *                    `apps/web/components/orders/workshop-needs-card.tsx`
 *                    (orderStatus-aware UX),
 *                    `apps/web/app/admin/orders/[id]/page.tsx`,
 *                    `apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx`,
 *                    `apps/web/lib/orders-api.ts`,
 *                    `apps/web/lib/admin-labels.ts`.
 *   - Errors:        `apps/api/src/common/errors.ts`.
 *
 * Все проверки — source-level (как и остальные smoke-тесты),
 * чтобы CI не зависел от поднятия БД/бэкенда.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
} from '@sewing/shared/orders';
import {
  formatOrderStatus,
  getOrderStatusTone,
} from '../../apps/web/lib/admin-labels';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(p: string): string {
  return readFileSync(path.join(repoRoot, p), 'utf8');
}
function exists(p: string): boolean {
  return existsSync(path.join(repoRoot, p));
}

// ---------------------------------------------------------------------------
// 1. Prisma schema + миграция
// ---------------------------------------------------------------------------

describe('Prisma — enum OrderStatus c CALCULATION + миграция', () => {
  test('schema.prisma содержит CALCULATION в enum OrderStatus', () => {
    const src = read('prisma/schema.prisma');
    // Сам список значений + порядок: DRAFT, CALCULATION, CALCULATION_DONE,
    // IN_PRODUCTION, DONE, CANCELLED (на этапе «Себестоимость заказа»
    // в enum добавлен `CALCULATION_DONE`, см.
    // `prisma/migrations/20260520100000_add_order_cost_estimates`).
    expect(src).toMatch(/enum OrderStatus\s*\{[\s\S]*?\bCALCULATION\b/);
    expect(src).toMatch(/enum OrderStatus\s*\{[\s\S]*?\bCALCULATION_DONE\b/);
    expect(src).toMatch(/enum OrderStatus\s*\{[\s\S]*?\bIN_PRODUCTION\b/);
  });

  test('миграция 20260514100000_add_order_status_calculation существует и расширяет enum через ALTER TYPE', () => {
    const migrationPath =
      'prisma/migrations/20260514100000_add_order_status_calculation/migration.sql';
    expect(exists(migrationPath)).toBe(true);
    const sql = read(migrationPath);
    expect(sql).toMatch(/ALTER TYPE\s+"OrderStatus"\s+ADD VALUE\s+'CALCULATION'/);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared package — ORDER_STATUSES + лейблы
// ---------------------------------------------------------------------------

describe('@sewing/shared/orders — CALCULATION в shared контракте', () => {
  test('ORDER_STATUSES содержит CALCULATION', () => {
    expect(ORDER_STATUSES).toContain('CALCULATION');
    // DRAFT и IN_PRODUCTION остались — backward-compat прежних flow.
    expect(ORDER_STATUSES).toContain('DRAFT');
    expect(ORDER_STATUSES).toContain('IN_PRODUCTION');
    expect(ORDER_STATUSES).toContain('DONE');
    expect(ORDER_STATUSES).toContain('CANCELLED');
  });

  test('ORDER_STATUS_LABELS отдаёт «Расчёт» для CALCULATION', () => {
    expect(ORDER_STATUS_LABELS.CALCULATION).toBe('Расчёт');
    // Существующие лейблы не трогали.
    expect(ORDER_STATUS_LABELS.DRAFT).toBe('Черновик');
    expect(ORDER_STATUS_LABELS.IN_PRODUCTION).toBe('В производстве');
  });
});

// ---------------------------------------------------------------------------
// 3. Backend: errors + service + controller + module
// ---------------------------------------------------------------------------

describe('Backend — errors / service / controller / module', () => {
  test('errors.ts объявляет четыре исключения с правильными кодами', () => {
    const src = read('apps/api/src/common/errors.ts');
    expect(src).toMatch(/OrderInvalidStatusTransitionException/);
    expect(src).toMatch(/'ORDER_INVALID_STATUS_TRANSITION'/);
    expect(src).toMatch(/OrderPatternRequiredException/);
    expect(src).toMatch(/'ORDER_PATTERN_REQUIRED'/);
    expect(src).toMatch(/OrderTechCardRequiredException/);
    expect(src).toMatch(/'ORDER_TECH_CARD_REQUIRED'/);
    expect(src).toMatch(/OrderItemsRequiredException/);
    expect(src).toMatch(/'ORDER_ITEMS_REQUIRED'/);
  });

  test('OrdersService содержит startCalculation, который зовёт WorkshopNeedsService.calculateForOrder', () => {
    const src = read('apps/api/src/modules/orders/orders.service.ts');
    // Метод объявлен.
    expect(src).toMatch(/async\s+startCalculation\s*\(/);
    // Делегирует в WorkshopNeedsService с force=false.
    expect(src).toMatch(/this\.workshopNeeds\.calculateForOrder\(/);
    expect(src).toMatch(/\{\s*force:\s*false\s*\}/);
    // Меняет статус на CALCULATION.
    expect(src).toMatch(/status:\s*OrderStatus\.CALCULATION/);
    // Аудит ORDER_CALCULATION_STARTED фиксируется в той же транзакции,
    // что и смена статуса.
    expect(src).toMatch(/event:\s*'ORDER_CALCULATION_STARTED'/);
    // Предохранители (адресные ошибки).
    expect(src).toMatch(/OrderInvalidStatusTransitionException/);
    expect(src).toMatch(/OrderPatternRequiredException/);
    expect(src).toMatch(/OrderTechCardRequiredException/);
    expect(src).toMatch(/OrderItemsRequiredException/);
  });

  test('OrdersService.start() разрешает старт из DRAFT и CALCULATION', () => {
    const src = read('apps/api/src/modules/orders/orders.service.ts');
    // start() допускает оба исходных статуса.
    expect(src).toMatch(
      /order\.status !== OrderStatus\.DRAFT[\s\S]*?order\.status !== OrderStatus\.CALCULATION/,
    );
  });

  test('OrdersService.update() блокирует unsafe-поля и для CALCULATION', () => {
    const src = read('apps/api/src/modules/orders/orders.service.ts');
    // Status update в update() умеет роутить DRAFT → CALCULATION
    // через startCalculation.
    expect(src).toMatch(/this\.startCalculation\(id, actorEmployeeId\)/);
    // CALCULATION → IN_PRODUCTION делегирует в start().
    expect(src).toMatch(
      /current\.status === OrderStatus\.CALCULATION[\s\S]*?next === OrderStatus\.IN_PRODUCTION/,
    );
  });

  test('OrdersController имеет POST :id/start-calculation с правильным RBAC', () => {
    const src = read('apps/api/src/modules/orders/orders.controller.ts');
    expect(src).toMatch(/@Post\(':id\/start-calculation'\)/);
    expect(src).toMatch(/startCalculation/);
    // Класс контроллера остаётся под `@Roles('SHOP_MANAGER')` — ADMIN
    // получает доступ через глобальные правила Roles-guard.
    expect(src).toMatch(/@Roles\(['"]SHOP_MANAGER['"]\)/);
  });

  test('OrdersModule импортирует WorkshopNeedsModule', () => {
    const src = read('apps/api/src/modules/orders/orders.module.ts');
    expect(src).toMatch(/WorkshopNeedsModule/);
    expect(src).toMatch(/workshop-needs\/workshop-needs\.module/);
  });
});

// ---------------------------------------------------------------------------
// 4. Frontend: lib + admin-labels
// ---------------------------------------------------------------------------

describe('Frontend — lib/admin-labels + lib/orders-api', () => {
  test('formatOrderStatus возвращает «Расчёт» для CALCULATION', () => {
    expect(formatOrderStatus('CALCULATION')).toBe('Расчёт');
  });

  test('getOrderStatusTone отдаёт warning для CALCULATION', () => {
    expect(getOrderStatusTone('CALCULATION')).toBe('warning');
    // Сохранили существующие тоны.
    expect(getOrderStatusTone('DRAFT')).toBe('muted');
    expect(getOrderStatusTone('IN_PRODUCTION')).toBe('info');
    expect(getOrderStatusTone('DONE')).toBe('success');
    expect(getOrderStatusTone('CANCELLED')).toBe('danger');
  });

  test('admin-labels.ts — словарь ORDER_STATUS_LABELS включает CALCULATION', () => {
    const src = read('apps/web/lib/admin-labels.ts');
    expect(src).toMatch(/CALCULATION:\s*['"]Расчёт['"]/);
  });

  test('lib/orders-api.ts экспортирует startCalculationOrder + лейбл', () => {
    const src = read('apps/web/lib/orders-api.ts');
    expect(src).toMatch(/export function startCalculationOrder/);
    expect(src).toMatch(/start-calculation/);
    expect(src).toMatch(/CALCULATION:\s*['"]Расчёт['"]/);
  });
});

// ---------------------------------------------------------------------------
// 5. Server actions + кнопка «Перевести в расчёт»
// ---------------------------------------------------------------------------

describe('Frontend — server-action и кнопка «Перевести в расчёт»', () => {
  test('actions.ts содержит startCalculationOrderAction', () => {
    const src = read('apps/web/app/orders/actions.ts');
    expect(src).toMatch(/export async function startCalculationOrderAction/);
    expect(src).toMatch(/startCalculationOrder\(id\)/);
    expect(src).toMatch(/revalidatePath\(`\/admin\/orders\/\$\{id\}`\)/);
  });

  test('start-calculation-button.tsx существует и шлёт action', () => {
    const file = 'apps/web/components/orders/start-calculation-button.tsx';
    expect(exists(file)).toBe(true);
    const src = read(file);
    expect(src).toMatch(/startCalculationOrderAction/);
    expect(src).toMatch(/Перевести в расчёт/);
    // Confirm-диалог обязателен — иначе случайный клик уносит план в расчёт.
    expect(src).toMatch(/window\.confirm/);
  });
});

// ---------------------------------------------------------------------------
// 6. Admin order detail / edit / WorkshopNeedsCard
// ---------------------------------------------------------------------------

describe('/admin/orders/[id] — кнопка «Перевести в расчёт» в OrderManagementHeader', () => {
  const headerPath =
    'apps/web/components/orders/view/order-management-header.tsx';
  const src = read(headerPath);

  test('переход DRAFT → «Расчёт» живёт в контроле статуса, а не в кнопке шапки', () => {
    // Кнопки смены статуса из шапки убраны: все переходы рисует
    // `OrderStatusSelect` по `OrderDetailDto.availableTransitions`.
    expect(src).toMatch(/<OrderStatusSelect/);
    expect(src).toMatch(/transitions=\{order\.availableTransitions\}/);
    expect(src).not.toMatch(/<StartProductionButton\b/);
    // «Рассчитать вариант» остаётся кнопкой — это не смена статуса.
    expect(src).toMatch(/<StartCalculationButton[\s\S]*?variantMode/);
  });

  test('OrderNeedsTab → OrderMaterialsUnifiedTable + ManualMaterialArrivalActions с orderStatus', () => {
    const needsTabSrc = read(
      'apps/web/components/orders/view/tabs/order-needs-tab.tsx',
    );
    expect(needsTabSrc).toMatch(/<OrderMaterialsUnifiedTable\b/);
    expect(needsTabSrc).toMatch(
      /<ManualMaterialArrivalActions[\s\S]*?orderStatus=\{order\.status\}/,
    );
  });
});

describe('WorkshopNeedsCard — orderStatus-aware UX', () => {
  const cardPath = 'apps/web/components/orders/workshop-needs-card.tsx';
  const src = read(cardPath);

  test('компонент принимает orderStatus и обрабатывает все 5 статусов', () => {
    expect(src).toMatch(/orderStatus\?:\s*OrderStatus/);
    expect(src).toMatch(/orderStatus === ['"]DRAFT['"]/);
    expect(src).toMatch(/orderStatus === ['"]CALCULATION['"]/);
    expect(src).toMatch(/orderStatus === ['"]IN_PRODUCTION['"]/);
  });

  test('в DRAFT компонент показывает подсказку про перевод в расчёт', () => {
    // Текст подсказки может быть переносом строк раздроблен в JSX; в
    // raw-источнике пробел заменяется на любой whitespace, поэтому
    // регулярка дополнительно использует `\s+`.
    expect(src).toMatch(
      /Потребность будет создана после перевода заказа в статус\s+«Расчёт»/,
    );
  });

  test('в DRAFT manual-calculate-форма скрыта (showManualCalculate)', () => {
    // Видимость определена через showManualCalculate, который ложится
    // false в DRAFT и read-only-режимах.
    expect(src).toMatch(/showManualCalculate/);
    expect(src).toMatch(
      /\{showManualCalculate && \(\s*<CalculateWorkshopNeedsForm/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6.1. WorkflowButtons — выделенные actions заказа в hero
// ---------------------------------------------------------------------------

describe('/admin/orders/[id] — workflow actions в OrderManagementHeader', () => {
  const headerPath =
    'apps/web/components/orders/view/order-management-header.tsx';
  const src = read(headerPath);

  test('страница использует OrderWorkspaceLayout mode="view" и не имеет старой grid-сетки', () => {
    const pageSrc = read('apps/web/app/admin/orders/[id]/page.tsx');
    expect(pageSrc).toMatch(/<OrderWorkspaceLayout\s*[\s\S]*?mode="view"/);
    expect(pageSrc).not.toMatch(/className="admin-order-detail-layout"/);
  });

  test('в шапке остались только НЕ-статусные действия', () => {
    // Статусные `show*`-флаги удалены вместе с кнопками: какой переход
    // доступен, решает backend (`evaluateOrderTransitions`).
    expect(src).not.toMatch(/showStartCalc/);
    expect(src).not.toMatch(/showStartProd/);
    expect(src).not.toMatch(/showComplete\s*=/);
    expect(src).not.toMatch(/showCancel\s*=/);
    // Не-статусные действия на месте.
    expect(src).toMatch(/showRecalcPlan\s*=/);
    expect(src).toMatch(/showEdit\s*=\s*isOrderPlanEditable\(status\)/);
    expect(src).toMatch(/<DeleteOrderButton/);
  });
});

describe('OrderStatusSelect — контрол статуса поверх существующих ручек', () => {
  const file = 'apps/web/components/orders/view/order-status-select.tsx';

  test('файл существует и зарегистрирован как клиентский компонент', () => {
    expect(exists(file)).toBe(true);
    expect(read(file)).toMatch(/^['"]use client['"]/);
  });

  test('переход выполняется server-action-ом changeOrderStatusAction, гейты не дублируются', () => {
    const src = read(file);
    expect(src).toMatch(/changeOrderStatusAction/);
    // Ленивый догруз переходов для строки списка заказов.
    expect(src).toMatch(/loadOrderTransitionsAction/);
    // Список рисуется по всему маршруту (`ORDER_STATUSES`), а правила
    // приходят из DTO — своих status-условий у компонента нет.
    expect(src).toMatch(/ORDER_STATUSES/);
    expect(src).not.toMatch(/status === 'CALCULATION_DONE'/);
  });

  test('changeOrderStatusAction — диспетчер поверх существующих ручек, без новых эндпоинтов', () => {
    const actions = read('apps/web/app/orders/actions.ts');
    expect(actions).toMatch(/export async function changeOrderStatusAction/);
    expect(actions).toMatch(/startCalculationOrder\(orderId\)/);
    expect(actions).toMatch(/startOrder\(orderId\)/);
    expect(actions).toMatch(/reopenOrderCalculation\(orderId/);
    expect(actions).toMatch(/completeOrder\(orderId\)/);
    expect(actions).toMatch(/cancelOrder\(orderId\)/);
  });
});

describe('Переходы статуса — единый источник истины в shared', () => {
  const file = 'packages/shared/src/order-transitions.ts';

  test('pure-helper существует и не тянет prisma/react', () => {
    expect(exists(file)).toBe(true);
    const src = read(file);
    expect(src).toMatch(/export function evaluateOrderTransitions/);
    // Именно IMPORT-ы: упоминание `@prisma/client` в комментарии
    // («модуль от него не зависит») — это документация, а не связь.
    expect(src).not.toMatch(/from '@prisma\/client'/);
    expect(src).not.toMatch(/from 'react'/);
  });

  test('backend отдаёт availableTransitions в DTO и отдельной ручкой для списка', () => {
    const service = read('apps/api/src/modules/orders/orders.service.ts');
    expect(service).toMatch(/availableTransitions:\s*evaluateOrderTransitions/);
    expect(service).toMatch(/async getTransitions\(/);
    const controller = read('apps/api/src/modules/orders/orders.controller.ts');
    expect(controller).toMatch(/@Get\(':id\/transitions'\)/);
  });
});

describe('CSS — .admin-order-workflow* в globals.css', () => {
  const css = read('apps/web/app/globals.css');

  test('базовые классы карточки определены', () => {
    expect(css).toMatch(/\.admin-order-workflow\s*\{/);
    expect(css).toMatch(/\.admin-order-workflow__head\b/);
    expect(css).toMatch(/\.admin-order-workflow__body\b/);
    expect(css).toMatch(/\.admin-order-workflow__hint\b/);
    expect(css).toMatch(/\.admin-order-workflow__actions\b/);
  });

  test('тон-варианты по статусам заказа определены', () => {
    expect(css).toMatch(/\.admin-order-workflow--draft\b/);
    expect(css).toMatch(/\.admin-order-workflow--calculation\b/);
    expect(css).toMatch(/\.admin-order-workflow--production\b/);
    expect(css).toMatch(/\.admin-order-workflow--done\b/);
    expect(css).toMatch(/\.admin-order-workflow--cancelled\b/);
  });
});

describe('/admin/orders/[id]/edit — статус «Расчёт» в селекте', () => {
  const formPath = 'apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx';
  const src = read(formPath);

  test('allowedStatusOptions предлагает CALCULATION в DRAFT и IN_PRODUCTION в CALCULATION', () => {
    expect(src).toMatch(
      /case 'DRAFT':[\s\S]*?'DRAFT',\s*'CALCULATION',\s*'IN_PRODUCTION',\s*'CANCELLED'/,
    );
    expect(src).toMatch(
      /case 'CALCULATION':[\s\S]*?'CALCULATION',\s*'IN_PRODUCTION',\s*'CANCELLED'/,
    );
  });

  test('в CALCULATION форма показывает текст про «потребность уже собрана»', () => {
    expect(src).toMatch(/потребность цеха уже собрана/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Manual-calculate endpoint остаётся (UI fallback в CALCULATION)
// ---------------------------------------------------------------------------

describe('Manual-calculate endpoint не удалён', () => {
  test('workshop-needs.order-controller.ts по-прежнему держит calculate-роут', () => {
    const src = read(
      'apps/api/src/modules/workshop-needs/workshop-needs.order-controller.ts',
    );
    expect(src).toMatch(/workshop-needs\/calculate/);
  });

  test('workshop-needs-card.tsx использует CalculateWorkshopNeedsForm как fallback', () => {
    const src = read('apps/web/components/orders/workshop-needs-card.tsx');
    expect(src).toMatch(/CalculateWorkshopNeedsForm/);
  });
});

// ---------------------------------------------------------------------------
// 8. Форма создания заказа — НЕ создаёт потребность сразу
// ---------------------------------------------------------------------------

describe('/admin/orders/new — НЕ создаёт потребность при создании', () => {
  test('createOrderAction НЕ вызывает calculate / startCalculation', () => {
    const src = read('apps/web/app/orders/actions.ts');
    // Изолируем тело функции `createOrderAction`: от его сигнатуры
    // до начала следующей экспортируемой функции
    // (`updateOrderAction`). В импортах файла `startCalculationOrder`
    // присутствует — это нормально (его использует
    // `startCalculationOrderAction`), но в теле create-action
    // его быть не должно.
    const startSig = 'export async function createOrderAction';
    const startIdx = src.indexOf(startSig);
    const endIdx = src.indexOf(
      'export async function updateOrderAction',
      startIdx,
    );
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const body = src.slice(startIdx, endIdx);
    expect(body).not.toMatch(/startCalculationOrder\b/);
    expect(body).not.toMatch(/calculateOrderWorkshopNeeds/);
  });

  test('форма создания не содержит автоматический trigger расчёта', () => {
    const src = read(
      'apps/web/app/admin/orders/new/admin-create-order-form.tsx',
    );
    expect(src).not.toMatch(/startCalculationOrderAction/);
    expect(src).not.toMatch(/calculateOrderWorkshopNeedsAction/);
  });
});
