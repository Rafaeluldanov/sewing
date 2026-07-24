/**
 * Smoke: фильтры вкладок «Остатки» / «Движения» в существующем
 * разделе `/admin/warehouses` (см.
 *  `apps/web/app/admin/warehouses/page.tsx`,
 *  `apps/web/components/warehouses/stock/stock-balances-filters.tsx`,
 *  `apps/web/components/warehouses/stock/stock-movements-filters.tsx`,
 *  `apps/web/lib/stock-api.ts`,
 *  `docs/current-state.md §«Фильтры склада»`).
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

const PAGE = 'apps/web/app/admin/warehouses/page.tsx';
const STOCK_API = 'apps/web/lib/stock-api.ts';
const STOCK_PAGINATION =
  'apps/web/components/warehouses/stock/stock-pagination.tsx';
const BALANCES_FILTERS =
  'apps/web/components/warehouses/stock/stock-balances-filters.tsx';
const MOVEMENTS_FILTERS =
  'apps/web/components/warehouses/stock/stock-movements-filters.tsx';
const SIDEBAR = 'apps/web/components/admin-sidebar.tsx';
const SCHEMA = 'prisma/schema.prisma';
const STOCK_CONTROLLER = 'apps/api/src/modules/stock/stock.controller.ts';
const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';

// ---------------------------------------------------------------------------
// 1. / 2. Файлы фильтров существуют.
// ---------------------------------------------------------------------------

test('StockBalancesFilters компонент существует', () => {
  expect(exists(BALANCES_FILTERS)).toBe(true);
});

test('StockMovementsFilters компонент существует', () => {
  expect(exists(MOVEMENTS_FILTERS)).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. / 4. Page подключает фильтры в нужных вкладках.
// ---------------------------------------------------------------------------

test('warehouses/page.tsx подключает StockBalancesFilters во вкладку balances', () => {
  const src = read(PAGE);
  expect(src).toMatch(/StockBalancesFilters/);
  const balancesBlock = src.match(
    /async function BalancesTabPage[\s\S]*?\n\}\n/,
  )?.[0];
  expect(balancesBlock).toBeTruthy();
  expect(balancesBlock!).toMatch(/StockBalancesFilters/);
});

test('warehouses/page.tsx подключает StockMovementsFilters во вкладку movements', () => {
  const src = read(PAGE);
  expect(src).toMatch(/StockMovementsFilters/);
  const movementsBlock = src.match(
    /async function MovementsTabPage[\s\S]*?\n\}\n/,
  )?.[0];
  expect(movementsBlock).toBeTruthy();
  expect(movementsBlock!).toMatch(/StockMovementsFilters/);
});

// ---------------------------------------------------------------------------
// 5. Поля Balances filters: q / warehouseId / stockState.
// ---------------------------------------------------------------------------

test('StockBalancesFilters содержит поля q / warehouseId / stockState', () => {
  const src = read(BALANCES_FILTERS);
  // Поиск теперь «живой» — рендерится через <AdminSearchInput paramName="q">
  // (общий примитив динамического поиска), а не сырым <input name="q">.
  expect(src).toMatch(/paramName="q"/);
  expect(src).toMatch(/name="warehouseId"/);
  expect(src).toMatch(/name="stockState"/);
  // Hidden fields для tab / limit, чтобы submit не сбрасывал вкладку
  // и размер страницы.
  expect(src).toMatch(/name="tab"\s+value="balances"/);
  expect(src).toMatch(/name="limit"/);
  // Selectbox показывает все четыре состояния остатка.
  expect(src).toMatch(/Положительные/);
  expect(src).toMatch(/Нулевые/);
  expect(src).toMatch(/Отрицательные/);
  // Кнопки.
  expect(src).toMatch(/Применить/);
  expect(src).toMatch(/Сбросить/);
  // sourceKey не упоминается.
  expect(src).not.toMatch(/sourceKey/);
});

// ---------------------------------------------------------------------------
// 6. Поля Movements filters: q / warehouseId / type / direction / from / to.
// ---------------------------------------------------------------------------

test('StockMovementsFilters содержит поля q / warehouseId / type / direction / from / to', () => {
  const src = read(MOVEMENTS_FILTERS);
  // Поиск теперь «живой» — рендерится через <AdminSearchInput paramName="q">
  // (общий примитив динамического поиска), а не сырым <input name="q">.
  expect(src).toMatch(/paramName="q"/);
  expect(src).toMatch(/name="warehouseId"/);
  expect(src).toMatch(/name="type"/);
  expect(src).toMatch(/name="direction"/);
  expect(src).toMatch(/name="from"/);
  expect(src).toMatch(/name="to"/);
  // Hidden tab=movements, limit.
  expect(src).toMatch(/name="tab"\s+value="movements"/);
  expect(src).toMatch(/name="limit"/);
  // type=date для from / to.
  expect(src).toMatch(/id="stockMovementsFrom"[\s\S]*?type="date"/);
  expect(src).toMatch(/id="stockMovementsTo"[\s\S]*?type="date"/);
  // sourceKey не упоминается.
  expect(src).not.toMatch(/sourceKey/);
});

// ---------------------------------------------------------------------------
// 7. stockState маппится в positiveOnly / negativeOnly / zeroOnly.
// ---------------------------------------------------------------------------

test('stockStateToApiFlags маппит stockState → backend-флаги', () => {
  const src = read(BALANCES_FILTERS);
  expect(src).toMatch(/export function stockStateToApiFlags/);
  expect(src).toMatch(/positiveOnly:\s*true/);
  expect(src).toMatch(/negativeOnly:\s*true/);
  expect(src).toMatch(/zeroOnly:\s*true/);
  // page.tsx использует helper.
  const page = read(PAGE);
  expect(page).toMatch(/stockStateToApiFlags/);
});

// ---------------------------------------------------------------------------
// 8. type содержит TRANSFER.
// ---------------------------------------------------------------------------

test('Movements filter type содержит TRANSFER (и остальные виды движений)', () => {
  const src = read(MOVEMENTS_FILTERS);
  for (const v of [
    'PURCHASE_RECEIPT',
    'MATERIAL_ISSUE',
    'REVERSAL',
    'ADJUSTMENT',
    'TRANSFER',
  ]) {
    expect(src).toContain(v);
  }
  // Лейбл «Перемещение» для TRANSFER.
  expect(src).toMatch(/'Перемещение'/);
});

// ---------------------------------------------------------------------------
// 9. direction содержит IN / OUT.
// ---------------------------------------------------------------------------

test('Movements filter direction содержит IN / OUT', () => {
  const src = read(MOVEMENTS_FILTERS);
  expect(src).toMatch(/value:\s*'IN'/);
  expect(src).toMatch(/value:\s*'OUT'/);
  expect(src).toMatch(/'Приход'/);
  expect(src).toMatch(/'Расход'/);
});

// ---------------------------------------------------------------------------
// 10. / 11. Reset link.
// ---------------------------------------------------------------------------

test('Reset link для balances ведёт на /admin/warehouses?tab=balances', () => {
  const src = read(BALANCES_FILTERS);
  expect(src).toMatch(/href="\/admin\/warehouses\?tab=balances"/);
});

test('Reset link для movements ведёт на /admin/warehouses?tab=movements', () => {
  const src = read(MOVEMENTS_FILTERS);
  expect(src).toMatch(/href="\/admin\/warehouses\?tab=movements"/);
});

// ---------------------------------------------------------------------------
// 12. Pagination сохраняет фильтры через preserveParams.
// ---------------------------------------------------------------------------

test('Pagination сохраняет фильтры через preserveParams (balances + movements)', () => {
  const page = read(PAGE);
  const balancesBlock = page.match(
    /async function BalancesTabPage[\s\S]*?\n\}\n/,
  )?.[0];
  const movementsBlock = page.match(
    /async function MovementsTabPage[\s\S]*?\n\}\n/,
  )?.[0];
  expect(balancesBlock).toBeTruthy();
  expect(movementsBlock).toBeTruthy();
  // balances preserve содержит tab / q / warehouseId / stockState.
  for (const key of ['tab', 'q', 'warehouseId', 'stockState']) {
    expect(balancesBlock!).toContain(key);
  }
  // movements preserve содержит tab / q / warehouseId / type / direction
  // / from / to.
  for (const key of [
    'tab',
    'q',
    'warehouseId',
    'type',
    'direction',
    'from',
    'to',
  ]) {
    expect(movementsBlock!).toContain(key);
  }
  // StockPagination получает preserveParams.
  const paginationSrc = read(STOCK_PAGINATION);
  expect(paginationSrc).toMatch(/preserveParams/);
});

// ---------------------------------------------------------------------------
// 13. Кнопки «Корректировка» и «Переместить» остаются во вкладке Остатки.
// ---------------------------------------------------------------------------

test('кнопки «Корректировка» и «Переместить» остаются во вкладке Остатки', () => {
  const src = read(PAGE);
  const balancesBlock = src.match(
    /async function BalancesTabPage[\s\S]*?\n\}\n/,
  )?.[0];
  expect(balancesBlock).toBeTruthy();
  expect(balancesBlock!).toMatch(/StockTransferButton/);
  expect(balancesBlock!).toMatch(/StockAdjustmentButton/);
});

// ---------------------------------------------------------------------------
// 14. Кнопка «Добавить» остаётся в header.
// ---------------------------------------------------------------------------

test('Кнопка «Добавить» (склад) остаётся в header', () => {
  const src = read(PAGE);
  expect(src).toMatch(/href="\/admin\/warehouses\/new"/);
  expect(src).toMatch(/Добавить/);
});

// ---------------------------------------------------------------------------
// 15. / 16. Отдельных stock-страниц / роутов нет.
// ---------------------------------------------------------------------------

test('UI не создаёт /admin/stock / /admin/stock-filters / отдельной страницы', () => {
  expect(exists('apps/web/app/admin/stock')).toBe(false);
  expect(exists('apps/web/app/admin/stock-filters')).toBe(false);
  expect(exists('apps/web/app/admin/warehouses/balances')).toBe(false);
  expect(exists('apps/web/app/admin/warehouses/movements')).toBe(false);
  expect(exists('apps/web/app/admin/warehouses/filters')).toBe(false);
});

// ---------------------------------------------------------------------------
// 17. Sidebar не получил новый пункт.
// ---------------------------------------------------------------------------

test('UI не добавляет sidebar item под фильтры / stock', () => {
  const src = read(SIDEBAR);
  expect(src).not.toMatch(/href:\s*'\/admin\/stock'/);
  expect(src).not.toMatch(/'Остатки'/);
  expect(src).not.toMatch(/'Движения'/);
  expect(src).not.toMatch(/'Фильтры'/);
});

// ---------------------------------------------------------------------------
// 18. / 19. Backend StockController / mutations не менялся.
// ---------------------------------------------------------------------------

test('Backend StockController сохраняет существующий whitelist mutations', () => {
  const src = read(STOCK_CONTROLLER);
  // Read-only GET-эндпоинты на месте.
  expect(src).toMatch(/@Get\('balances'\)/);
  expect(src).toMatch(/@Get\('movements'\)/);
  // Разрешённые POST — adjustments + transfers (из предыдущих
  // итераций). Никаких новых POST не появилось.
  expect(src).toMatch(/@Post\('adjustments'\)/);
  expect(src).toMatch(/@Post\('transfers'\)/);
  const otherPosts = src.match(
    /@Post\('(?!adjustments'|transfers')[^']+'\)/g,
  );
  expect(otherPosts).toBeNull();
  // PATCH / PUT / DELETE по-прежнему запрещены.
  for (const verb of ['@Patch(', '@Put(', '@Delete(']) {
    expect(src).not.toContain(verb);
  }
});

// ---------------------------------------------------------------------------
// 20. Нет FIFO / LIFO / MaterialStockLot / master-Material.
// ---------------------------------------------------------------------------

test('Нет FIFO / LIFO / MaterialStockLot / master Material в новых артефактах', () => {
  // JSDoc-упоминания «не реализовано» допустимы (документируют
  // границу MVP). Проверяем только реальный code-fragment без
  // комментариев — тот же подход, что в `warehouses-stock-tabs.smoke`.
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  for (const path of [BALANCES_FILTERS, MOVEMENTS_FILTERS, PAGE]) {
    const code = stripComments(read(path));
    expect(code).not.toMatch(/\bFIFO\b/);
    expect(code).not.toMatch(/\bLIFO\b/);
    expect(code).not.toMatch(/MaterialStockLot/);
  }
  const schema = read(SCHEMA);
  expect(schema).not.toMatch(/^model\s+MaterialStockLot\s*\{/m);
  expect(schema).not.toMatch(/^model\s+Material\s*\{/m);
});

// ---------------------------------------------------------------------------
// stock-api поддерживает новые query-поля.
// ---------------------------------------------------------------------------

test('stock-api types содержат warehouseId / from / to', () => {
  const src = read(STOCK_API);
  // ListStockBalancesQuery содержит warehouseId.
  expect(src).toMatch(
    /interface ListStockBalancesQuery\s*\{[\s\S]*?warehouseId/,
  );
  // ListStockMovementsQuery содержит warehouseId / from / to.
  expect(src).toMatch(
    /interface ListStockMovementsQuery\s*\{[\s\S]*?warehouseId[\s\S]*?from[\s\S]*?to/,
  );
  // listStockBalances и listStockMovements прокидывают новые поля
  // в backend через searchParams.
  const listBalances = src.match(/listStockBalances\([\s\S]*?\}\);\n\}\n/)?.[0];
  expect(listBalances).toBeTruthy();
  expect(listBalances!).toMatch(/warehouseId:\s*query\.warehouseId/);
  const listMovements = src.match(
    /listStockMovements\([\s\S]*?\}\);\n\}\n/,
  )?.[0];
  expect(listMovements).toBeTruthy();
  expect(listMovements!).toMatch(/warehouseId:\s*query\.warehouseId/);
  expect(listMovements!).toMatch(/from:\s*query\.from/);
  expect(listMovements!).toMatch(/to:\s*query\.to/);
});

// ---------------------------------------------------------------------------
// StockService backend не менялся под фильтры.
// ---------------------------------------------------------------------------

test('StockService backend / Prisma schema не менялись под этот UI-фильтр', () => {
  // Проверяем, что StockService продолжает использовать существующие
  // build*Where функции, а не получил новый фильтр-резолвер.
  const src = read(STOCK_SERVICE);
  expect(src).toMatch(/buildStockBalanceWhere/);
  expect(src).toMatch(/buildStockMovementWhere/);
});
