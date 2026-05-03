/**
 * Smoke: подключение расхода материалов к складскому foundation
 * (см. ТЗ «MaterialIssue → StockMovement OUT»,
 * `apps/api/src/modules/stock/stock.service.ts`,
 * `apps/api/src/modules/material-issues/material-issues.service.ts`).
 *
 * Статические проверки — не поднимают Nest и не ходят в БД. Полные
 * сценарии — `tests/integration/material-issues-stock.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

const repoRoot = join(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(join(repoRoot, rel));
}

const STOCK_SERVICE = 'apps/api/src/modules/stock/stock.service.ts';
const MATERIAL_ISSUES_SERVICE =
  'apps/api/src/modules/material-issues/material-issues.service.ts';
const MATERIAL_ISSUES_MODULE =
  'apps/api/src/modules/material-issues/material-issues.module.ts';
const PASSPORTS_SERVICE =
  'apps/api/src/modules/passports/passports.service.ts';
const PURCHASE_RECEIPTS_SERVICE =
  'apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts';

// ---------------------------------------------------------------------------
// StockService: helper и метод для MaterialIssue
// ---------------------------------------------------------------------------

test('StockService экспортирует buildMaterialIssueLineStockSourceKey и префикс MATERIAL_ISSUE_LINE', () => {
  const src = read(STOCK_SERVICE);
  expect(src).toMatch(/export function buildMaterialIssueLineStockSourceKey/);
  expect(src).toMatch(/MATERIAL_ISSUE_LINE:\s*'MATERIAL_ISSUE_LINE'/);
  // Формат ключа — `MATERIAL_ISSUE_LINE:<lineId>`.
  expect(src).toContain('MATERIAL_ISSUE_LINE}:${materialIssueLineId}');
});

test('StockService содержит recordMaterialIssueInTx (только внутри tx, idempotent по sourceKey)', () => {
  const src = read(STOCK_SERVICE);
  expect(src).toMatch(/recordMaterialIssueInTx/);
  // Идём по sourceKey для идемпотентности.
  expect(src).toMatch(/buildMaterialIssueLineStockSourceKey/);
  // Используем applyMovementInTx (а не прямой stockMovement.create).
  const methodMatch = src.match(
    /recordMaterialIssueInTx[\s\S]*?\n  \}\n/,
  )?.[0];
  expect(methodMatch).toBeTruthy();
  // Защита от reversal-итерации: в этой задаче OUT пишется через
  // существующий applyMovementInTx — не надо открывать новые tx.
  expect(methodMatch!).not.toMatch(/\$transaction/);
});

test('StockService различает comment для AUTO_CUT_ISSUE и ручных документов', () => {
  const src = read(STOCK_SERVICE);
  expect(src).toContain('Автоматическое списание при выдаче кроя');
  expect(src).toContain('Списание по документу расхода материалов');
});

// ---------------------------------------------------------------------------
// MaterialIssuesService: ручной post и auto-helper вызывают StockService
// ---------------------------------------------------------------------------

test('MaterialIssuesService импортирует и инжектит StockService', () => {
  const src = read(MATERIAL_ISSUES_SERVICE);
  expect(src).toMatch(
    /import\s+\{\s*StockService\s*\}\s+from\s+'\.\.\/stock\/stock\.service\.js'/,
  );
  expect(src).toMatch(/private\s+readonly\s+stock:\s*StockService/);
});

test('MaterialIssuesService.post вызывает recordMaterialIssueInTx в той же tx', () => {
  const src = read(MATERIAL_ISSUES_SERVICE);
  const postBlock = src.match(/\n  async post\([\s\S]*?\n  \}\n/)?.[0];
  expect(postBlock).toBeTruthy();
  expect(postBlock!).toMatch(/this\.stock\.recordMaterialIssueInTx/);
  // Не открываем новую транзакцию внутри post.
  const calls = postBlock!.match(/this\.prisma\.\$transaction/g) ?? [];
  expect(calls.length).toBe(1);
});

test('createAutoCutIssueForPassport вызывает recordMaterialIssueInTx в переданной tx', () => {
  const src = read(MATERIAL_ISSUES_SERVICE);
  const autoBlock = src.match(
    /async createAutoCutIssueForPassport[\s\S]*?\n  \}\n/,
  )?.[0];
  expect(autoBlock).toBeTruthy();
  expect(autoBlock!).toMatch(/this\.stock\.recordMaterialIssueInTx/);
  expect(autoBlock!).not.toMatch(/\$transaction/);
});

test('MaterialIssuesModule импортирует StockModule', () => {
  const src = read(MATERIAL_ISSUES_MODULE);
  expect(src).toMatch(
    /import\s+\{\s*StockModule\s*\}\s+from\s+'\.\.\/stock\/stock\.module\.js'/,
  );
  expect(src).toMatch(/imports:\s*\[[\s\S]*?StockModule[\s\S]*?\]/);
});

// ---------------------------------------------------------------------------
// Passport-слой не пишет StockMovement напрямую
// ---------------------------------------------------------------------------

test('PassportsService НЕ создаёт StockMovement напрямую и не инжектит StockService', () => {
  const src = read(PASSPORTS_SERVICE);
  expect(src).not.toMatch(/\bStockService\b/);
  expect(src).not.toMatch(/stockMovement\.create/);
  expect(src).not.toMatch(/stockBalance\.update/);
});

// ---------------------------------------------------------------------------
// PurchaseReceipts-flow не сломан
// ---------------------------------------------------------------------------

test('PurchaseReceiptsService по-прежнему пишет IN/REVERSAL через StockService', () => {
  const src = read(PURCHASE_RECEIPTS_SERVICE);
  expect(src).toMatch(/\bStockService\b/);
  expect(src).toMatch(/recordPurchaseReceiptInTx/);
  expect(src).toMatch(/reversePurchaseReceiptInTx/);
});

// ---------------------------------------------------------------------------
// MVP-границы: нет MaterialStockLot, master Material, FIFO/LIFO и stock UI
// ---------------------------------------------------------------------------

test('Нет master-модели Material и нет MaterialStockLot', () => {
  const schema = read('prisma/schema.prisma');
  expect(schema).not.toMatch(/^model\s+Material\s*\{/m);
  expect(schema).not.toMatch(/model\s+MaterialStockLot/);
});

test('Нет FIFO/LIFO в StockService и MaterialIssuesService', () => {
  const stockSrc = read(STOCK_SERVICE);
  const miSrc = read(MATERIAL_ISSUES_SERVICE);
  // Комментарии «без FIFO/LIFO» в шапке служебных JSDoc-ов допустимы,
  // но алгоритма там быть не должно. Сознательно оставим грубую
  // проверку: нет API / прямой реализации «FIFO» / «LIFO» в коде —
  // только в комментариях вида «без FIFO/LIFO».
  for (const src of [stockSrc, miSrc]) {
    expect(src).not.toMatch(/FIFO\s*\(/);
    expect(src).not.toMatch(/LIFO\s*\(/);
    expect(src).not.toMatch(/fifoOrderBy|lifoOrderBy|fifoQueue|lifoQueue/i);
  }
});

test('Нет публичных stock-страниц / роутов в web (foundation без UI)', () => {
  const suspects = [
    'apps/web/app/admin/stock/page.tsx',
    'apps/web/app/stock/page.tsx',
    'apps/web/app/admin/material-issues/page.tsx',
  ];
  for (const p of suspects) {
    expect(exists(p)).toBe(false);
  }
});

test('PurchaseReceiptsService не трогает MaterialIssue OUT-ключи (несмешение ключей)', () => {
  const src = read(PURCHASE_RECEIPTS_SERVICE);
  expect(src).not.toMatch(/MATERIAL_ISSUE_LINE/);
});
