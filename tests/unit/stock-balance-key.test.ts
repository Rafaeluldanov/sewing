import { expect, test } from 'vitest';

import { buildStockBalanceKey } from '@sewing/api/modules/stock/stock.service';

test('buildStockBalanceKey: null warehouse/cell → NO_WAREHOUSE / NO_CELL', () => {
  expect(buildStockBalanceKey('wn1', null, null)).toBe(
    'wn1:NO_WAREHOUSE:NO_CELL',
  );
  expect(buildStockBalanceKey('wn1', undefined, undefined)).toBe(
    'wn1:NO_WAREHOUSE:NO_CELL',
  );
});

test('buildStockBalanceKey: явные id склеиваются', () => {
  expect(buildStockBalanceKey('wn1', 'wh1', 'c1')).toBe('wn1:wh1:c1');
});
