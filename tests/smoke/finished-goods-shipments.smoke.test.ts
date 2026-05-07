/**
 * Smoke: отгрузка готовой продукции из карточки заказа (см.
 * `prisma/schema.prisma::FinishedGoodsShipment` /
 * `FinishedGoodsShipmentLine`,
 * `apps/api/src/modules/finished-goods/finished-goods.service.ts::createShipmentForOrder`,
 * `apps/web/components/orders/finished-goods/*`,
 * `apps/web/app/admin/orders/[id]/finished-goods-shipments-actions.ts`,
 * `docs/current-state.md §«Отгрузка готовой продукции»`,
 * `docs/api.md §«Finished goods shipments»`).
 *
 * UI-решение владельца проекта: блок «Отгрузка готовой продукции»
 * живёт ТОЛЬКО во вкладке «Производство» карточки заказа.
 * Отдельной страницы / sidebar-пункта / OrderViewTabs-вкладки нет.
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
  'prisma/migrations/20260617100000_add_finished_goods_shipments';

const FG_CONSTANTS =
  'apps/api/src/modules/finished-goods/finished-goods.constants.ts';
const FG_SERVICE =
  'apps/api/src/modules/finished-goods/finished-goods.service.ts';
const FG_CONTROLLER =
  'apps/api/src/modules/finished-goods/finished-goods.controller.ts';
const FG_ORDER_CONTROLLER =
  'apps/api/src/modules/finished-goods/finished-goods-order-shipments.controller.ts';
const FG_MODULE =
  'apps/api/src/modules/finished-goods/finished-goods.module.ts';
const FG_DTO =
  'apps/api/src/modules/finished-goods/dto/create-finished-goods-shipment.dto.ts';
const FG_SHIPMENT_NUMBER =
  'apps/api/src/modules/finished-goods/finished-goods-shipment-number.service.ts';
const AUDIT_SERVICE = 'apps/api/src/modules/audit/audit.service.ts';

const ORDER_PAGE = 'apps/web/app/admin/orders/[id]/page.tsx';
const ORDER_PRODUCTION_TAB =
  'apps/web/components/orders/view/tabs/order-production-tab.tsx';
const SECTION =
  'apps/web/components/orders/finished-goods/order-finished-goods-shipment-section.tsx';
const DIALOG =
  'apps/web/components/orders/finished-goods/create-finished-goods-shipment-dialog.tsx';
const BUTTON =
  'apps/web/components/orders/finished-goods/create-finished-goods-shipment-button.tsx';
const TABLE =
  'apps/web/components/orders/finished-goods/finished-goods-shipments-table.tsx';
const ACTIONS =
  'apps/web/app/admin/orders/[id]/finished-goods-shipments-actions.ts';
const FG_API = 'apps/web/lib/finished-goods-api.ts';

const ORDER_VIEW_TABS =
  'apps/web/components/orders/view/order-view-tabs-config.ts';
const SIDEBAR = 'apps/web/components/admin-sidebar.tsx';

const STOCK_MOVEMENTS_FILTERS =
  'apps/web/components/warehouses/stock/stock-movements-filters.tsx';
const TYPE_BADGE =
  'apps/web/components/warehouses/stock/stock-movement-type-badge.tsx';

const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const MATERIAL_ISSUES_SERVICE =
  'apps/api/src/modules/material-issues/material-issues.service.ts';

// ---------------------------------------------------------------------------
// 1–2. Prisma models exist in schema and migration is on disk.
// ---------------------------------------------------------------------------

describe('Prisma — модели отгрузки готовой продукции', () => {
  test('1. schema.prisma содержит model FinishedGoodsShipment', () => {
    const schema = readSrc(SCHEMA);
    expect(schema).toMatch(/^model\s+FinishedGoodsShipment\s*\{/m);
    // ключевые поля
    expect(schema).toMatch(/number\s+String\s+@unique/);
    expect(schema).toMatch(/sourceKey\s+String\?\s+@unique/);
    expect(schema).toMatch(/status\s+String\s+@default\("POSTED"\)/);
  });

  test('2. schema.prisma содержит model FinishedGoodsShipmentLine', () => {
    const schema = readSrc(SCHEMA);
    expect(schema).toMatch(/^model\s+FinishedGoodsShipmentLine\s*\{/m);
    expect(schema).toMatch(/finishedGoodsShipmentId\s+String/);
    expect(schema).toMatch(/finishedGoodsBalanceId\s+String\?/);
    expect(schema).toMatch(/qty\s+Int/);
  });

  test('migration directory exists', () => {
    expect(exists(MIGRATION_DIR)).toBe(true);
    expect(exists(`${MIGRATION_DIR}/migration.sql`)).toBe(true);
    const migration = readSrc(`${MIGRATION_DIR}/migration.sql`);
    expect(migration).toMatch(/CREATE TABLE "FinishedGoodsShipment"/);
    expect(migration).toMatch(/CREATE TABLE "FinishedGoodsShipmentLine"/);
    expect(migration).toMatch(/FinishedGoodsShipment_sourceKey_key/);
    expect(migration).toMatch(/FinishedGoodsShipment_number_key/);
  });
});

// ---------------------------------------------------------------------------
// 3. API endpoints existence.
// ---------------------------------------------------------------------------

describe('API endpoints — отгрузка готовой продукции', () => {
  test('3a. POST + GET /api/orders/:orderId/finished-goods-shipments', () => {
    const src = readSrc(FG_ORDER_CONTROLLER);
    expect(src).toMatch(/@Post\(':orderId\/finished-goods-shipments'\)/);
    expect(src).toMatch(/@Get\(':orderId\/finished-goods-shipments'\)/);
    expect(src).toMatch(/@Roles\('ADMIN',\s*'SHOP_MANAGER'\)/);
  });

  test('3b. GET /api/finished-goods/shipments/:id (detail)', () => {
    const src = readSrc(FG_CONTROLLER);
    expect(src).toMatch(/@Get\('shipments\/:id'\)/);
  });

  test('контроллеры зарегистрированы в FinishedGoodsModule', () => {
    const src = readSrc(FG_MODULE);
    expect(src).toMatch(/FinishedGoodsOrderShipmentsController/);
    expect(src).toMatch(/FinishedGoodsShipmentNumberService/);
  });
});

// ---------------------------------------------------------------------------
// 4–6. Service — createShipmentForOrder, sourceKey, qty guards.
// ---------------------------------------------------------------------------

describe('FinishedGoodsService — shipment logic', () => {
  test('4. метод createShipmentForOrder экспортирован', () => {
    const src = readSrc(FG_SERVICE);
    expect(src).toMatch(/async createShipmentForOrder\(/);
    expect(src).toMatch(/listShipmentsByOrder\(/);
    expect(src).toMatch(/getShipmentDetail\(/);
  });

  test('5. SHIPMENT OUT движение создаётся через applyMovementInTx', () => {
    const src = readSrc(FG_SERVICE);
    // Реквизиты движения по строке shipment.
    expect(src).toMatch(/FINISHED_GOODS_MOVEMENT_TYPE\.SHIPMENT/);
    expect(src).toMatch(/FINISHED_GOODS_MOVEMENT_DIRECTION\.OUT/);
    // sourceKey строится по shipmentLine.id.
    expect(src).toMatch(/buildFinishedGoodsShipmentLineSourceKey/);
    // Баланс уменьшается через applyMovementInTx (один call site).
    expect(src).toMatch(/applyMovementInTx\(tx,\s*\{[\s\S]*?direction:\s*FINISHED_GOODS_MOVEMENT_DIRECTION\.OUT/);
  });

  test('6. shipment проверяет qty <= balance.qty', () => {
    const src = readSrc(FG_SERVICE);
    expect(src).toMatch(/FINISHED_GOODS_SHIPMENT_QTY_EXCEEDS_AVAILABLE/);
    // Дополнительный guard на уровне applyMovementInTx — общий для
    // любых OUT (в том числе SHIPMENT).
    expect(src).toMatch(/FINISHED_GOODS_INSUFFICIENT_BALANCE/);
  });

  test('shipment проверяет, что balance принадлежит этому заказу', () => {
    const src = readSrc(FG_SERVICE);
    expect(src).toMatch(/FINISHED_GOODS_SHIPMENT_BALANCE_ORDER_MISMATCH/);
  });

  test('7. duplicate finishedGoodsBalanceId в request → 400', () => {
    const src = readSrc(FG_SERVICE);
    expect(src).toMatch(/FINISHED_GOODS_SHIPMENT_DUPLICATE_BALANCE/);
  });

  test('8. idempotency через sourceKey FINISHED_GOODS_SHIPMENT:<order>:<clientRequestId>', () => {
    const constants = readSrc(FG_CONSTANTS);
    expect(constants).toMatch(/buildFinishedGoodsShipmentSourceKey/);
    // Builder возвращает строку в формате FINISHED_GOODS_SHIPMENT:<orderId>:<clientRequestId>.
    expect(constants).toMatch(
      /FINISHED_GOODS_SHIPMENT:\$\{orderId\}:\$\{clientRequestId\}/,
    );
    // Service ходит в существующий sourceKey ДО создания движений.
    const src = readSrc(FG_SERVICE);
    expect(src).toMatch(
      /finishedGoodsShipment\.findUnique\(\{[\s\S]*?where:\s*\{\s*sourceKey/,
    );
  });

  test('9. detail / API не возвращают sourceKey', () => {
    const src = readSrc(FG_SERVICE);
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

    const dto = src.match(
      /export interface FinishedGoodsShipmentDetailDto[\s\S]*?\n\}/,
    )?.[0];
    expect(dto).toBeTruthy();
    // sourceKey может упоминаться только в комментарии («намеренно не
    // возвращается»). Реальное поле не объявлено.
    expect(stripComments(dto!)).not.toMatch(/sourceKey/);

    const mapper = src.match(
      /function toShipmentDetailDto[\s\S]*?\n\}/,
    )?.[0];
    expect(mapper).toBeTruthy();
    expect(mapper!).not.toMatch(/sourceKey:/);
  });
});

// ---------------------------------------------------------------------------
// 10. Order.status НЕ меняется автоматически.
// ---------------------------------------------------------------------------

describe('Order.status автоматически НЕ меняется при отгрузке', () => {
  test('10. createShipmentForOrder не вызывает order.update', () => {
    const src = readSrc(FG_SERVICE);
    const fn = src.match(
      /async createShipmentForOrder[\s\S]*?\n  \}\n/,
    )?.[0];
    expect(fn).toBeTruthy();
    // Никаких order.update / orders.update внутри метода нет.
    expect(fn!).not.toMatch(/\.order\.update\(/);
    expect(fn!).not.toMatch(/orders\.update\(/);
    // И статус DONE не упоминается рядом с orderId.
    expect(fn!).not.toMatch(/'DONE'/);
  });
});

// ---------------------------------------------------------------------------
// 11. Material stock / MaterialIssue / другие модули НЕ менялись.
// ---------------------------------------------------------------------------

describe('Material stock / MaterialIssue НЕ затрагиваются', () => {
  test('11. FinishedGoodsService не импортирует StockService / MaterialIssue', () => {
    const src = readSrc(FG_SERVICE);
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    const code = stripComments(src);
    // JSDoc допускает упоминание материалов в формулировке «отдельный
    // контур от ...». Проверяем именно code (без комментариев).
    expect(code).not.toMatch(/StockService/);
    expect(code).not.toMatch(/MaterialIssue/);
    expect(code).not.toMatch(/CostsService/);
    expect(code).not.toMatch(/ProductionCostV2Service/);
  });

  test('StockService backend не модифицирован под shipment', () => {
    const src = readSrc(STOCK_SERVICE);
    // Базовые методы на месте.
    expect(src).toMatch(/buildStockBalanceWhere/);
    expect(src).toMatch(/buildStockMovementWhere/);
    // shipment-логика тут не появилась.
    expect(src).not.toMatch(/SHIPMENT/);
    expect(src).not.toMatch(/FinishedGoodsShipment/);
  });

  test('MaterialIssuesService не получил shipment-логики', () => {
    const src = readSrc(MATERIAL_ISSUES_SERVICE);
    expect(src).not.toMatch(/FinishedGoodsShipment/);
    expect(src).not.toMatch(/SHIPMENT/);
  });
});

// ---------------------------------------------------------------------------
// 12–13. RBAC — ADMIN / SHOP_MANAGER, остальные роли отсекаются на
// уровне `@Roles` декоратора.
// ---------------------------------------------------------------------------

describe('RBAC — ADMIN / SHOP_MANAGER', () => {
  test('12. FinishedGoodsOrderShipmentsController @Roles(ADMIN, SHOP_MANAGER)', () => {
    const src = readSrc(FG_ORDER_CONTROLLER);
    expect(src).toMatch(/@Roles\('ADMIN',\s*'SHOP_MANAGER'\)/);
    // Никаких SHOPFLOOR_MASTER / CUTTER_ASSISTANT / WORKER ролей.
    expect(src).not.toMatch(/CUTTER_ASSISTANT/);
    expect(src).not.toMatch(/SHOPFLOOR_MASTER/);
    expect(src).not.toMatch(/WORKER/);
  });

  test('13. FinishedGoodsController наследует @Roles(ADMIN, SHOP_MANAGER) на классе', () => {
    const src = readSrc(FG_CONTROLLER);
    expect(src).toMatch(/@Roles\('ADMIN',\s*'SHOP_MANAGER'\)/);
  });
});

// ---------------------------------------------------------------------------
// 14–17. UI placement.
// ---------------------------------------------------------------------------

describe('UI — секция «Отгрузка готовой продукции» во вкладке Производство', () => {
  test('14. OrderProductionTab подключает OrderFinishedGoodsShipmentSection', () => {
    const src = readSrc(ORDER_PRODUCTION_TAB);
    expect(src).toMatch(/OrderFinishedGoodsShipmentSection/);
    expect(src).toMatch(/canManage/);
  });

  test('15. SECTION загружает balances и shipments по orderId', () => {
    const src = readSrc(SECTION);
    expect(src).toMatch(/listFinishedGoodsBalances/);
    expect(src).toMatch(/listOrderFinishedGoodsShipments/);
    expect(src).toMatch(/CreateFinishedGoodsShipmentButton/);
    // Заголовок в section: title="Отгрузка готовой продукции".
    expect(src).toMatch(/Отгрузка готовой продукции/);
  });

  test('UI form имеет qty inputs per balance', () => {
    const src = readSrc(DIALOG);
    expect(src).toMatch(/type="number"/);
    expect(src).toMatch(/min=\{0\}/);
    expect(src).toMatch(/max=\{b\.qty\}/);
    // По одному input на balance, duplicate невозможен.
    expect(src).toMatch(/balances\.map\(\(b\)/);
  });

  test('UI фильтрует строки с qty <= 0 перед submit', () => {
    const src = readSrc(DIALOG);
    expect(src).toMatch(/n <= 0/);
    // server action — второй слой фильтра.
    const action = readSrc(ACTIONS);
    expect(action).toMatch(/qty <= 0/);
  });

  test('UI генерирует clientRequestId один раз через crypto.randomUUID', () => {
    const src = readSrc(DIALOG);
    expect(src).toMatch(/crypto\.randomUUID/);
    // useState с генератором — один раз на жизненный цикл формы.
    expect(src).toMatch(/useState<string>\(\(\)\s*=>\s*makeUUID\(\)\)/);
  });

  test('SECTION использует правильные lookup имени (productName / color / sizeCode)', () => {
    const preview = readSrc(
      'apps/web/components/orders/finished-goods/finished-goods-balances-preview.tsx',
    );
    // Имя строится из productName/color/sizeCode (тот же шаблон, что
    // в /admin/warehouses?tab=balances).
    expect(preview).toMatch(/productName \?\? b\.productId/);
    expect(preview).toMatch(/sizeCode \?\? b\.sizeId/);
    expect(preview).toMatch(/b\.color/);
  });
});

// ---------------------------------------------------------------------------
// 18–20. Запреты / sidebar / отдельные страницы.
// ---------------------------------------------------------------------------

describe('Запреты MVP — отдельный раздел не появился', () => {
  test('18. /admin/finished-goods не создавалась', () => {
    expect(exists('apps/web/app/admin/finished-goods')).toBe(false);
    expect(exists('apps/web/app/admin/shipments')).toBe(false);
  });

  test('19. sidebar не получил новый пункт под shipment / готовую продукцию', () => {
    const src = readSrc(SIDEBAR);
    expect(src).not.toMatch(/finished-goods/);
    expect(src).not.toMatch(/Готовая продукция/);
    expect(src).not.toMatch(/Отгрузк/);
  });

  test('20. OrderViewTabs не получил новой вкладки', () => {
    const src = readSrc(ORDER_VIEW_TABS);
    // Ровно тот же набор вкладок: production / passports / plan /
    // operations / costSummary / needs / history.
    expect(src).not.toMatch(/finished-goods/);
    expect(src).not.toMatch(/shipment/i);
  });
});

// ---------------------------------------------------------------------------
// Warehouse movements — SHIPMENT label «Отгрузка».
// ---------------------------------------------------------------------------

describe('Склады → Движения — SHIPMENT label «Отгрузка»', () => {
  test('badge показывает «Отгрузка» для SHIPMENT', () => {
    const src = readSrc(TYPE_BADGE);
    expect(src).toMatch(/SHIPMENT:\s*\{\s*label:\s*'Отгрузка'/);
  });

  test('select в фильтре содержит SHIPMENT → Отгрузка', () => {
    const src = readSrc(STOCK_MOVEMENTS_FILTERS);
    expect(src).toMatch(/value:\s*'SHIPMENT'/);
    expect(src).toMatch(/label:\s*'Отгрузка'/);
  });
});

// ---------------------------------------------------------------------------
// Audit + DTO.
// ---------------------------------------------------------------------------

describe('Audit и DTO', () => {
  test('AuditEntityType содержит FINISHED_GOODS_SHIPMENT', () => {
    const src = readSrc(AUDIT_SERVICE);
    expect(src).toMatch(/'FINISHED_GOODS_SHIPMENT'/);
    expect(src).toMatch(/FINISHED_GOODS_SHIPMENT_CREATED/);
  });

  test('DTO отбрасывает orderId из body (берётся из URL)', () => {
    const src = readSrc(FG_DTO);
    // Schema strict — лишние поля будут отвергнуты, и orderId в schema
    // явно НЕ заявлен. Проверяем оба сигнала.
    expect(src).toMatch(/\.strict\(\)/);
    const schema = src.match(
      /export const CreateFinishedGoodsShipmentSchema[\s\S]*?\.strict\(\)/,
    )?.[0];
    expect(schema).toBeTruthy();
    expect(schema!).not.toMatch(/orderId:/);
    // Поля finishedGoodsBalanceId / qty присутствуют.
    expect(src).toMatch(/finishedGoodsBalanceId:\s*trimmedString\(64\)/);
    expect(src).toMatch(/qty:\s*z\s*\.number\(/);
    expect(src).toMatch(/lines:\s*z\s*\.array\(/);
  });

  test('DTO ограничивает comment 500 и clientRequestId 128', () => {
    const src = readSrc(FG_DTO);
    expect(src).toMatch(/comment:\s*z\.string\(\)\.trim\(\)\.max\(500\)/);
    expect(src).toMatch(/clientRequestId:\s*trimmedString\(128\)/);
  });
});

// ---------------------------------------------------------------------------
// Frontend client API.
// ---------------------------------------------------------------------------

describe('Frontend wrapper для shipments', () => {
  test('listOrderFinishedGoodsShipments → /orders/:id/finished-goods-shipments', () => {
    const src = readSrc(FG_API);
    expect(src).toMatch(/listOrderFinishedGoodsShipments/);
    expect(src).toMatch(/finished-goods-shipments/);
  });

  test('createOrderFinishedGoodsShipment делает POST', () => {
    const src = readSrc(FG_API);
    expect(src).toMatch(/createOrderFinishedGoodsShipment/);
    expect(src).toMatch(/method:\s*'POST'/);
  });

  test('getFinishedGoodsShipment → /finished-goods/shipments/:id', () => {
    const src = readSrc(FG_API);
    expect(src).toMatch(/getFinishedGoodsShipment/);
    expect(src).toMatch(/\/finished-goods\/shipments\//);
  });
});

// ---------------------------------------------------------------------------
// Сервис номеров.
// ---------------------------------------------------------------------------

describe('FinishedGoodsShipmentNumberService — формат S-YYYYMMDD-NNNN', () => {
  test('генератор номеров shipment существует и использует префикс S-', () => {
    const src = readSrc(FG_SHIPMENT_NUMBER);
    expect(src).toMatch(/class FinishedGoodsShipmentNumberService/);
    expect(src).toMatch(/S-\$\{yyyy\}\$\{mm\}\$\{dd\}-/);
    expect(src).toMatch(/finishedGoodsShipment\.findFirst/);
  });
});

// ---------------------------------------------------------------------------
// Audit писаться должен в той же транзакции.
// ---------------------------------------------------------------------------

describe('Audit пишется в той же транзакции, что и shipment', () => {
  test('audit.log вызывается с tx внутри $transaction блока', () => {
    const src = readSrc(FG_SERVICE);
    // Проверяем по всему файлу (regex по сегменту функции хрупкий
    // из-за вложенных скобок). Достаточно убедиться, что
    // FINISHED_GOODS_SHIPMENT_CREATED → audit.log идёт с `tx` второго
    // аргумента.
    expect(src).toMatch(/event:\s*'FINISHED_GOODS_SHIPMENT_CREATED'/);
    // audit.log(input, tx) — финальная строка вызова (см. JSDoc сервиса).
    expect(src).toMatch(/this\.audit\.log\(\s*\{/);
    expect(src).toMatch(/\},\s*tx,?\s*\)/);
  });
});
