/**
 * Smoke: выбор ячейки назначения в форме «Переместить» во вкладке
 * «Остатки» раздела `/admin/warehouses?tab=balances` (см.
 *  `apps/web/components/warehouses/stock/stock-transfer-dialog.tsx`,
 *  `apps/web/app/admin/warehouses/actions.ts::loadTransferDestinationCellsAction`,
 *  `apps/web/lib/passports-api.ts::listCells`,
 *  `apps/api/src/modules/passports/cells.controller.ts`,
 *  `apps/api/src/modules/passports/passports.service.ts::listCells`,
 *  `docs/current-state.md §«Перемещение остатка между складами»`).
 *
 * Статические проверки — не поднимают Nest и не ходят в БД.
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

const DIALOG =
  'apps/web/components/warehouses/stock/stock-transfer-dialog.tsx';
const ACTIONS = 'apps/web/app/admin/warehouses/actions.ts';
const PASSPORTS_API = 'apps/web/lib/passports-api.ts';
const CELLS_CONTROLLER =
  'apps/api/src/modules/passports/cells.controller.ts';
const PASSPORTS_SERVICE =
  'apps/api/src/modules/passports/passports.service.ts';
const STOCK_CONTROLLER = 'apps/api/src/modules/stock/stock.controller.ts';
const SIDEBAR = 'apps/web/components/admin-sidebar.tsx';
const SCHEMA = 'prisma/schema.prisma';

// ---------------------------------------------------------------------------
// 1. TransferDialog содержит поле «Ячейка назначения».
// ---------------------------------------------------------------------------

test('StockTransferDialog содержит поле «Ячейка назначения»', () => {
  const src = read(DIALOG);
  expect(src).toMatch(/Ячейка назначения/);
  expect(src).toMatch(/name="toCellId"/);
});

// ---------------------------------------------------------------------------
// 2. TransferDialog показывает «Без ячейки».
// ---------------------------------------------------------------------------

test('StockTransferDialog показывает вариант «Без ячейки»', () => {
  const src = read(DIALOG);
  expect(src).toMatch(/Без ячейки/);
});

// ---------------------------------------------------------------------------
// 3. Cells загружаются по warehouseId через server action.
// ---------------------------------------------------------------------------

test('TransferDialog загружает ячейки по warehouseId через loadTransferDestinationCellsAction', () => {
  const src = read(DIALOG);
  expect(src).toMatch(/loadTransferDestinationCellsAction\(toWarehouseId\)/);
});

test('actions.ts экспортирует loadTransferDestinationCellsAction', () => {
  const src = read(ACTIONS);
  expect(src).toMatch(
    /export async function loadTransferDestinationCellsAction/,
  );
  expect(src).toMatch(/listCells\(\{ warehouseId/);
});

test('passports-api listCells принимает warehouseId', () => {
  const src = read(PASSPORTS_API);
  expect(src).toMatch(/export function listCells\(query[\s\S]*?warehouseId/);
  expect(src).toMatch(/searchParams:\s*\{[\s\S]*?warehouseId/);
});

// ---------------------------------------------------------------------------
// 4. При выборе склада сбрасывается invalid toCellId.
// ---------------------------------------------------------------------------

test('При смене склада toCellId сбрасывается на пустую строку', () => {
  const src = read(DIALOG);
  // useEffect зависит от toWarehouseId и вызывает setToCellId('').
  expect(src).toMatch(/setToCellId\(''\)/);
  expect(src).toMatch(/\}, \[toWarehouseId\]\)/);
});

// ---------------------------------------------------------------------------
// 5. createStockTransfer отправляет toCellId, если выбран.
// ---------------------------------------------------------------------------

test('createStockTransferAction получает toCellId, когда ячейка выбрана', () => {
  const src = read(DIALOG);
  expect(src).toMatch(/\.\.\.\(toCellId \? \{ toCellId \} : \{\}\)/);
});

// ---------------------------------------------------------------------------
// 6. Backend GET /api/cells поддерживает warehouseId.
// ---------------------------------------------------------------------------

test('CellsController.list принимает warehouseId через ZodValidationPipe', () => {
  const src = read(CELLS_CONTROLLER);
  expect(src).toMatch(/ListCellsQuerySchema/);
  expect(src).toMatch(/warehouseId:\s*z\.string\(\)/);
  expect(src).toMatch(
    /this\.passports\.listCells\(\{\s*warehouseId:\s*query\.warehouseId\s*\}\)/,
  );
});

test('PassportsService.listCells принимает фильтр warehouseId', () => {
  const src = read(PASSPORTS_SERVICE);
  expect(src).toMatch(/async listCells\(filter[\s\S]*?warehouseId/);
  expect(src).toMatch(/where\.warehouseId\s*=\s*filter\.warehouseId/);
});

// ---------------------------------------------------------------------------
// 7. Не создана новая страница.
// ---------------------------------------------------------------------------

test('UI не создаёт новую страницу под выбор ячейки transfer', () => {
  expect(exists('apps/web/app/admin/stock-transfer')).toBe(false);
  expect(exists('apps/web/app/admin/warehouses/transfer')).toBe(false);
  expect(exists('apps/web/app/admin/warehouses/cell-selector')).toBe(false);
});

// ---------------------------------------------------------------------------
// 8. Sidebar не получил новых пунктов.
// ---------------------------------------------------------------------------

test('UI не добавляет sidebar item под cell selector', () => {
  const src = read(SIDEBAR);
  expect(src).not.toMatch(/'Ячейки'/);
  expect(src).not.toMatch(/href:\s*'\/admin\/cells'/);
});

// ---------------------------------------------------------------------------
// 9. Backend StockTransfer business rules не изменены.
// ---------------------------------------------------------------------------

test('StockController whitelist mutations не расширен', () => {
  const src = read(STOCK_CONTROLLER);
  expect(src).toMatch(/@Post\('adjustments'\)/);
  expect(src).toMatch(/@Post\('transfers'\)/);
  const otherPosts = src.match(
    /@Post\('(?!adjustments'|transfers')[^']+'\)/g,
  );
  expect(otherPosts).toBeNull();
});

// ---------------------------------------------------------------------------
// 10. Нет FIFO / LIFO / MaterialStockLot / master Material.
// ---------------------------------------------------------------------------

test('Нет FIFO / LIFO / MaterialStockLot / master Material', () => {
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  for (const path of [DIALOG, ACTIONS, PASSPORTS_API]) {
    const code = stripComments(read(path));
    expect(code).not.toMatch(/\bFIFO\b/);
    expect(code).not.toMatch(/\bLIFO\b/);
    expect(code).not.toMatch(/MaterialStockLot/);
  }
  const schema = read(SCHEMA);
  expect(schema).not.toMatch(/^model\s+MaterialStockLot\s*\{/m);
  expect(schema).not.toMatch(/^model\s+Material\s*\{/m);
});
