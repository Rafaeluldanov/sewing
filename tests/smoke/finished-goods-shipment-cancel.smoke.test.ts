/**
 * Smoke: отмена отгрузки готовой продукции (см.
 * `prisma/schema.prisma::FinishedGoodsShipment`,
 * `apps/api/src/modules/finished-goods/finished-goods.service.ts::cancelShipment`,
 * `apps/api/src/modules/finished-goods/finished-goods.controller.ts`,
 * `apps/web/components/orders/finished-goods/cancel-finished-goods-shipment-button.tsx`,
 * `apps/web/components/orders/finished-goods/finished-goods-shipments-table.tsx`,
 * `docs/current-state.md §«Отгрузка готовой продукции»`,
 * `docs/api.md §«Finished goods shipments»`).
 *
 * Бизнес-решение владельца проекта: НЕ создавать отдельную модель
 * `FinishedGoodsShipmentReturn` / `FinishedGoodsShipmentCancel`.
 * Существующий `FinishedGoodsShipment` получает `status = CANCELLED`
 * + `cancelledAt` / `cancelledById` / `cancelReason`; по каждой
 * строке создаётся обратное `FinishedGoodsMovement` REVERSAL IN
 * (`sourceKey = FINISHED_GOODS_SHIPMENT_CANCEL_LINE:<lineId>`);
 * `FinishedGoodsBalance` атомарно увеличивается обратно.
 *
 * Статические проверки — не поднимают Nest и не ходят в БД.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

const SCHEMA = 'prisma/schema.prisma';
const MIGRATION_DIR =
  'prisma/migrations/20260618100000_finished_goods_shipment_cancel';
const FG_CONSTANTS =
  'apps/api/src/modules/finished-goods/finished-goods.constants.ts';
const FG_SERVICE =
  'apps/api/src/modules/finished-goods/finished-goods.service.ts';
const FG_CONTROLLER =
  'apps/api/src/modules/finished-goods/finished-goods.controller.ts';
const FG_DTO =
  'apps/api/src/modules/finished-goods/dto/cancel-finished-goods-shipment.dto.ts';
const AUDIT_SERVICE = 'apps/api/src/modules/audit/audit.service.ts';

const FG_API = 'apps/web/lib/finished-goods-api.ts';
const ACTIONS =
  'apps/web/app/admin/orders/[id]/finished-goods-shipments-actions.ts';
const SHIPMENTS_TABLE =
  'apps/web/components/orders/finished-goods/finished-goods-shipments-table.tsx';
const CANCEL_BUTTON =
  'apps/web/components/orders/finished-goods/cancel-finished-goods-shipment-button.tsx';

const SIDEBAR = 'apps/web/components/admin-sidebar.tsx';
const TYPE_BADGE =
  'apps/web/components/warehouses/stock/stock-movement-type-badge.tsx';

const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const MATERIAL_ISSUES_SERVICE =
  'apps/api/src/modules/material-issues/material-issues.service.ts';

// ---------------------------------------------------------------------------
// 1. Prisma fields
// ---------------------------------------------------------------------------

describe('Prisma — FinishedGoodsShipment расширен полями отмены', () => {
  test('1. cancelledAt / cancelledById / cancelReason есть в schema', () => {
    const schema = readSrc(SCHEMA);
    const model = schema.match(/^model\s+FinishedGoodsShipment\s*\{[\s\S]*?\n\}/m)?.[0];
    expect(model).toBeTruthy();
    expect(model!).toMatch(/cancelledAt\s+DateTime\?/);
    expect(model!).toMatch(/cancelledById\s+String\?/);
    expect(model!).toMatch(/cancelReason\s+String\?/);
  });

  test('migration directory exists и добавляет колонки', () => {
    expect(exists(MIGRATION_DIR)).toBe(true);
    expect(exists(`${MIGRATION_DIR}/migration.sql`)).toBe(true);
    const sql = readSrc(`${MIGRATION_DIR}/migration.sql`);
    expect(sql).toMatch(/ADD COLUMN "cancelledAt"/);
    expect(sql).toMatch(/ADD COLUMN "cancelledById"/);
    expect(sql).toMatch(/ADD COLUMN "cancelReason"/);
  });

  test('Новых моделей FinishedGoodsShipmentReturn / Cancel НЕ создано', () => {
    const schema = readSrc(SCHEMA);
    expect(schema).not.toMatch(/^model\s+FinishedGoodsShipmentReturn\s*\{/m);
    expect(schema).not.toMatch(/^model\s+FinishedGoodsShipmentCancel\s*\{/m);
  });
});

// ---------------------------------------------------------------------------
// 2. Cancel DTO
// ---------------------------------------------------------------------------

describe('DTO отмены отгрузки', () => {
  test('2. cancel-finished-goods-shipment.dto.ts существует и валидирует reason', () => {
    expect(exists(FG_DTO)).toBe(true);
    const src = readSrc(FG_DTO);
    expect(src).toMatch(/CancelFinishedGoodsShipmentSchema/);
    expect(src).toMatch(/reason:\s*z\.string\(\)\.trim\(\)\.min\(2\)\.max\(500\)/);
    expect(src).toMatch(/\.strict\(\)/);
    // Никаких lines / qty / clientRequestId — частичная отмена не
    // поддерживается на этой итерации. Допускаем упоминание этих
    // ключей только в JSDoc-комментариях.
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    const code = stripComments(src);
    expect(code).not.toMatch(/lines:/);
    expect(code).not.toMatch(/clientRequestId/);
  });
});

// ---------------------------------------------------------------------------
// 3. API endpoint
// ---------------------------------------------------------------------------

describe('API endpoint POST /api/finished-goods/shipments/:id/cancel', () => {
  test('3. контроллер выставляет POST shipments/:id/cancel под ADMIN/SHOP_MANAGER', () => {
    const src = readSrc(FG_CONTROLLER);
    expect(src).toMatch(/@Post\('shipments\/:id\/cancel'\)/);
    // Декоратор @Roles живёт на классе.
    expect(src).toMatch(/@Roles\('ADMIN',\s*'SHOP_MANAGER'\)/);
    expect(src).toMatch(/cancelShipment\(/);
    expect(src).toMatch(/CancelFinishedGoodsShipmentSchema/);
    // DELETE / отдельный return endpoint не появились.
    expect(src).not.toMatch(/@Delete/);
    expect(src).not.toMatch(/finished-goods-shipment-returns/);
  });
});

// ---------------------------------------------------------------------------
// 4–8. Service — cancelShipment
// ---------------------------------------------------------------------------

describe('FinishedGoodsService.cancelShipment', () => {
  test('4. метод cancelShipment экспортирован', () => {
    const src = readSrc(FG_SERVICE);
    expect(src).toMatch(/async cancelShipment\(/);
  });

  test('5. cancelShipment обновляет status в CANCELLED + cancelledAt/cancelledById/cancelReason', () => {
    const src = readSrc(FG_SERVICE);
    expect(src).toMatch(/status:\s*'CANCELLED'/);
    expect(src).toMatch(/cancelledAt,?$/m);
    expect(src).toMatch(/cancelledById:\s*employeeId/);
    expect(src).toMatch(/cancelReason:\s*reason/);
  });

  test('6. cancelShipment создаёт REVERSAL IN с правильным sourceKey', () => {
    const src = readSrc(FG_SERVICE);
    expect(src).toMatch(/FINISHED_GOODS_MOVEMENT_TYPE\.REVERSAL/);
    expect(src).toMatch(/FINISHED_GOODS_MOVEMENT_DIRECTION\.IN/);
    expect(src).toMatch(/buildFinishedGoodsShipmentCancelLineSourceKey/);
    expect(src).toMatch(
      /sourceType:[\s\n]+FINISHED_GOODS_SOURCE_TYPE\.FINISHED_GOODS_SHIPMENT_CANCEL_LINE/,
    );
  });

  test('7. sourceKey формат FINISHED_GOODS_SHIPMENT_CANCEL_LINE:<lineId>', () => {
    const constants = readSrc(FG_CONSTANTS);
    expect(constants).toMatch(/FINISHED_GOODS_SHIPMENT_CANCEL_LINE/);
    const builder = constants.match(
      /export function buildFinishedGoodsShipmentCancelLineSourceKey[\s\S]*?\n\}/,
    )?.[0];
    expect(builder).toBeTruthy();
    expect(builder!).toMatch(/FINISHED_GOODS_SHIPMENT_CANCEL_LINE.*\$\{shipmentLineId\}/s);
  });

  test('8. idempotency: повторный cancel возвращает existing detail', () => {
    const src = readSrc(FG_SERVICE);
    // Проверка status === CANCELLED → return toShipmentDetailDto(...)
    expect(src).toMatch(
      /shipment\.status\s*===\s*'CANCELLED'[\s\S]*?return toShipmentDetailDto\(shipment\)/,
    );
  });

  test('cancelShipment не создаёт новых документов / моделей', () => {
    const src = readSrc(FG_SERVICE);
    // Никаких finishedGoodsShipmentReturn / finishedGoodsShipmentCancel.
    expect(src).not.toMatch(/finishedGoodsShipmentReturn/);
    expect(src).not.toMatch(/finishedGoodsShipmentCancel\b\./);
    // Никаких новых finishedGoodsShipment.create вызовов внутри cancel-метода
    // (создаётся только REVERSAL movement через applyMovementInTx).
    const fn = src.match(/async cancelShipment[\s\S]*?\n  \}/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).not.toMatch(/finishedGoodsShipment\.create/);
  });

  test('Order.status автоматически НЕ меняется', () => {
    const src = readSrc(FG_SERVICE);
    const fn = src.match(/async cancelShipment[\s\S]*?\n  \}/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).not.toMatch(/\.order\.update\(/);
    expect(fn!).not.toMatch(/orders\.update\(/);
    expect(fn!).not.toMatch(/'DONE'/);
  });

  test('cancelShipment бросает 409 для статуса не POSTED', () => {
    const src = readSrc(FG_SERVICE);
    expect(src).toMatch(/FINISHED_GOODS_SHIPMENT_INVALID_STATUS/);
  });
});

// ---------------------------------------------------------------------------
// 9. Audit + DTO response
// ---------------------------------------------------------------------------

describe('Audit FINISHED_GOODS_SHIPMENT_CANCELLED', () => {
  test('AuditEntityType FINISHED_GOODS_SHIPMENT упоминает CANCELLED event', () => {
    const src = readSrc(AUDIT_SERVICE);
    expect(src).toMatch(/FINISHED_GOODS_SHIPMENT_CANCELLED/);
  });

  test('cancelShipment пишет audit в той же транзакции', () => {
    const src = readSrc(FG_SERVICE);
    expect(src).toMatch(/event:\s*'FINISHED_GOODS_SHIPMENT_CANCELLED'/);
    expect(src).toMatch(/this\.audit\.log\(\s*\{/);
    // audit.log({...}, tx) — финальный аргумент tx.
    expect(src).toMatch(/\},\s*tx,?\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// 10. Detail / response не отдаёт sourceKey
// ---------------------------------------------------------------------------

describe('Detail DTO расширен полями отмены и не отдаёт sourceKey', () => {
  test('FinishedGoodsShipmentDetailDto имеет cancelledAt / cancelledById / cancelReason', () => {
    const src = readSrc(FG_SERVICE);
    const dto = src.match(
      /export interface FinishedGoodsShipmentDetailDto[\s\S]*?\n\}/,
    )?.[0];
    expect(dto).toBeTruthy();
    expect(dto!).toMatch(/cancelledAt:\s*string \| null/);
    expect(dto!).toMatch(/cancelledById:\s*string \| null/);
    expect(dto!).toMatch(/cancelReason:\s*string \| null/);
  });

  test('toShipmentDetailDto не пишет sourceKey в return', () => {
    const src = readSrc(FG_SERVICE);
    const mapper = src.match(/function toShipmentDetailDto[\s\S]*?\n\}/)?.[0];
    expect(mapper).toBeTruthy();
    expect(mapper!).not.toMatch(/sourceKey:/);
  });

  test('Frontend wrapper типы знают про cancelledAt / cancelReason', () => {
    const src = readSrc(FG_API);
    expect(src).toMatch(/cancelledAt:\s*string \| null/);
    expect(src).toMatch(/cancelReason:\s*string \| null/);
    expect(src).toMatch(/cancelFinishedGoodsShipment\(/);
  });
});

// ---------------------------------------------------------------------------
// 11. Material stock / MaterialIssue не затрагиваются
// ---------------------------------------------------------------------------

describe('Material stock / MaterialIssue не меняются', () => {
  test('StockService backend не получил cancel-shipment логики', () => {
    const src = readSrc(STOCK_SERVICE);
    expect(src).not.toMatch(/cancelShipment/);
    expect(src).not.toMatch(/FinishedGoodsShipment/);
  });

  test('MaterialIssuesService не получил cancel-shipment логики', () => {
    const src = readSrc(MATERIAL_ISSUES_SERVICE);
    expect(src).not.toMatch(/FinishedGoodsShipment/);
    expect(src).not.toMatch(/SHIPMENT/);
  });

  test('cancelShipment не импортирует StockService / MaterialIssue', () => {
    const src = readSrc(FG_SERVICE);
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    const code = stripComments(src);
    expect(code).not.toMatch(/StockService/);
    expect(code).not.toMatch(/MaterialIssue/);
    expect(code).not.toMatch(/CostsService/);
    expect(code).not.toMatch(/ProductionCostV2Service/);
  });
});

// ---------------------------------------------------------------------------
// 12. UI (table + cancel button) + sidebar/page invariants
// ---------------------------------------------------------------------------

describe('UI — кнопка «Отменить» в существующем блоке отгрузок', () => {
  test('table показывает «Отменить» для POSTED и не показывает для CANCELLED', () => {
    const src = readSrc(SHIPMENTS_TABLE);
    expect(src).toMatch(/CancelFinishedGoodsShipmentButton/);
    // Условие: только для status === 'POSTED'.
    expect(src).toMatch(/s\.status !== 'POSTED'/);
    // Бейдж «Отменена» для CANCELLED.
    expect(src).toMatch(/'CANCELLED'/);
    expect(src).toMatch(/Отменена/);
    // canManage скрывает кнопку для не-менеджеров.
    expect(src).toMatch(/canManage/);
  });

  test('cancel button содержит textarea reason 2..500 + предупреждение', () => {
    const src = readSrc(CANCEL_BUTTON);
    expect(src).toMatch(/name="reason"/);
    expect(src).toMatch(/minLength=\{2\}/);
    expect(src).toMatch(/maxLength=\{500\}/);
    // Текст предупреждения присутствует.
    expect(src).toMatch(/Отмена вернёт/);
    expect(src).toMatch(/«Отменена»/);
    // Кнопка-триггер «Отменить».
    expect(src).toMatch(/Отменить/);
    // Submit «Отменить отгрузку», ghost «Закрыть».
    expect(src).toMatch(/Отменить отгрузку/);
    expect(src).toMatch(/Закрыть/);
  });

  test('cancel UI сохранён в существующем разделе (карточка заказа)', () => {
    // Нет /admin/finished-goods, /admin/shipments, отдельной страницы
    // /shipments/[id], нет shipment-cancel-page.
    expect(exists('apps/web/app/admin/finished-goods')).toBe(false);
    expect(exists('apps/web/app/admin/shipments')).toBe(false);
    expect(exists('apps/web/app/admin/shipment-cancels')).toBe(false);
  });

  test('Sidebar не получил новый пункт под cancel/отмену', () => {
    const src = readSrc(SIDEBAR);
    expect(src).not.toMatch(/finished-goods/);
    expect(src).not.toMatch(/shipment-cancel/);
    expect(src).not.toMatch(/Отмен[аы]\s+отгрузки/);
  });

  test('Server action cancelFinishedGoodsShipmentAction экспортирован', () => {
    const src = readSrc(ACTIONS);
    expect(src).toMatch(/cancelFinishedGoodsShipmentAction/);
    expect(src).toMatch(/cancelFinishedGoodsShipment\(/);
    expect(src).toMatch(/revalidateOrder\(orderId\)/);
  });
});

// ---------------------------------------------------------------------------
// 13. Warehouse movements label REVERSAL = «Сторно»
// ---------------------------------------------------------------------------

describe('REVERSAL label «Сторно» сохранён', () => {
  test('REVERSAL → «Сторно» остаётся в badge словаре', () => {
    const src = readSrc(TYPE_BADGE);
    expect(src).toMatch(/REVERSAL:\s*\{\s*label:\s*'Сторно'/);
  });
});
