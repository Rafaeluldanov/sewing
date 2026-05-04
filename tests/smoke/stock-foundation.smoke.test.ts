/**
 * Smoke: foundation складского учёта — схема, отсутствие лишних
 * сущностей, отсутствие проводок из существующих сервисов и UI.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

const repoRoot = join(__dirname, '../..');

test('Prisma schema: есть StockBalance / StockMovement, нет MaterialStockLot / model Material', () => {
  const schema = readFileSync(
    join(repoRoot, 'prisma/schema.prisma'),
    'utf8',
  );
  expect(schema).toMatch(/model StockBalance/);
  expect(schema).toMatch(/model StockMovement/);
  expect(schema).not.toMatch(/model MaterialStockLot/);
  expect(schema).not.toMatch(/^model Material\s+\{/m);
});

test('PassportsService не содержит StockService', () => {
  const src = readFileSync(
    join(
      repoRoot,
      'apps/api/src/modules/passports/passports.service.ts',
    ),
    'utf8',
  );
  expect(src).not.toMatch(/\bStockService\b/);
});

test('PurchaseReceiptsService подключён к StockService (приём + cancel пишут StockMovement)', () => {
  const src = readFileSync(
    join(
      repoRoot,
      'apps/api/src/modules/purchase-receipts/purchase-receipts.service.ts',
    ),
    'utf8',
  );
  // foundation подключён: приёмка пишет IN, cancel — REVERSAL OUT
  // (см. `apps/api/src/modules/stock/stock.service.ts`).
  expect(src).toMatch(/\bStockService\b/);
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

test('MaterialIssuesService подключён к StockService (расход пишет StockMovement OUT)', () => {
  const src = readFileSync(
    join(
      repoRoot,
      'apps/api/src/modules/material-issues/material-issues.service.ts',
    ),
    'utf8',
  );
  // foundation подключён: MaterialIssue.post и AUTO_CUT_ISSUE пишут
  // исходящее движение (см.
  // `apps/api/src/modules/stock/stock.service.ts::recordMaterialIssueInTx`).
  expect(src).toMatch(/\bStockService\b/);
  expect(src).toMatch(/recordMaterialIssueInTx/);
});

test('Нет новых web-роутов / страниц stock (foundation без UI)', () => {
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

test('AppModule подключает StockModule', () => {
  const src = readFileSync(
    join(repoRoot, 'apps/api/src/app.module.ts'),
    'utf8',
  );
  expect(src).toMatch(/StockModule/);
});
