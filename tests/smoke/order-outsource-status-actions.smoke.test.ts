/**
 * Smoke-тест MVP-3 (ADR-0022 §«Manual execution status»).
 *
 * Полноценного React-рендерера в vitest у нас нет — фиксируем
 * контракт UI ↔ backend ↔ shared текстовыми проверками исходников.
 * Покрытие:
 *
 *   1. Prisma schema объявляет enum `OrderOutsourceExecutionStatus`
 *      и три новые колонки на `OrderOutsourceRequirement`.
 *   2. Shared DTO содержит `executionStatus`, `orderedAt`,
 *      `receivedAt`, `displayStatus`, `displayStatusLabel` и Zod-схему
 *      `UpdateOrderOutsourceRequirementStatusSchema`.
 *   3. Backend service определяет `composeDisplayStatus` и метод
 *      `updateOutsourceRequirementStatus` с гардом CUT_READY.
 *   4. Backend controller вешает POST на
 *      `/orders/:id/outsource-requirements/:requirementId/status`.
 *   5. Web client-helper `updateOrderOutsourceRequirementStatus` есть
 *      в `apps/web/lib/orders-api.ts`.
 *   6. Web server-actions `markOutsourceRequirementOrderedAction` /
 *      `markOutsourceRequirementReceivedAction` есть в
 *      `apps/web/app/orders/actions.ts`.
 *   7. UI-компонент `OutsourceStatusActions` содержит обе подписи
 *      кнопок и условие показа (PLANNED/CUT_READY/READY_TO_ORDER/
 *      ORDERED).
 *   8. Карточка заказа подключает `OutsourceStatusActions` и читает
 *      все новые DTO-поля.
 *   9. `CUT_READY`-фразы из MVP-2 на месте (не сломали).
 *  10. Admin tech-card UI — не тронут (этот блок в MVP-3 без
 *      изменений).
 *  11. Карточка заказа всё ещё не содержит inline `<select>` для
 *      ручного выбора статуса (контракт «не ERP-форма»).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('schema — OrderOutsourceExecutionStatus + columns', () => {
  test('Prisma schema объявляет enum и три новые колонки', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(/enum OrderOutsourceExecutionStatus/);
    expect(src).toMatch(/\bPLANNED\b/);
    expect(src).toMatch(/\bORDERED\b/);
    expect(src).toMatch(/\bRECEIVED\b/);
    expect(src).toMatch(
      /executionStatus\s+OrderOutsourceExecutionStatus\s+@default\(PLANNED\)/,
    );
    expect(src).toMatch(/orderedAt\s+DateTime\?/);
    expect(src).toMatch(/receivedAt\s+DateTime\?/);
  });

  test('migration файл существует и additive', () => {
    const src = readSrc(
      'prisma/migrations/20260428100000_outsource_execution_status/migration.sql',
    );
    expect(src).toMatch(/CREATE TYPE "OrderOutsourceExecutionStatus"/);
    expect(src).toMatch(/ADD COLUMN "executionStatus"/);
    expect(src).toMatch(/ADD COLUMN "orderedAt"/);
    expect(src).toMatch(/ADD COLUMN "receivedAt"/);
    // Никаких DROP-ов и ALTER...DROP в миграции (additive-only).
    expect(src).not.toMatch(/DROP\s+COLUMN/);
    expect(src).not.toMatch(/DROP\s+TABLE/);
  });
});

describe('shared DTO — execution + display status', () => {
  test('orders.ts содержит enum, Zod-schema и поля DTO', () => {
    const src = readSrc('packages/shared/src/orders.ts');
    expect(src).toMatch(/ORDER_OUTSOURCE_EXECUTION_STATUSES/);
    expect(src).toMatch(/OrderOutsourceExecutionStatus/);
    expect(src).toMatch(/UpdateOrderOutsourceRequirementStatusSchema/);
    // Zod enum в action-схеме намеренно ограничен ORDERED/RECEIVED
    // (PLANNED через action не разрешаем).
    expect(src).toMatch(/z\.enum\(\['ORDERED',\s*'RECEIVED'\]\)/);
    // Новые поля DTO.
    expect(src).toMatch(/executionStatus:\s*OrderOutsourceExecutionStatus/);
    expect(src).toMatch(/orderedAt:\s*string \| null/);
    expect(src).toMatch(/receivedAt:\s*string \| null/);
    expect(src).toMatch(/displayStatus:\s*OrderOutsourceDisplayStatus/);
    expect(src).toMatch(/displayStatusLabel:\s*string \| null/);
  });
});

describe('backend — orders.service composes display + transitions', () => {
  test('composeDisplayStatus покрывает все 4 ветки', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/function composeDisplayStatus/);
    expect(src).toMatch(/'RECEIVED'.*'Получено'/s);
    expect(src).toMatch(/'ORDERED'.*'Заказано'/s);
    expect(src).toMatch(/'READY_TO_ORDER'.*'Готово к заказу'/s);
    expect(src).toMatch(/'Ожидает размещения кроя'/);
  });

  test('updateOutsourceRequirementStatus с CUT_READY-гардом и timestamps', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/updateOutsourceRequirementStatus/);
    expect(src).toMatch(/OrderOutsourceRequirementNotFoundException/);
    expect(src).toMatch(/OrderOutsourceRequirementInvalidTransitionException/);
    expect(src).toMatch(/OrderOutsourceRequirementNotReadyException/);
    // CUT_READY-guard: проверяем `currentCellId !== null` и
    // `passports.length > 0` ровно в этом методе тоже.
    expect(src).toMatch(/triggerType === 'CUT_READY'/);
    // orderedAt при ORDERED: «если был пуст — выставляем».
    expect(src).toMatch(/orderedAt:\s*requirement\.orderedAt\s*\?\?/);
    expect(src).toMatch(/receivedAt:\s*new Date\(\)/);
  });

  test('start() кладёт executionStatus=PLANNED в snapshot', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(
      /executionStatus:\s*OrderOutsourceExecutionStatus\.PLANNED/,
    );
  });
});

describe('backend — controller exposes status action endpoint', () => {
  test('POST /orders/:id/outsource-requirements/:requirementId/status зарегистрирован', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.controller.ts');
    expect(src).toMatch(
      /Post\(\s*':id\/outsource-requirements\/:requirementId\/status'/,
    );
    expect(src).toMatch(/UpdateOrderOutsourceRequirementStatusSchema/);
  });

  test('errors.ts содержит три новых business-exception класса', () => {
    const src = readSrc('apps/api/src/common/errors.ts');
    expect(src).toMatch(/OrderOutsourceRequirementNotFoundException/);
    expect(src).toMatch(/OrderOutsourceRequirementInvalidTransitionException/);
    expect(src).toMatch(/OrderOutsourceRequirementNotReadyException/);
    expect(src).toMatch(/'OUTSOURCE_REQUIREMENT_NOT_FOUND'/);
    expect(src).toMatch(/'OUTSOURCE_REQUIREMENT_INVALID_TRANSITION'/);
    expect(src).toMatch(/'OUTSOURCE_NOT_READY_TO_ORDER'/);
  });
});

describe('web — orders-api client + server actions', () => {
  test('orders-api.ts экспортирует updateOrderOutsourceRequirementStatus', () => {
    const src = readSrc('apps/web/lib/orders-api.ts');
    expect(src).toMatch(/updateOrderOutsourceRequirementStatus/);
    expect(src).toMatch(/outsource-requirements/);
    expect(src).toMatch(/method:\s*'POST'/);
    expect(src).toMatch(/body:\s*\{\s*executionStatus\s*\}/);
  });

  test('actions.ts экспортирует обе server-action функции', () => {
    const src = readSrc('apps/web/app/orders/actions.ts');
    expect(src).toMatch(/markOutsourceRequirementOrderedAction/);
    expect(src).toMatch(/markOutsourceRequirementReceivedAction/);
    // оба после успеха revalidatePath конкретного заказа
    expect(src).toMatch(/revalidatePath\(`\/orders\/\$\{orderId\}`\)/);
    // и оба используют 'ORDERED' / 'RECEIVED' напрямую (никаких
    // generic transition-форм)
    expect(src).toMatch(/'ORDERED'/);
    expect(src).toMatch(/'RECEIVED'/);
  });
});

describe('web — UI buttons component + page wiring', () => {
  test('OutsourceStatusActions содержит обе подписи кнопок и логику показа', () => {
    const src = readSrc(
      'apps/web/app/orders/[id]/outsource-status-actions.tsx',
    );
    expect(src).toMatch(/'use client'/);
    expect(src).toMatch(/Отметить как заказано/);
    expect(src).toMatch(/Отметить как получено/);
    // Кнопка ORDERED скрыта для CUT_READY+!isReadyToOrder и
    // показывается для READY_TO_ORDER:
    expect(src).toMatch(/READY_TO_ORDER/);
    expect(src).toMatch(/isReadyToOrder/);
    expect(src).toMatch(/displayStatus === 'PLANNED'/);
    expect(src).toMatch(/displayStatus === 'ORDERED'/);
    // Никаких dropdown/select/inline-input в action-компоненте.
    // Чистим JSDoc-комментарии перед проверкой, чтобы не реагировать
    // на «Сознательно нет `<select>`» в шапке.
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(noComments).not.toMatch(/<select[\s>]/);
    expect(noComments).not.toMatch(/<input[\s>]/);
  });

  test('страница заказа подключает OutsourceStatusActions с RBAC-флагом', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/OutsourceStatusActions/);
    // прокидываем canManage = isManager (роль)
    expect(src).toMatch(/canManage=\{isManager\}/);
    // page читает displayStatus / displayStatusLabel / orderedAt / receivedAt
    expect(src).toMatch(/displayStatusLabel/);
    expect(src).toMatch(/displayStatus/);
    expect(src).toMatch(/orderedAt/);
    expect(src).toMatch(/receivedAt/);
  });

  test('CUT_READY-фразы MVP-2 на месте (regression)', () => {
    const page = readSrc('apps/web/app/orders/[id]/page.tsx');
    // Фразы перенесены в displayStatusLabel, который backend
    // композитит — но «Ожидает размещения кроя» всё ещё показывается
    // через общую заметку над списком CUT_READY-строк.
    expect(page).toMatch(
      /Часть внешних потребностей станет доступна после размещения\s+кроя в ячейки/,
    );
  });

  test('admin tech-card form НЕ тронута MVP-3 (нет executionStatus в admin)', () => {
    // Контракт MVP-3: ручной статус живёт только на snapshot заказа,
    // в шаблоне его нет. Admin-форма техкарт должна остаться как
    // была (только triggerType-select из MVP-2).
    const src = readSrc('apps/web/app/admin/tech-cards/tech-card-form.tsx');
    expect(src).not.toMatch(/executionStatus/);
    expect(src).not.toMatch(/displayStatus/);
    expect(src).not.toMatch(/Отметить как заказано/);
  });

  test('страница заказа НЕ содержит inline <select> для ручной смены статуса', () => {
    // Контракт «не ERP-форма»: выбор «нового статуса» через
    // dropdown сознательно не делается, только узкие кнопки.
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).not.toMatch(/<select[^>]*executionStatus/);
    expect(src).not.toMatch(/<select[^>]*displayStatus/);
  });
});
