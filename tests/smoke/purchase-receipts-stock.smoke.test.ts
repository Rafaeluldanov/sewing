/**
 * Smoke: подключение приёмки к складскому foundation
 * (см. ТЗ «PurchaseReceipt → StockMovement IN»,
 * `apps/api/src/modules/stock/stock.service.ts`,
 * `apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts`).
 *
 * Эти статические проверки нужны, чтобы поймать регресс без поднятой
 * БД (полные сценарии — `tests/integration/purchase-receipts-stock.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

const repoRoot = join(__dirname, '../..');

test('Prisma schema: StockMovement.sourceKey String? @unique', () => {
  const schema = readFileSync(
    join(repoRoot, 'prisma/schema.prisma'),
    'utf8',
  );
  // Поле sourceKey есть в модели и помечено @unique.
  expect(schema).toMatch(/sourceKey\s+String\?\s+@unique/);
  // Migration с UNIQUE-индексом тоже на месте — подстраховка от
  // ручного отката Prisma-схемы без миграции.
  const migration = readFileSync(
    join(
      repoRoot,
      'prisma/migrations/20260609100000_stock_movement_source_key/migration.sql',
    ),
    'utf8',
  );
  expect(migration).toMatch(/ADD COLUMN "sourceKey"/);
  expect(migration).toMatch(/UNIQUE INDEX "StockMovement_sourceKey_key"/);
});

test('StockService содержит sourceKey helpers и методы приёмки/реверса', () => {
  const src = readFileSync(
    join(repoRoot, 'apps/api/src/modules/stock/stock.service.ts'),
    'utf8',
  );
  expect(src).toMatch(/buildPurchaseReceiptLineStockSourceKey/);
  expect(src).toMatch(/buildPurchaseReceiptLineCancelStockSourceKey/);
  expect(src).toMatch(/recordPurchaseReceiptInTx/);
  expect(src).toMatch(/reversePurchaseReceiptInTx/);
  // Префиксы зашиты как константы.
  expect(src).toMatch(/PURCHASE_RECEIPT_LINE['":]/);
  expect(src).toMatch(/PURCHASE_RECEIPT_LINE_CANCEL/);
});

test('PurchaseReceiptsService подключён к StockService (создание + cancel)', () => {
  const src = readFileSync(
    join(
      repoRoot,
      'apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts',
    ),
    'utf8',
  );
  expect(src).toMatch(/import\s+\{\s*StockService\s*\}\s+from/);
  expect(src).toMatch(/recordPurchaseReceiptInTx/);
  expect(src).toMatch(/reversePurchaseReceiptInTx/);
});

test('PurchaseReceiptsModule импортирует StockModule', () => {
  const src = readFileSync(
    join(
      repoRoot,
      'apps/api/src/modules/purchase-receipts/purchase-receipts.module.ts',
    ),
    'utf8',
  );
  expect(src).toMatch(/StockModule/);
});

test('MaterialIssuesService НЕ импортирует StockService на этой итерации', () => {
  const src = readFileSync(
    join(
      repoRoot,
      'apps/api/src/modules/material-issues/material-issues.service.ts',
    ),
    'utf8',
  );
  expect(src).not.toMatch(/\bStockService\b/);
});

test('PassportsService НЕ создаёт StockMovement напрямую', () => {
  const src = readFileSync(
    join(repoRoot, 'apps/api/src/modules/passports/passports.service.ts'),
    'utf8',
  );
  expect(src).not.toMatch(/\bStockService\b/);
  expect(src).not.toMatch(/stockMovement\.create/);
});

test('Нет master-модели Material и нет MaterialStockLot', () => {
  const schema = readFileSync(
    join(repoRoot, 'prisma/schema.prisma'),
    'utf8',
  );
  expect(schema).not.toMatch(/^model Material\s+\{/m);
  expect(schema).not.toMatch(/model MaterialStockLot/);
});

test('Нет публичных stock-страниц / роутов в web (foundation без UI)', () => {
  const appDir = join(repoRoot, 'apps/web/app');
  const suspects = [
    join(appDir, 'admin/stock/page.tsx'),
    join(appDir, 'stock/page.tsx'),
  ];
  for (const p of suspects) {
    try {
      readFileSync(p, 'utf8');
      expect.fail(`Не ожидали файла UI: ${p}`);
    } catch (e: unknown) {
      expect((e as NodeJS.ErrnoException).code).toBe('ENOENT');
    }
  }
});
