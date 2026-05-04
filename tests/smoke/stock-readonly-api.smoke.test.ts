/**
 * Smoke: read-only API склада
 * (`GET /api/stock/balances`, `GET /api/stock/movements`,
 *  см. `apps/api/src/modules/stock/stock.controller.ts`,
 *  `apps/api/src/modules/stock/stock.service.ts::listBalances` /
 *  `listMovements`,
 *  `docs/api.md §«26a. Stock (read-only)»`,
 *  `docs/current-state.md §«Read-only API склада»`).
 *
 * Статические проверки — не поднимают Nest и не ходят в БД. Полные
 * сценарии живут в `tests/integration/stock-readonly-api.test.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

const repoRoot = join(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(join(repoRoot, rel));
}

const STOCK_CONTROLLER = 'apps/api/src/modules/stock/stock.controller.ts';
const STOCK_MODULE = 'apps/api/src/modules/stock/stock.module.ts';
const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const BALANCES_DTO =
  'apps/api/src/modules/stock/dto/list-stock-balances.dto.ts';
const MOVEMENTS_DTO =
  'apps/api/src/modules/stock/dto/list-stock-movements.dto.ts';

// ---------------------------------------------------------------------------
// Controller wiring
// ---------------------------------------------------------------------------

test('StockController существует и подключён к маршруту /stock', () => {
  expect(exists(STOCK_CONTROLLER)).toBe(true);
  const src = read(STOCK_CONTROLLER);
  expect(src).toMatch(/@Controller\('stock'\)/);
  expect(src).toMatch(/@Get\('balances'\)/);
  expect(src).toMatch(/@Get\('movements'\)/);
});

test('StockController защищён @Roles(\'ADMIN\', \'SHOP_MANAGER\')', () => {
  const src = read(STOCK_CONTROLLER);
  expect(src).toMatch(/@Roles\('ADMIN',\s*'SHOP_MANAGER'\)/);
});

test('StockController инжектит StockService и вызывает listBalances/listMovements', () => {
  const src = read(STOCK_CONTROLLER);
  expect(src).toMatch(/private\s+readonly\s+stock:\s*StockService/);
  expect(src).toMatch(/this\.stock\.listBalances\(/);
  expect(src).toMatch(/this\.stock\.listMovements\(/);
});

test('StockController использует ZodValidationPipe со схемами list*Query', () => {
  const src = read(STOCK_CONTROLLER);
  expect(src).toMatch(/ZodValidationPipe\(ListStockBalancesQuerySchema\)/);
  expect(src).toMatch(/ZodValidationPipe\(ListStockMovementsQuerySchema\)/);
});

test('StockModule регистрирует StockController', () => {
  const src = read(STOCK_MODULE);
  expect(src).toMatch(/controllers:\s*\[\s*StockController\s*\]/);
  expect(src).toMatch(/import\s+\{\s*StockController\s*\}\s+from/);
});

// ---------------------------------------------------------------------------
// DTO contract
// ---------------------------------------------------------------------------

test('Balances DTO содержит limit/offset и обязательные фильтры', () => {
  const src = read(BALANCES_DTO);
  // Pagination
  expect(src).toMatch(/limit:\s*z\.coerce\.number\(\)/);
  expect(src).toMatch(/offset:\s*z\.coerce\.number\(\)/);
  expect(src).toContain('.max(200)');
  // Точечные фильтры
  expect(src).toMatch(/workshopNeedId:/);
  expect(src).toMatch(/orderId:/);
  expect(src).toMatch(/warehouseId:/);
  expect(src).toMatch(/cellId:/);
  expect(src).toMatch(/materialRole:/);
  expect(src).toMatch(/unit:/);
  expect(src).toMatch(/q:/);
  // Mutually-exclusive флаги
  expect(src).toMatch(/positiveOnly:/);
  expect(src).toMatch(/negativeOnly:/);
  expect(src).toMatch(/zeroOnly:/);
  expect(src).toMatch(/superRefine/);
  // Текст ошибки взаимной несовместимости
  expect(src).toContain('взаимоисключающие');
});

test('Movements DTO содержит limit/offset, type/direction и фильтры по источнику', () => {
  const src = read(MOVEMENTS_DTO);
  expect(src).toMatch(/limit:\s*z\.coerce\.number\(\)/);
  expect(src).toMatch(/offset:\s*z\.coerce\.number\(\)/);
  expect(src).toContain('.max(200)');
  // type / direction enum-ы из stock.constants
  expect(src).toMatch(/type:\s*z\s*\.enum\(STOCK_MOVEMENT_TYPES/);
  expect(src).toMatch(/direction:\s*z\s*\.enum\(STOCK_MOVEMENT_DIRECTIONS/);
  // Фильтры по источнику документов
  for (const f of [
    'workshopNeedId',
    'orderId',
    'stockBalanceId',
    'warehouseId',
    'cellId',
    'sourceType',
    'sourceId',
    'purchaseReceiptId',
    'purchaseReceiptLineId',
    'materialIssueId',
    'materialIssueLineId',
    'from',
    'to',
    'q',
  ]) {
    expect(src).toMatch(new RegExp(`${f}:`));
  }
  // ISO datetime для дат
  expect(src).toMatch(/from:\s*z\.string\(\)\.datetime\(\)/);
  expect(src).toMatch(/to:\s*z\.string\(\)\.datetime\(\)/);
});

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

test('StockService.listBalances/listMovements возвращают { items, total, limit, offset }', () => {
  const src = read(STOCK_SERVICE);
  // listBalances
  const balancesBlock = src.match(
    /async listBalances\([\s\S]*?\n\s\s\}\n/,
  )?.[0];
  expect(balancesBlock).toBeTruthy();
  expect(balancesBlock!).toMatch(/items:/);
  expect(balancesBlock!).toMatch(/total/);
  expect(balancesBlock!).toMatch(/limit,/);
  expect(balancesBlock!).toMatch(/offset,/);
  expect(balancesBlock!).toMatch(/orderBy:\s*\[\{\s*updatedAt:\s*'desc'/);
  expect(balancesBlock!).toMatch(/description:\s*'asc'/);

  // listMovements
  const movementsBlock = src.match(
    /async listMovements\([\s\S]*?\n\s\s\}\n/,
  )?.[0];
  expect(movementsBlock).toBeTruthy();
  expect(movementsBlock!).toMatch(/items:/);
  expect(movementsBlock!).toMatch(/total/);
  expect(movementsBlock!).toMatch(/orderBy:\s*\[\{\s*createdAt:\s*'desc'/);
});

test('StockService отдаёт sourceKey НЕ в публичном response (только в комментарии)', () => {
  const src = read(STOCK_SERVICE);
  // Маппер `toStockMovementListItem` — не пишет sourceKey в return.
  const mapper = src.match(
    /function toStockMovementListItem[\s\S]*?\n\}\n/,
  )?.[0];
  expect(mapper).toBeTruthy();
  expect(mapper!).not.toMatch(/sourceKey:\s*row\.sourceKey/);
  // Но JSDoc/комментарий в маппере явно фиксирует решение.
  expect(mapper!).toContain('sourceKey');
});

test('StockService поддерживает orderId через relation workshopNeed.orderId', () => {
  const src = read(STOCK_SERVICE);
  // Both balances and movements where-builders должны иметь orderId
  // через relation `workshopNeed.orderId`.
  expect(src).toMatch(/workshopNeed:\s*\{\s*orderId:\s*query\.orderId\s*\}/);
});

test('StockService использует $transaction для пары findMany + count', () => {
  const src = read(STOCK_SERVICE);
  expect(src).toMatch(
    /this\.prisma\.\$transaction\(\[[\s\S]*?stockBalance\.findMany[\s\S]*?stockBalance\.count[\s\S]*?\]\)/,
  );
  expect(src).toMatch(
    /this\.prisma\.\$transaction\(\[[\s\S]*?stockMovement\.findMany[\s\S]*?stockMovement\.count[\s\S]*?\]\)/,
  );
});

// ---------------------------------------------------------------------------
// MVP-границы: единственная mutation — `POST /adjustments`
// ---------------------------------------------------------------------------

test('StockController имеет только одну mutation — POST /adjustments', () => {
  const src = read(STOCK_CONTROLLER);
  // Единственный разрешённый verb — `@Post('adjustments')`
  // (см. `apps/api/src/modules/stock/stock.controller.ts`).
  expect(src).toMatch(/@Post\('adjustments'\)/);
  // Запрещённых mutation-эндпоинтов больше нет.
  for (const verb of ['@Patch(', '@Put(', '@Delete(']) {
    expect(src).not.toContain(verb);
  }
  // И никаких других POST, кроме `adjustments`.
  const otherPosts = src.match(/@Post\('(?!adjustments')[^']+'\)/g);
  expect(otherPosts).toBeNull();
});

test('Нет публичных stock-страниц / роутов в web (foundation без UI)', () => {
  const suspects = [
    'apps/web/app/admin/stock/page.tsx',
    'apps/web/app/stock/page.tsx',
    'apps/web/app/admin/material-issues/page.tsx',
    'apps/web/app/admin/stock/balances/page.tsx',
    'apps/web/app/admin/stock/movements/page.tsx',
    'apps/web/app/stock/balances/page.tsx',
    'apps/web/app/stock/movements/page.tsx',
  ];
  for (const p of suspects) {
    expect(exists(p)).toBe(false);
  }
});

test('OrderViewTabs не упоминает новый stock-таб', () => {
  // Если файл существует — проверяем; иначе тест проходит (нет UI слоя).
  const candidates = [
    'apps/web/components/orders/order-view-tabs.tsx',
    'apps/web/app/admin/orders/[id]/order-view-tabs.tsx',
    'apps/web/app/orders/[id]/order-view-tabs.tsx',
  ];
  const found = candidates.find(exists);
  if (!found) return;
  const src = read(found);
  expect(src).not.toMatch(/stock-balances|stockBalances|StockBalances/i);
  expect(src).not.toMatch(/stock-movements|stockMovements|StockMovements/i);
});

test('Нет master-модели Material и нет MaterialStockLot (MVP-границы сохранены)', () => {
  const schema = read('prisma/schema.prisma');
  expect(schema).not.toMatch(/^model\s+Material\s*\{/m);
  expect(schema).not.toMatch(/model\s+MaterialStockLot/);
});

test('Нет FIFO/LIFO в StockService (MVP-границы сохранены)', () => {
  const src = read(STOCK_SERVICE);
  expect(src).not.toMatch(/FIFO\s*\(/);
  expect(src).not.toMatch(/LIFO\s*\(/);
  expect(src).not.toMatch(/fifoOrderBy|lifoOrderBy|fifoQueue|lifoQueue/i);
});

test('Новые роли (WAREHOUSE_MANAGER / PURCHASER / ACCOUNTANT) не введены', () => {
  const schema = read('prisma/schema.prisma');
  // В enum Role они не должны появляться.
  const roleEnum = schema.match(/enum\s+Role\s*\{[\s\S]*?\}/)?.[0] ?? '';
  expect(roleEnum).not.toMatch(/\bWAREHOUSE_MANAGER\b/);
  expect(roleEnum).not.toMatch(/\bPURCHASER\b/);
  expect(roleEnum).not.toMatch(/\bACCOUNTANT\b/);
  // В контроллере склада тоже нет упоминаний.
  const ctrl = read(STOCK_CONTROLLER);
  expect(ctrl).not.toMatch(/WAREHOUSE_MANAGER|PURCHASER|ACCOUNTANT/);
});

test('docs/api.md содержит раздел 26a Stock', () => {
  const apiDoc = read('docs/api.md');
  expect(apiDoc).toContain('## 26a. Stock');
  expect(apiDoc).toMatch(/GET\s*\|\s*`\/api\/stock\/balances`/);
  expect(apiDoc).toMatch(/GET\s*\|\s*`\/api\/stock\/movements`/);
  // Явно зафиксировано, что sourceKey не отдаётся.
  expect(apiDoc).toMatch(/sourceKey[\s\S]{0,80}не\s+отдаётся/);
});
