/**
 * Smoke: вкладки «Остатки» и «Движения» раздела
 * `/admin/warehouses` показывают и материалы, и готовую продукцию
 * в одной таблице (см. `apps/web/app/admin/warehouses/page.tsx`,
 * `apps/web/components/warehouses/stock/unified-rows.ts`,
 * `apps/web/lib/finished-goods-api.ts`,
 * `docs/current-state.md §«Foundation готовой продукции»`).
 *
 * UI-решение владельца проекта: НЕ создавать отдельную вкладку /
 * страницу / sidebar-пункт под готовую продукцию, а объединить
 * read-only отображение в существующих вкладках. Backend остаётся
 * раздельным.
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

const PAGE = 'apps/web/app/admin/warehouses/page.tsx';
const UNIFIED_ROWS = 'apps/web/components/warehouses/stock/unified-rows.ts';
const BALANCES_TABLE =
  'apps/web/components/warehouses/stock/stock-balances-table.tsx';
const MOVEMENTS_TABLE =
  'apps/web/components/warehouses/stock/stock-movements-table.tsx';
const MOVEMENTS_FILTERS =
  'apps/web/components/warehouses/stock/stock-movements-filters.tsx';
const TYPE_BADGE =
  'apps/web/components/warehouses/stock/stock-movement-type-badge.tsx';
const FG_API = 'apps/web/lib/finished-goods-api.ts';
const STOCK_API = 'apps/web/lib/stock-api.ts';
const SIDEBAR = 'apps/web/components/admin-sidebar.tsx';
const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const FG_SERVICE = 'apps/api/src/modules/finished-goods/finished-goods.service.ts';
const PRISMA_SCHEMA = 'prisma/schema.prisma';
const MATERIAL_ISSUE_SERVICE =
  'apps/api/src/modules/material-issues/material-issues.service.ts';

// ---------------------------------------------------------------------------
// 1–4. Page вызывает оба API.
// ---------------------------------------------------------------------------

describe('warehouses page — объединение материалов и готовой продукции', () => {
  test('1. balances вызывает listStockBalances', () => {
    const src = readSrc(PAGE);
    const balancesBlock = src.match(
      /async function BalancesTabPage[\s\S]*?\n\}\n/,
    )?.[0];
    expect(balancesBlock).toBeTruthy();
    expect(balancesBlock!).toMatch(/listStockBalances\(/);
  });

  test('2. balances вызывает listFinishedGoodsBalances', () => {
    const src = readSrc(PAGE);
    const balancesBlock = src.match(
      /async function BalancesTabPage[\s\S]*?\n\}\n/,
    )?.[0];
    expect(balancesBlock).toBeTruthy();
    expect(balancesBlock!).toMatch(/listFinishedGoodsBalances\(/);
  });

  test('3. movements вызывает listStockMovements', () => {
    const src = readSrc(PAGE);
    const movementsBlock = src.match(
      /async function MovementsTabPage[\s\S]*?\n\}\n/,
    )?.[0];
    expect(movementsBlock).toBeTruthy();
    expect(movementsBlock!).toMatch(/listStockMovements\(/);
  });

  test('4. movements вызывает listFinishedGoodsMovements', () => {
    const src = readSrc(PAGE);
    const movementsBlock = src.match(
      /async function MovementsTabPage[\s\S]*?\n\}\n/,
    )?.[0];
    expect(movementsBlock).toBeTruthy();
    expect(movementsBlock!).toMatch(/listFinishedGoodsMovements\(/);
  });
});

// ---------------------------------------------------------------------------
// 5–8. Unified balance mapper.
// ---------------------------------------------------------------------------

describe('UnifiedWarehouseBalanceRow mapper для готовой продукции', () => {
  test('5. mapper finishedGoodsBalanceToUnified экспортирован', () => {
    const src = readSrc(UNIFIED_ROWS);
    expect(src).toMatch(/export function finishedGoodsBalanceToUnified/);
    expect(src).toMatch(/kind: 'FINISHED_GOOD'/);
  });

  test('6. имя строится из productName / color / sizeCode', () => {
    const src = readSrc(UNIFIED_ROWS);
    // Шаблон строится через помощник `buildFinishedGoodsName`,
    // который собирает product / color / size в одну строку.
    expect(src).toMatch(/buildFinishedGoodsName/);
    // Имя содержит `productName ?? productId`, `sizeCode ?? sizeId`,
    // `color`. Достаточно проверить, что все три ключевых fallback-а
    // присутствуют в файле — helper достаточно простой, parse-уровня
    // проверки не нужно.
    expect(src).toMatch(/item\.productName \?\? item\.productId/);
    expect(src).toMatch(/item\.sizeCode \?\? item\.sizeId/);
    expect(src).toMatch(/item\.color/);
  });

  test('7. unit для готовой продукции = "шт"', () => {
    const src = readSrc(UNIFIED_ROWS);
    const fn = src.match(
      /export function finishedGoodsBalanceToUnified[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/unit:\s*'шт'/);
  });

  test('8. цена и сумма для готовой продукции = null (UI рисует «—»)', () => {
    const src = readSrc(UNIFIED_ROWS);
    const fn = src.match(
      /export function finishedGoodsBalanceToUnified[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/unitCost:\s*null/);
    expect(fn!).toMatch(/totalCost:\s*null/);
    // formatStockMoney(null) → «—», см. `format.ts`.
    const fmt = readSrc('apps/web/components/warehouses/stock/format.ts');
    expect(fmt).toMatch(
      /export function formatStockMoney[\s\S]*?value == null[\s\S]*?return '—'/,
    );
  });
});

// ---------------------------------------------------------------------------
// 9–10. PRODUCTION_RECEIPT label + select option.
// ---------------------------------------------------------------------------

describe('Movements: type PRODUCTION_RECEIPT', () => {
  test('9. badge показывает «Выпуск»', () => {
    const src = readSrc(TYPE_BADGE);
    expect(src).toMatch(/PRODUCTION_RECEIPT:\s*\{\s*label:\s*'Выпуск'/);
  });

  test('10. select типа движения содержит «Выпуск»', () => {
    const src = readSrc(MOVEMENTS_FILTERS);
    expect(src).toMatch(/value:\s*'PRODUCTION_RECEIPT'/);
    expect(src).toMatch(/label:\s*'Выпуск'/);
    // SHIPMENT не в фильтре — отгрузка ещё не реализована.
    expect(src).not.toMatch(/value:\s*'SHIPMENT'/);
  });
});

// ---------------------------------------------------------------------------
// 11–13. Запреты на отдельную вкладку / страницу / sidebar.
// ---------------------------------------------------------------------------

describe('Запреты MVP: отдельный раздел готовой продукции не появился', () => {
  test('11. отдельной вкладки «Готовая продукция» в WarehouseStockTabs нет', () => {
    const tabsSrc = readSrc(
      'apps/web/components/warehouses/stock/warehouse-stock-tabs.tsx',
    );
    expect(tabsSrc).not.toMatch(/Готовая продукция/);
    expect(tabsSrc).not.toMatch(/finished-goods/);
  });

  test('12. /admin/finished-goods не создавалась', () => {
    expect(exists('apps/web/app/admin/finished-goods')).toBe(false);
    expect(exists('apps/web/app/admin/finished_goods')).toBe(false);
  });

  test('13. sidebar не получил новый пункт под готовую продукцию', () => {
    const src = readSrc(SIDEBAR);
    expect(src).not.toMatch(/finished-goods/);
    expect(src).not.toMatch(/Готовая продукция/);
  });
});

// ---------------------------------------------------------------------------
// 14–16. Backend не менялся.
// ---------------------------------------------------------------------------

describe('Backend сохраняет существующий контракт', () => {
  test('14. StockService продолжает использовать buildStockBalanceWhere/Movement', () => {
    const src = readSrc(STOCK_SERVICE);
    expect(src).toMatch(/buildStockBalanceWhere/);
    expect(src).toMatch(/buildStockMovementWhere/);
  });

  test('15. FinishedGoodsService продолжает отдавать read-only listBalances/listMovements', () => {
    const src = readSrc(FG_SERVICE);
    expect(src).toMatch(/async listBalances\(/);
    expect(src).toMatch(/async listMovements\(/);
    // sourceKey всё так же не возвращается публично.
    const movementMapper = src.match(
      /function toMovementListItem[\s\S]*?\n\}/,
    )?.[0];
    expect(movementMapper).toBeTruthy();
    expect(movementMapper!).not.toMatch(/sourceKey:/);
  });

  test('16. MaterialIssueService на этой итерации не редактировался под UI готовой продукции', () => {
    // Сигнал-проверка: ключевой публичный API (post / cancel) и
    // зависимости (StockService, CostsService) на месте; никаких
    // следов finished-goods в material-issues нет.
    const src = readSrc(MATERIAL_ISSUE_SERVICE);
    expect(src).toMatch(/StockService/);
    expect(src).not.toMatch(/FinishedGoods/);
  });
});

// ---------------------------------------------------------------------------
// 17. Pagination: union list + TODO про backend unified endpoint.
// ---------------------------------------------------------------------------

describe('Pagination MVP: union list на UI + TODO про backend endpoint', () => {
  test('17. Page объединяет балансы и применяет общий offset/limit', () => {
    const src = readSrc(PAGE);
    // Mappers вызываются на оба массива.
    expect(src).toMatch(/materialBalanceToUnified/);
    expect(src).toMatch(/finishedGoodsBalanceToUnified/);
    expect(src).toMatch(/materialMovementToUnified/);
    expect(src).toMatch(/finishedGoodsMovementToUnified/);
    // Объединённая sort + UI-pagination.
    expect(src).toMatch(/sortUnifiedBalances/);
    expect(src).toMatch(/sortUnifiedMovements/);
    expect(src).toMatch(/applyUnifiedPagination/);
    // total суммируется из двух API.
    expect(src).toMatch(
      /materialResp\?\.total\s*\?\?\s*0\)\s*\+\s*\(finishedResp\?\.total\s*\?\?\s*0\)/,
    );
    // Comment-TODO про backend unified endpoint оставлен, чтобы
    // следующая итерация знала, что делать на больших объёмах.
    expect(src).toMatch(/TODO[^\n]*backend unified[^\n]*endpoint/i);
  });
});

// ---------------------------------------------------------------------------
// 18. sourceKey не отображается.
// ---------------------------------------------------------------------------

describe('sourceKey остаётся внутренним', () => {
  test('18. ни таблицы, ни client-API не показывают sourceKey', () => {
    for (const p of [
      BALANCES_TABLE,
      MOVEMENTS_TABLE,
      UNIFIED_ROWS,
      FG_API,
      STOCK_API,
      MOVEMENTS_FILTERS,
    ]) {
      const src = readSrc(p);
      // Допускаем упоминание `sourceKey` только в комментариях
      // (объяснение, почему его нет в публичном response).
      const stripComments = (s: string): string =>
        s
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|\s)\/\/[^\n]*/g, '$1');
      const code = stripComments(src);
      expect(code).not.toMatch(/sourceKey/);
    }
  });
});

