/**
 * Smoke: read-only вкладки «Остатки» / «Движения» в существующем
 * разделе `/admin/warehouses` (см.
 * `apps/web/app/admin/warehouses/page.tsx`,
 * `apps/web/components/warehouses/stock/*`,
 * `apps/web/lib/stock-api.ts`,
 * `docs/current-state.md §«UI остатков и движений склада»`).
 *
 * UI-решение владельца проекта: вместо отдельной страницы
 * `/admin/stock` или нового пункта в sidebar — добавить переключатель
 * вкладок прямо в существующем разделе. Read-only API
 * (`GET /api/stock/balances`, `GET /api/stock/movements`) **не
 * меняется** — это статические проверки структуры frontend-итерации.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function exists(relativePath: string): boolean {
  return existsSync(path.join(repoRoot, relativePath));
}

const PAGE = 'apps/web/app/admin/warehouses/page.tsx';
const TABS = 'apps/web/components/warehouses/stock/warehouse-stock-tabs.tsx';
const BALANCES_TABLE =
  'apps/web/components/warehouses/stock/stock-balances-table.tsx';
const MOVEMENTS_TABLE =
  'apps/web/components/warehouses/stock/stock-movements-table.tsx';
const STOCK_API = 'apps/web/lib/stock-api.ts';
const SIDEBAR = 'apps/web/components/admin-sidebar.tsx';

// ---------------------------------------------------------------------------
// Структура: вкладки добавлены в существующий раздел, отдельной
// страницы не появилось.
// ---------------------------------------------------------------------------

describe('admin/warehouses — вкладки «Остатки» / «Движения» в существующем разделе', () => {
  test('страница `/admin/warehouses/page.tsx` подключает WarehouseStockTabs и две метки', () => {
    const src = readSrc(PAGE);
    expect(src).toMatch(/WarehouseStockTabs/);
    // Лейблы вкладок ровно те, которые попросил владелец проекта.
    const tabsSrc = readSrc(TABS);
    expect(tabsSrc).toMatch(/'Остатки'/);
    expect(tabsSrc).toMatch(/'Движения'/);
    // Кнопка «Добавить» (склад) остаётся на странице — её не
    // выкинули вместе с переключателем вкладок.
    expect(src).toMatch(/href="\/admin\/warehouses\/new"/);
    expect(src).toMatch(/Добавить/);
  });

  test('страница использует query param `tab` и три ветки рендера', () => {
    const src = readSrc(PAGE);
    // Парсер вкладки.
    expect(src).toMatch(/parseWarehouseStockTab\(searchParams\??\.tab\)/);
    // Три ветки tab-рендера.
    expect(src).toMatch(/activeTab === 'balances'/);
    expect(src).toMatch(/activeTab === 'movements'/);
    // Backend ходим только через lib/stock-api.
    expect(src).toMatch(/listStockBalances/);
    expect(src).toMatch(/listStockMovements/);
  });

  test('отдельная страница `/admin/stock` не создавалась', () => {
    expect(exists('apps/web/app/admin/stock')).toBe(false);
    expect(exists('apps/web/app/admin/warehouses/stock')).toBe(false);
    expect(exists('apps/web/app/admin/warehouses/balances')).toBe(false);
    expect(exists('apps/web/app/admin/warehouses/movements')).toBe(false);
  });

  test('sidebar не получил новый пункт под склад / остатки / движения', () => {
    const src = readSrc(SIDEBAR);
    // Существующий пункт «Склады» остаётся.
    expect(src).toMatch(/href:\s*'\/admin\/warehouses'/);
    // Никаких новых stock / balances / movements / warehouse-manager
    // пунктов sidebar.
    expect(src).not.toMatch(/href:\s*'\/admin\/stock'/);
    expect(src).not.toMatch(/href:\s*'\/admin\/warehouses\/stock'/);
    expect(src).not.toMatch(/href:\s*'\/admin\/warehouses\/balances'/);
    expect(src).not.toMatch(/href:\s*'\/admin\/warehouses\/movements'/);
    expect(src).not.toMatch(/Остатки/);
    expect(src).not.toMatch(/Движения/);
  });
});

// ---------------------------------------------------------------------------
// WarehouseStockTabs — компонент-переключатель.
// ---------------------------------------------------------------------------

describe('WarehouseStockTabs — query-param-based переключение', () => {
  test('вкладки рендерятся как Link с query `?tab=...`', () => {
    const src = readSrc(TABS);
    expect(src).toMatch(/href:\s*'\/admin\/warehouses'/);
    expect(src).toMatch(/href:\s*'\/admin\/warehouses\?tab=balances'/);
    expect(src).toMatch(/href:\s*'\/admin\/warehouses\?tab=movements'/);
    // Активная вкладка получает aria-current и отдельный модификатор.
    expect(src).toMatch(/aria-current/);
    expect(src).toMatch(/order-detail-tabs__link--active/);
  });

  test('parser возвращает только знакомые значения, иначе fallback на «list»', () => {
    const src = readSrc(TABS);
    expect(src).toMatch(/parseWarehouseStockTab/);
    expect(src).toMatch(/return 'list'/);
  });

  test('OrderViewTabs не трогался — это другой файл', () => {
    // Паранойя: убедимся, что мы не «заодно» поменяли чужой компонент
    // (см. ТЗ §«Запрещено: не менять OrderViewTabs»).
    const orderTabs = readSrc(
      'apps/web/components/orders/view/order-view-tabs.tsx',
    );
    expect(orderTabs).not.toMatch(/WarehouseStockTabs/);
    expect(orderTabs).not.toMatch(/listStockBalances/);
  });
});

// ---------------------------------------------------------------------------
// API-клиент `lib/stock-api.ts`.
// ---------------------------------------------------------------------------

describe('lib/stock-api — read-only обёртки над `/api/stock/*`', () => {
  test('listStockBalances идёт в `/stock/balances`', () => {
    const src = readSrc(STOCK_API);
    expect(src).toMatch(/export function listStockBalances/);
    expect(src).toMatch(/['"]\/stock\/balances['"]/);
  });

  test('listStockMovements идёт в `/stock/movements`', () => {
    const src = readSrc(STOCK_API);
    expect(src).toMatch(/export function listStockMovements/);
    expect(src).toMatch(/['"]\/stock\/movements['"]/);
  });

  test('frontend types НЕ объявляют поле `sourceKey` (внутренний ключ backend)', () => {
    const src = readSrc(STOCK_API);
    // Поле sourceKey не должно появляться ни как property type, ни как
    // ключ в response shape: backend сознательно его не отдаёт
    // (см. `StockService::toStockMovementListItem`). Допускаются только
    // упоминания в JSDoc (выделены `* `, начинаются с пробела/звёздочки).
    expect(src).not.toMatch(/^\s*sourceKey\s*[?:]/m);
    expect(src).not.toMatch(/['"]sourceKey['"]\s*:/);
  });
});

// ---------------------------------------------------------------------------
// Таблица «Остатки» — состав колонок.
// ---------------------------------------------------------------------------

describe('StockBalancesTable — read-only состав колонок', () => {
  test('используется в page.tsx и зовёт listStockBalances', () => {
    const page = readSrc(PAGE);
    expect(page).toMatch(/StockBalancesTable/);
    expect(page).toMatch(/listStockBalances\(/);
  });

  test('содержит колонки Номенклатура/Заказ/Склад/Ячейка/Кол-во/Цена/Сумма', () => {
    const src = readSrc(BALANCES_TABLE);
    // Заголовок переименован в «Номенклатура» — таблица показывает
    // и материалы, и готовую продукцию (см. итерация «show finished
    // goods in stock views»).
    expect(src).toMatch(/header:\s*'Номенклатура'/);
    expect(src).toMatch(/header:\s*'Заказ'/);
    expect(src).toMatch(/header:\s*'Склад'/);
    expect(src).toMatch(/header:\s*'Ячейка'/);
    expect(src).toMatch(/header:\s*'Кол-во'/);
    expect(src).toMatch(/header:\s*'Цена'/);
    expect(src).toMatch(/header:\s*'Сумма'/);
    // «Последнее движение» / «Обновлено» тоже на месте.
    expect(src).toMatch(/Последнее движение/);
    expect(src).toMatch(/Обновлено/);
  });

  test('пустое состояние общее: «Остатки пока не сформированы»', () => {
    const src = readSrc(BALANCES_TABLE);
    expect(src).toMatch(/Остатки пока не сформированы/);
  });

  test('никаких mutation-кнопок на остатках', () => {
    const src = readSrc(BALANCES_TABLE);
    expect(src).not.toMatch(/Корректировка/);
    expect(src).not.toMatch(/Списать/);
    expect(src).not.toMatch(/Переместить/);
    expect(src).not.toMatch(/<button/);
  });
});

// ---------------------------------------------------------------------------
// Таблица «Движения» — состав колонок.
// ---------------------------------------------------------------------------

describe('StockMovementsTable — read-only состав колонок', () => {
  test('используется в page.tsx и зовёт listStockMovements', () => {
    const page = readSrc(PAGE);
    expect(page).toMatch(/StockMovementsTable/);
    expect(page).toMatch(/listStockMovements\(/);
  });

  test('содержит колонки Дата/Тип/Направление/Номенклатура/Кол-во/Остаток до/после', () => {
    const src = readSrc(MOVEMENTS_TABLE);
    expect(src).toMatch(/header:\s*'Дата'/);
    expect(src).toMatch(/header:\s*'Тип'/);
    expect(src).toMatch(/header:\s*'Направление'/);
    // Заголовок переименован в «Номенклатура» — журнал показывает
    // движения и материалов, и готовой продукции.
    expect(src).toMatch(/header:\s*'Номенклатура'/);
    expect(src).toMatch(/header:\s*'Кол-во'/);
    expect(src).toMatch(/header:\s*'Остаток до'/);
    expect(src).toMatch(/header:\s*'Остаток после'/);
    // «Источник» и «Комментарий» тоже на месте.
    expect(src).toMatch(/Источник/);
    expect(src).toMatch(/Комментарий/);
  });

  test('пустое состояние общее: «Движения пока не зафиксированы»', () => {
    const src = readSrc(MOVEMENTS_TABLE);
    expect(src).toMatch(/Движения пока не зафиксированы/);
  });

  test('sourceKey в журнале не отображается (нет колонки и нет m.sourceKey)', () => {
    const src = readSrc(MOVEMENTS_TABLE);
    // Колонки не содержат `header: 'sourceKey'` / `key: 'sourceKey'`,
    // и render-функции не лезут в `m.sourceKey` / `item.sourceKey`.
    expect(src).not.toMatch(/header:\s*['"]sourceKey/i);
    expect(src).not.toMatch(/key:\s*['"]sourceKey/i);
    expect(src).not.toMatch(/\.sourceKey/);
  });

  test('никаких mutation-кнопок в журнале', () => {
    const src = readSrc(MOVEMENTS_TABLE);
    expect(src).not.toMatch(/Корректировка/);
    expect(src).not.toMatch(/Списать/);
    expect(src).not.toMatch(/Переместить/);
    expect(src).not.toMatch(/Сторнировать/);
    expect(src).not.toMatch(/<button/);
  });
});

// ---------------------------------------------------------------------------
// «Не вводим новых ролей / FIFO / mutation-эндпоинтов».
// ---------------------------------------------------------------------------

describe('UI остатков — границы итерации', () => {
  test('новых ролей `WAREHOUSE_MANAGER` / `PURCHASER` / `ACCOUNTANT` не появилось', () => {
    // Sidebar и страница — единственные две точки, где роль могла бы
    // утечь в этой итерации.
    const sidebar = readSrc(SIDEBAR);
    const page = readSrc(PAGE);
    for (const src of [sidebar, page]) {
      expect(src).not.toMatch(/WAREHOUSE_MANAGER/);
      expect(src).not.toMatch(/PURCHASER/);
      expect(src).not.toMatch(/ACCOUNTANT/);
    }
  });

  test('UI не использует FIFO / LIFO / MaterialStockLot как идентификаторы или JSX-текст', () => {
    // JSDoc-упоминания «не реализовано» допустимы (это документирует
    // границу MVP). Тест проверяет, что в коде нет реальных
    // identifier-ов / labels / переменных под FIFO / LIFO /
    // MaterialStockLot — то есть UI этими понятиями не оперирует.
    const balances = readSrc(BALANCES_TABLE);
    const movements = readSrc(MOVEMENTS_TABLE);
    const page = readSrc(PAGE);
    // Грубая эвристика: identifier-ы вне комментариев живут в
    // строках-литералах или Pascal-/camelCase-именах. Comment-строки
    // в файлах начинаются на ` * ` / `//`.
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/[^\n]*/g, '$1');
    for (const raw of [balances, movements, page]) {
      const code = stripComments(raw);
      expect(code).not.toMatch(/\bFIFO\b/);
      expect(code).not.toMatch(/\bLIFO\b/);
      expect(code).not.toMatch(/MaterialStockLot/);
    }
  });

  test('backend stock-сервис / контроллер сохраняют read-only GET-эндпоинты', () => {
    // Read-only эндпоинты остаются на месте; mutation-добавления
    // (manual stock adjustment) проверяются в отдельном smoke
    // `tests/smoke/stock-adjustments.smoke.test.ts`.
    const controller = readSrc(
      'apps/api/src/modules/stock/stock.controller.ts',
    );
    expect(controller).toMatch(/@Get\('balances'\)/);
    expect(controller).toMatch(/@Get\('movements'\)/);
    // Никаких PATCH / DELETE / PUT в этой итерации.
    expect(controller).not.toMatch(/@Patch|@Delete|@Put/);
  });
});
