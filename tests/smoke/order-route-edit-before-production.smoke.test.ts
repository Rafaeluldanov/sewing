/**
 * Smoke-тест «Правка маршрута заказа до запуска производства».
 *
 * Холст правки маршрута (`RouteAmendmentTab`) перестал быть частью
 * только drawer-а «Изменить в производстве»: он же открывается кнопкой
 * «Изменить маршрут» в карточке «Маршрут операций» на вкладке
 * «Производство» — окно `ORDER_ROUTE_EDITABLE_STATUSES` (всё, кроме
 * `DONE`/`CANCELLED`).
 *
 * Полноценного React-рендерера в vitest нет (см.
 * `order-route-snapshot.smoke.test.ts`), поэтому фиксируем контракт
 * текстовыми проверками исходников. Стережём ровно те инварианты,
 * поломка которых тихая:
 *
 *   1. Окно правки задано ОДНИМ shared-предикатом, а не строковым
 *      сравнением статуса в каждом файле.
 *   2. Backend-гейт `applyRoute` ходит через тот же предикат.
 *   3. `Order.routeCustomizedAt` выключает ре-синк снимка из шаблона —
 *      иначе «Пересчитать план операций» молча вернул бы маршрут к
 *      шаблону (самая дорогая засада этой фичи).
 *   4. Флаг снимается ТОЛЬКО при осознанной смене шаблона, а не при
 *      любом сохранении формы заказа.
 *   5. План операций у заказа с ручным маршрутом считается по снимку.
 *   6. UI показывает расхождение «шаблон ≠ цепочка» пометкой.
 *   7. Причина правки обязательна только у запущенного заказа.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('shared — окно правки маршрута', () => {
  test('`ORDER_ROUTE_EDITABLE_STATUSES` перечисляет всё, кроме DONE/CANCELLED', () => {
    const src = readSrc('packages/shared/src/orders.ts');
    expect(src).toMatch(/export const ORDER_ROUTE_EDITABLE_STATUSES/);
    expect(src).toMatch(/export function isOrderRouteEditable/);
    const block = src.slice(
      src.indexOf('export const ORDER_ROUTE_EDITABLE_STATUSES'),
      src.indexOf('export function isOrderRouteEditable'),
    );
    for (const status of [
      'DRAFT',
      'CALCULATION',
      'CALCULATION_DONE',
      'SAMPLE_PRODUCTION',
      'IN_PRODUCTION',
    ]) {
      expect(block).toContain(`'${status}'`);
    }
    expect(block).not.toContain("'DONE'");
    expect(block).not.toContain("'CANCELLED'");
  });

  test('`isOrderStarted` отделяет режим с фронтом производства', () => {
    const src = readSrc('packages/shared/src/orders.ts');
    expect(src).toMatch(/export function isOrderStarted/);
  });

  test('причина правки маршрута не требуется схемой (её держит backend)', () => {
    const src = readSrc('packages/shared/src/amendments.ts');
    const schema = src.slice(
      src.indexOf('export const ApplyRouteAmendmentSchema'),
      src.indexOf('export type ApplyRouteAmendmentDto'),
    );
    expect(schema).toMatch(/reason:\s*z[\s\S]*?\.optional\(\)/);
    expect(schema).not.toMatch(/reason:\s*z[\s\S]*?\.min\(1/);
  });

  test('`OperationAmendmentStateDto` отдаёт `started` отдельным полем', () => {
    // Отличать по `frontierIndex === -1` нельзя: у только что
    // запущенного заказа паспортов ещё нет, а причина уже обязана быть.
    const src = readSrc('packages/shared/src/amendments.ts');
    const dto = src.slice(
      src.indexOf('export interface OperationAmendmentStateDto'),
      src.indexOf('/** Результат добавления операции. */'),
    );
    expect(dto).toMatch(/started:\s*boolean/);
  });
});