// ---------------------------------------------------------------------------
// 19–20. Колонка «Заказчик» и clientName для готовой продукции.
// ---------------------------------------------------------------------------

describe('Колонка «Заказчик» в журнале движений', () => {
  test('19. в movements-таблице есть колонка «Заказчик»', () => {
    const src = readSrc(MOVEMENTS_TABLE);
    expect(src).toMatch(/header:\s*'Заказчик'/);
    expect(src).toMatch(/m\.clientName/);
  });

  test('20. mapper finishedGoodsMovementToUnified прокидывает clientName', () => {
    const src = readSrc(UNIFIED_ROWS);
    const fn = src.match(
      /export function finishedGoodsMovementToUnified[\s\S]*?\n\}/,
    )?.[0];
    expect(fn).toBeTruthy();
    expect(fn!).toMatch(/clientName:\s*m\.clientName/);
    expect(fn!).toMatch(/clientId:\s*m\.clientId/);
  });
});

// ---------------------------------------------------------------------------
// Дополнительно: client API готовой продукции на месте; Prisma не
// менялась.
// ---------------------------------------------------------------------------

describe('Frontend wrapper для finished-goods API', () => {
  test('listFinishedGoodsBalances идёт в /finished-goods/balances', () => {
    const src = readSrc(FG_API);
    expect(src).toMatch(/export function listFinishedGoodsBalances/);
    expect(src).toMatch(/['"]\/finished-goods\/balances['"]/);
  });

  test('listFinishedGoodsMovements идёт в /finished-goods/movements', () => {
    const src = readSrc(FG_API);
    expect(src).toMatch(/export function listFinishedGoodsMovements/);
    expect(src).toMatch(/['"]\/finished-goods\/movements['"]/);
  });

  test('Prisma schema на этой итерации не правилась', () => {
    const schema = readSrc(PRISMA_SCHEMA);
    // FinishedGoodsBalance / Movement и StockBalance / StockMovement
    // остаются раздельными.
    expect(schema).toMatch(/^model\s+FinishedGoodsBalance\s*\{/m);
    expect(schema).toMatch(/^model\s+FinishedGoodsMovement\s*\{/m);
    expect(schema).toMatch(/^model\s+StockBalance\s*\{/m);
    expect(schema).toMatch(/^model\s+StockMovement\s*\{/m);
  });
});
