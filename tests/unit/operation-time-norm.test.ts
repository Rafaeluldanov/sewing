/**
 * Unit-тесты резолвера нормы времени операции
 * (`apps/api/src/modules/costs/operation-time-norm.ts`) — основа
 * нормативной ветки разноса оклада (норма × объём, решение владельца
 * 14.09.2026). Приоритет: переопределение заказа → справочник операции;
 * незаданная норма — `null`, а не 0.
 */
import { describe, expect, test } from 'vitest';
import { resolveTimeNormSec } from '@sewing/api/modules/costs/operation-time-norm';

const fixedOp = {
  id: 'qc',
  code: 'QC',
  name: 'ОТК',
  timeNormMode: 'FIXED',
  timeNormSec: 36,
  timeNormsBySize: [],
};

const bySizeOp = {
  id: 'pack',
  code: 'PACKING',
  name: 'Упаковка',
  timeNormMode: 'BY_SIZE',
  timeNormSec: null,
  timeNormsBySize: [
    { sizeId: 'S', seconds: 30 },
    { sizeId: 'M', seconds: 40 },
  ],
};

describe('resolveTimeNormSec', () => {
  test('FIXED: справочник операции', () => {
    expect(resolveTimeNormSec(fixedOp, null, 'M')).toBe(36);
  });

  test('FIXED: переопределение заказа побеждает справочник', () => {
    expect(
      resolveTimeNormSec(fixedOp, { timeNormSecOverride: 50, sizeOverrides: [] }, 'M'),
    ).toBe(50);
  });

  test('FIXED без нормы → null (не 0)', () => {
    expect(resolveTimeNormSec({ ...fixedOp, timeNormSec: null }, null, 'M')).toBeNull();
    expect(resolveTimeNormSec({ ...fixedOp, timeNormSec: 0 }, null, 'M')).toBeNull();
  });

  test('BY_SIZE: по размеру паспорта, переопределение заказа побеждает', () => {
    expect(resolveTimeNormSec(bySizeOp, null, 'M')).toBe(40);
    expect(
      resolveTimeNormSec(
        bySizeOp,
        { timeNormSecOverride: null, sizeOverrides: [{ sizeId: 'M', seconds: 45 }] },
        'M',
      ),
    ).toBe(45);
    // Переопределение другого размера не трогает этот.
    expect(
      resolveTimeNormSec(
        bySizeOp,
        { timeNormSecOverride: null, sizeOverrides: [{ sizeId: 'S', seconds: 45 }] },
        'M',
      ),
    ).toBe(40);
  });

  test('BY_SIZE: размер без нормы или паспорт без размера → null', () => {
    expect(resolveTimeNormSec(bySizeOp, null, 'XL')).toBeNull();
    expect(resolveTimeNormSec(bySizeOp, null, null)).toBeNull();
  });
});
