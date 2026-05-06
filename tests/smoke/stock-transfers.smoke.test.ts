/**
 * Smoke: перемещение остатка между складами / ячейками
 * (`POST /api/stock/transfers`, см.
 *  `apps/api/src/modules/stock/stock.controller.ts`,
 *  `apps/api/src/modules/stock/stock.service.ts::createTransfer`,
 *  `apps/api/src/modules/stock/dto/create-stock-transfer.dto.ts`,
 *  `apps/web/components/warehouses/stock/stock-transfer-dialog.tsx`,
 *  `docs/api.md §«26a.4 POST /api/stock/transfers»`,
 *  `docs/current-state.md §«Перемещение остатка между складами»`).
 *
 * Статические проверки — не поднимают Nest и не ходят в БД. Полные
 * сценарии (OUT + IN, идемпотентность, same-location, недостаток
 * остатка) живут в `tests/integration/stock-transfers.test.ts`.
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
const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const STOCK_CONSTANTS = 'apps/api/src/modules/stock/stock.constants.ts';
const TRANSFER_DTO =
  'apps/api/src/modules/stock/dto/create-stock-transfer.dto.ts';
const LIST_MOVEMENTS_DTO =
  'apps/api/src/modules/stock/dto/list-stock-movements.dto.ts';
const STOCK_API = 'apps/web/lib/stock-api.ts';
const TRANSFER_DIALOG =
  'apps/web/components/warehouses/stock/stock-transfer-dialog.tsx';
const TRANSFER_BUTTON =
  'apps/web/components/warehouses/stock/stock-transfer-button.tsx';
const WAREHOUSES_PAGE = 'apps/web/app/admin/warehouses/page.tsx';
const WAREHOUSES_ACTIONS = 'apps/web/app/admin/warehouses/actions.ts';
const SIDEBAR = 'apps/web/components/admin-sidebar.tsx';
const MOVEMENT_TYPE_BADGE =
  'apps/web/components/warehouses/stock/stock-movement-type-badge.tsx';
const SCHEMA = 'prisma/schema.prisma';

// ---------------------------------------------------------------------------
// Backend: controller / service / DTO / constants
// ---------------------------------------------------------------------------

test('STOCK_MOVEMENT_TYPE содержит TRANSFER', () => {
  const src = read(STOCK_CONSTANTS);
  expect(src).toMatch(/TRANSFER:\s*'TRANSFER'/);
});

test('list-stock-movements DTO принимает type=TRANSFER', () => {
  const src = read(LIST_MOVEMENTS_DTO);
  expect(src).toMatch(/'TRANSFER'/);
});

test('StockController содержит POST /transfers c @Roles ADMIN/SHOP_MANAGER', () => {
  const src = read(STOCK_CONTROLLER);
  expect(src).toMatch(/@Post\('transfers'\)/);
  // Класс-уровень декоратор всё ещё @Roles('ADMIN', 'SHOP_MANAGER')
  expect(src).toMatch(/@Roles\('ADMIN',\s*'SHOP_MANAGER'\)/);
  expect(src).toMatch(/this\.stock\.createTransfer\(/);
  expect(src).toMatch(/CreateStockTransferSchema/);
});

test('create-stock-transfer.dto.ts существует и описывает контракт', () => {
  expect(exists(TRANSFER_DTO)).toBe(true);
  const src = read(TRANSFER_DTO);
  // Поля контракта.
  expect(src).toMatch(/fromStockBalanceId:/);
  expect(src).toMatch(/toWarehouseId:/);
  expect(src).toMatch(/toCellId:/);
  expect(src).toMatch(/qty:/);
  expect(src).toMatch(/comment:/);
  expect(src).toMatch(/clientRequestId:/);
  // Запрещённые поля (служебные, backend ими управляет сам).
  expect(src).not.toMatch(/^\s*sourceKey\s*:/m);
  expect(src).not.toMatch(/^\s*totalCost\s*:/m);
  expect(src).not.toMatch(/^\s*unitCost\s*:/m);
  expect(src).not.toMatch(/^\s*balanceBeforeQty\s*:/m);
  expect(src).not.toMatch(/^\s*balanceAfterQty\s*:/m);
  expect(src).not.toMatch(/^\s*createdById\s*:/m);
  expect(src).not.toMatch(/^\s*workshopNeedId\s*:/m);
  expect(src).not.toMatch(/^\s*unit\s*:/m);
  // Comment минимум 2 символа, максимум 500.
  expect(src).toMatch(/comment[\s\S]*?\.min\(2\)/);
  expect(src).toMatch(/comment[\s\S]*?\.max\(500\)/);
});

test('StockService содержит buildStockTransferOut/InSourceKey и STOCK_TRANSFER prefix', () => {
  const src = read(STOCK_SERVICE);
  expect(src).toMatch(/export function buildStockTransferOutSourceKey/);
  expect(src).toMatch(/export function buildStockTransferInSourceKey/);
  expect(src).toMatch(/STOCK_TRANSFER:\s*'STOCK_TRANSFER'/);
});

test('StockService.createTransfer пишет пару StockMovement TRANSFER OUT/IN', () => {
  const src = read(STOCK_SERVICE);
  expect(src).toMatch(/async createTransfer\(/);
  // Сам блок метода до закрывающей скобки.
  const block = src.match(/async createTransfer\([\s\S]*?\n  \}\n/)?.[0];
  expect(block).toBeTruthy();
  // type = TRANSFER явно используется.
  expect(block!).toMatch(/STOCK_MOVEMENT_TYPE\.TRANSFER/);
  // Оба direction-а (OUT и IN) пишутся.
  expect(block!).toMatch(/STOCK_MOVEMENT_DIRECTION\.OUT/);
  expect(block!).toMatch(/STOCK_MOVEMENT_DIRECTION\.IN/);
  // Strict source qty check: allowNegativeStock: false на OUT.
  expect(block!).toMatch(/allowNegativeStock:\s*false/);
  // Идемпотентность по двум sourceKey-ключам.
  expect(block!).toMatch(/findMovementBySourceKeyInTx/);
  expect(block!).toMatch(/buildStockTransferOutSourceKey/);
  expect(block!).toMatch(/buildStockTransferInSourceKey/);
  // Audit event.
  expect(block!).toMatch(/STOCK_TRANSFER_CREATED/);
});

test('StockService.createTransfer не использует company-settings-флаги (strict)', () => {
  // Transfer всегда strict — никаких company-settings-флагов в самом
  // методе. Берём блок строго от `async createTransfer(` до первого
  // `randomUUID()` / `await this.prisma.$transaction` — JSDoc выше
  // вынесен из этой проверки.
  const src = read(STOCK_SERVICE);
  const block = src.match(/async createTransfer\([\s\S]*?\n  \}\n/)?.[0];
  expect(block).toBeTruthy();
  // На transfer не распространяется ни глобальный флаг, ни
  // per-division override, ни adjustment-resolver.
  expect(block!).not.toMatch(/getEffectiveMaterialStockSettings/);
  expect(block!).not.toMatch(/resolveAdjustmentAllowNegative/);
  expect(block!).not.toMatch(/companySettings/);
  // Strict-OUT гарантируется явным `allowNegativeStock: false`.
  expect(block!).toMatch(/allowNegativeStock:\s*false/);
});

// ---------------------------------------------------------------------------
// Frontend: stock-api / actions / UI
// ---------------------------------------------------------------------------

test('lib/stock-api экспортирует createStockTransfer в /stock/transfers', () => {
  const src = read(STOCK_API);
  expect(src).toMatch(/export function createStockTransfer/);
  expect(src).toMatch(/['"]\/stock\/transfers['"]/);
  expect(src).toMatch(/method:\s*'POST'/);
  // Frontend StockMovementType union содержит TRANSFER.
  expect(src).toMatch(/'TRANSFER'/);
});

test('actions.ts содержит createStockTransferAction', () => {
  const src = read(WAREHOUSES_ACTIONS);
  expect(src).toMatch(/export async function createStockTransferAction/);
  expect(src).toMatch(/createStockTransfer\(body\)/);
  expect(src).toMatch(/revalidatePath\('\/admin\/warehouses'\)/);
});

test('StockTransferDialog существует и имеет fields source/destination/qty/comment', () => {
  expect(exists(TRANSFER_DIALOG)).toBe(true);
  const src = read(TRANSFER_DIALOG);
  // Поля формы.
  expect(src).toMatch(/name="fromStockBalanceId"/);
  expect(src).toMatch(/name="toWarehouseId"/);
  expect(src).toMatch(/name="qty"/);
  expect(src).toMatch(/name="comment"/);
  // Кнопки «Создать перемещение» / «Отмена».
  expect(src).toMatch(/Создать перемещение/);
  expect(src).toMatch(/Отмена/);
  // Подсказка «Доступно: …».
  expect(src).toMatch(/Доступно/);
  // sourceKey пользователю не показываем.
  expect(src).not.toMatch(/sourceKey/);
});

test('StockTransferButton рендерит кнопку «Переместить»', () => {
  expect(exists(TRANSFER_BUTTON)).toBe(true);
  const src = read(TRANSFER_BUTTON);
  expect(src).toMatch(/Переместить/);
  expect(src).toMatch(/StockTransferDialog/);
});

test('warehouses/page.tsx подключает StockTransferButton во вкладку balances', () => {
  const src = read(WAREHOUSES_PAGE);
  expect(src).toMatch(/StockTransferButton/);
  // Точно во вкладке balances (не в default / movements).
  const balancesBlock = src.match(
    /async function BalancesTabPage[\s\S]*?\n\}\n/,
  )?.[0];
  expect(balancesBlock).toBeTruthy();
  expect(balancesBlock!).toMatch(/StockTransferButton/);
});

test('StockMovementsTable отрисовывает TRANSFER как «Перемещение»', () => {
  const src = read(MOVEMENT_TYPE_BADGE);
  expect(src).toMatch(/TRANSFER:\s*\{\s*label:\s*'Перемещение'/);
});

// ---------------------------------------------------------------------------
// MVP-границы
// ---------------------------------------------------------------------------

test('UI не создаёт /admin/stock-transfer / отдельной страницы', () => {
  expect(exists('apps/web/app/admin/stock-transfer')).toBe(false);
  expect(exists('apps/web/app/admin/stock-transfers')).toBe(false);
  expect(exists('apps/web/app/admin/warehouses/transfer')).toBe(false);
  expect(exists('apps/web/app/admin/warehouses/transfers')).toBe(false);
});

test('UI не добавляет sidebar item под перемещение', () => {
  const src = read(SIDEBAR);
  expect(src).not.toMatch(/href:\s*'\/admin\/stock-transfer/);
  expect(src).not.toMatch(/href:\s*'\/admin\/transfers'/);
  expect(src).not.toMatch(/'Переместить'/);
});

test('Не добавлена StockTransfer / MaterialStockLot / Material модель в Prisma schema', () => {
  const schema = read(SCHEMA);
  expect(schema).not.toMatch(/^model\s+StockTransfer\s*\{/m);
  expect(schema).not.toMatch(/^model\s+MaterialStockLot\s*\{/m);
  expect(schema).not.toMatch(/^model\s+Material\s*\{/m);
});

test('Не вводим FIFO/LIFO/MaterialStockLot в DTO/UI перемещения', () => {
  for (const path of [TRANSFER_DTO, TRANSFER_DIALOG, TRANSFER_BUTTON]) {
    const src = read(path);
    expect(src).not.toMatch(/\bFIFO\b/);
    expect(src).not.toMatch(/\bLIFO\b/);
    expect(src).not.toMatch(/MaterialStockLot/);
  }
});

test('Новые роли (WAREHOUSE_MANAGER / PURCHASER / ACCOUNTANT) не введены', () => {
  const schema = read(SCHEMA);
  const roleEnum = schema.match(/enum\s+Role\s*\{[\s\S]*?\}/)?.[0] ?? '';
  expect(roleEnum).not.toMatch(/\bWAREHOUSE_MANAGER\b/);
  expect(roleEnum).not.toMatch(/\bPURCHASER\b/);
  expect(roleEnum).not.toMatch(/\bACCOUNTANT\b/);
  for (const path of [STOCK_CONTROLLER, TRANSFER_DIALOG, WAREHOUSES_PAGE]) {
    const src = read(path);
    expect(src).not.toMatch(/WAREHOUSE_MANAGER|PURCHASER|ACCOUNTANT/);
  }
});

test('docs/api.md описывает POST /api/stock/transfers', () => {
  const apiDoc = read('docs/api.md');
  expect(apiDoc).toMatch(/POST\s*\|\s*`\/api\/stock\/transfers`/);
  // sourceKey не отдаётся (повтор контракта read-only).
  expect(apiDoc).toMatch(/POST \/api\/stock\/transfers[\s\S]{0,3000}sourceKey/);
});