describe('api — гейт и производные правки маршрута', () => {
  test('`applyRoute` гейтит по `isOrderRouteEditable`, а не по IN_PRODUCTION', () => {
    const src = readSrc(
      'apps/api/src/modules/order-amendments/order-amendments.service.ts',
    );
    expect(src).toMatch(/import \{ isOrderRouteEditable, isOrderStarted \}/);
    expect(src).toMatch(/if \(!isOrderRouteEditable\(order\.status\)\)/);
    // Причина — только у запущенного заказа.
    expect(src).toMatch(/AMENDMENT_REASON_REQUIRED/);
    expect(src).toMatch(/if \(started && reason\.length === 0\)/);
  });

  test('`applyRoute` выставляет `routeCustomizedAt` и считает план узко', () => {
    const src = readSrc(
      'apps/api/src/modules/order-amendments/order-amendments.service.ts',
    );
    const fn = src.slice(
      src.indexOf('async applyRoute('),
      src.indexOf('// READ — журнал правок'),
    );
    expect(fn).toMatch(/data: \{ routeCustomizedAt: new Date\(\) \}/);
    // Материалы не пересобираем: окно включает CALCULATION_DONE, где
    // снимок уже отработан закупщиком.
    expect(fn).toMatch(/rebuildRouteDerivedSnapshotsInTx/);
    // Именно ВЫЗОВА нет (упоминание в комментарии — норма).
    expect(fn).not.toMatch(/await this\.orders\.rebuildQtyDerivedSnapshotsInTx/);
  });

  test('`syncOrderRouteStepsSnapshot` не трогает ручной маршрут', () => {
    // Без этого выхода первый же «Пересчитать план операций» вернул бы
    // маршрут к шаблону — правка исчезла бы молча.
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    const fn = src.slice(
      src.indexOf('private async syncOrderRouteStepsSnapshot'),
      src.indexOf('// OPERATION PLAN — manual recalculate'),
    );
    expect(fn).toMatch(/routeCustomizedAt: true/);
    expect(fn).toMatch(/if \(order\.routeCustomizedAt\)/);
  });

  test('флаг снимает только смена шаблона НА ДРУГОЙ', () => {
    // `wantsRouteChange` истинен и при повторной отправке того же id
    // (форма шлёт routeTemplateId всегда) — сбрасывать по нему нельзя.
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/const wantsRouteTemplateSwap =/);
    expect(src).toMatch(
      /\(dto\.routeTemplateId \?\? null\) !== \(current\.routeTemplateId \?\? null\)/,
    );
    expect(src).toMatch(
      /routeCustomizedAt: wantsRouteTemplateSwap \? null : undefined/,
    );
  });

  test('план операций у ручного маршрута считается по снимку', () => {
    const src = readSrc(
      'apps/api/src/modules/orders/order-operation-plan.service.ts',
    );
    const fn = src.slice(
      src.indexOf('async recalculateAndWrite('),
      src.indexOf('* Этап 2 «План операций на заказе» — stale-detection'),
    );
    expect(fn).toMatch(/routeCustomizedAt/);
    expect(fn).toMatch(/return this\.recalculateAndWriteFromSnapshot/);
  });

  test('stale-detection исключает шаблон из источников у ручного маршрута', () => {
    // Иначе правка шаблона в справочнике вешала бы вечный badge «план
    // устарел», который не снимается пересчётом.
    const src = readSrc(
      'apps/api/src/modules/orders/order-operation-plan.service.ts',
    );
    expect(src).toMatch(/const routeCustomized = order\.routeCustomizedAt != null/);
    expect(src).toMatch(/const templateUpdatedAt = routeCustomized\s*\?\s*null/);
    expect(src).toMatch(/routeTemplateUpdatedAt: Date \| null/);
  });

  test('Prisma-схема и миграция объявляют `routeCustomizedAt`', () => {
    expect(readSrc('prisma/schema.prisma')).toMatch(
      /routeCustomizedAt DateTime\?/,
    );
    expect(
      readSrc(
        'prisma/migrations/20260929100000_order_route_customized/migration.sql',
      ),
    ).toMatch(/ALTER TABLE "Order" ADD COLUMN "routeCustomizedAt"/);
  });
});

describe('web — кнопка «Изменить маршрут» и холст', () => {
  test('вкладка «Производство» грузит состояние маршрута по shared-предикату', () => {
    const src = readSrc(
      'apps/web/components/orders/view/tabs/order-production-tab.tsx',
    );
    expect(src).toMatch(/import \{ isOrderRouteEditable \}/);
    expect(src).toMatch(
      /if \(amendmentsEnabled && isOrderRouteEditable\(order\.status\)\)/,
    );
    // Количество/размерность остаются производственными.
    expect(src).toMatch(
      /if \(amendmentsEnabled && order\.status === 'IN_PRODUCTION'\)/,
    );
  });

  test('кнопка живёт в карточке «Маршрут операций»', () => {
    const src = readSrc(
      'apps/web/components/orders/view/tabs/order-production-tab.tsx',
    );
    expect(src).toMatch(/const routeEditAction =/);
    expect(src).toMatch(/label="Изменить маршрут"/);
    expect(src).toMatch(/testId="order-route-edit-button"/);
    // Именно в карточке маршрута, а не в матрице производства.
    const card = src.slice(
      src.indexOf('title="Маршрут операций"'),
      src.indexOf('title="Производство по размерам"'),
    );
    expect(card).toMatch(/routeEditAction/);
  });

  test('расхождение «шаблон ≠ цепочка» помечено в UI', () => {
    const src = readSrc(
      'apps/web/components/orders/view/tabs/order-production-tab.tsx',
    );
    expect(src).toMatch(/order\.routeCustomized &&/);
    expect(src).toMatch(/изменён в заказе/);
    expect(readSrc('packages/shared/src/orders.ts')).toMatch(
      /routeCustomized: boolean/,
    );
  });

  test('окно правки умеет режим «только маршрут»', () => {
    const dialog = readSrc(
      'apps/web/components/orders/amendments/order-amendment-dialog.tsx',
    );
    expect(dialog).toMatch(/quantityState: QuantityAmendmentStateDto \| null/);
    expect(dialog).toMatch(/sizeState: SizeAmendmentStateDto \| null/);
    expect(dialog).toMatch(/const hasTabs =/);
    // Заголовок приходит пропом: «Изменить заказ в производстве» на
    // DRAFT-заказе было бы враньём.
    expect(dialog).toMatch(/title: string/);

    const button = readSrc(
      'apps/web/components/orders/amendments/order-amendment-button.tsx',
    );
    expect(button).toMatch(/label: string/);
    expect(button).toMatch(/variant\?: 'full' \| 'route'/);
  });

  test('холст скрывает фронт и причину у незапущенного заказа', () => {
    const src = readSrc(
      'apps/web/components/orders/amendments/route-amendment-tab.tsx',
    );
    expect(src).toMatch(
      /const canSubmit = dirty && \(!state\.started \|\| reasonTrimmed\.length > 0\)/,
    );
    expect(src).toMatch(/\{state\.started \? \(/);
    expect(src).toMatch(/\{state\.started && \(/);
    // Прежний текст «правится только когда заказ в производстве» больше
    // не соответствует окну правки.
    expect(src).not.toMatch(/правится только когда заказ в производстве/);
  });
});
