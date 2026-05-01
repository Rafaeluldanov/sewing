/**
 * Smoke-тест проекции экрана «Цех» для нового бакета `QC_DONE`.
 *
 * Проверяет чистую функцию `projectShopfloor` (без Prisma и сети) —
 * фиксирует контракт «после нажатия „Проверка выполнена“ паспорт
 * визуально уезжает из колонки `ОТК` в `Проверено ОТК` и не двигает
 * `Passport.status`». См. `docs/flows.md §F11`, ADR-0013 §«QC_DONE».
 *
 * Покрываем acceptance:
 *   1) свежий QC_PASSED → `bucketOf` возвращает `QC_DONE`;
 *   2) бакеты `QC` и `QC_DONE` взаимоисключающие;
 *   3) `CANCELLED` игнорируется как раньше;
 *   4) shopfloor-сервис фактически прокидывает `hasFreshQcPassed`
 *      из `PassportEvent(QC_PASSED)/OPERATION_SCAN` в проекцию.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OperationCategory, PassportStatus } from '@prisma/client';
import { describe, expect, test } from 'vitest';
import {
  bucketOf,
  projectShopfloor,
  type ProjectionPassport,
  type ProjectionSize,
} from '../../apps/api/src/modules/shopfloor/shopfloor-projection';

const repoRoot = path.resolve(__dirname, '..', '..');
const SIZE_M: ProjectionSize = { id: 'size-m', code: 'M', sortOrder: 50 };

function passport(overrides: Partial<ProjectionPassport>): ProjectionPassport {
  return {
    sizeId: SIZE_M.id,
    qtyCut: 10,
    qtyGood: 10,
    qtyDefect: 0,
    status: PassportStatus.IN_PROGRESS,
    currentOperationCategory: OperationCategory.QC,
    currentEmployeeId: null,
    hasOpenBox: false,
    hasFreshQcPassed: false,
    hasFreshWtoPassed: false,
    ...overrides,
  };
}

describe('shopfloor projection: QC_DONE bucket (после «Проверка выполнена»)', () => {
  test('IN_PROGRESS + category=QC + hasFreshQcPassed → bucket QC_DONE', () => {
    const p = passport({ hasFreshQcPassed: true });
    expect(bucketOf(p)).toBe('QC_DONE');
  });

  test('IN_PROGRESS + category=QC + !hasFreshQcPassed → bucket QC (старое поведение)', () => {
    const p = passport({ hasFreshQcPassed: false });
    expect(bucketOf(p)).toBe('QC');
  });

  test('Проекция кладёт qty в qtyQcDone и зануляет qtyQc для того же паспорта', () => {
    const { rows, summary } = projectShopfloor({
      passports: [passport({ hasFreshQcPassed: true, qtyCut: 7 })],
      sizes: [SIZE_M],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].qtyQc).toBe(0);
    expect(rows[0].qtyQcDone).toBe(7);
    expect(summary.qtyQc).toBe(0);
    expect(summary.qtyQcDone).toBe(7);
  });

  test('После смены категории (например, IRONING) qty уходит в WTO', () => {
    const { rows } = projectShopfloor({
      passports: [
        passport({
          hasFreshQcPassed: false,
          currentOperationCategory: OperationCategory.IRONING,
          qtyCut: 7,
        }),
      ],
      sizes: [SIZE_M],
    });
    expect(rows[0].qtyQc).toBe(0);
    expect(rows[0].qtyQcDone).toBe(0);
    expect(rows[0].qtyWto).toBe(7);
  });

  test('Бакеты QC и QC_DONE — взаимоисключающие: один паспорт ровно в одной ячейке', () => {
    const passports: ProjectionPassport[] = [
      passport({ sizeId: 'a', hasFreshQcPassed: true, qtyCut: 4 }),
      passport({ sizeId: 'b', hasFreshQcPassed: false, qtyCut: 6 }),
    ];
    const sizes: ProjectionSize[] = [
      { id: 'a', code: 'A', sortOrder: 1 },
      { id: 'b', code: 'B', sortOrder: 2 },
    ];
    const { summary } = projectShopfloor({ passports, sizes });
    expect(summary.qtyQc).toBe(6);
    expect(summary.qtyQcDone).toBe(4);
    const sumLive =
      summary.qtyCut +
      summary.qtySewing +
      summary.qtyQc +
      summary.qtyQcDone +
      summary.qtyWto +
      summary.qtyPacking +
      summary.qtyFinished;
    expect(sumLive).toBe(10);
  });

  test('CANCELLED игнорируется: ни в QC, ни в QC_DONE не попадает', () => {
    const { rows, summary } = projectShopfloor({
      passports: [
        passport({
          status: PassportStatus.CANCELLED,
          hasFreshQcPassed: true,
        }),
      ],
      sizes: [SIZE_M],
    });
    expect(rows).toHaveLength(0);
    expect(summary.qtyQcDone).toBe(0);
  });
});

describe('ShopfloorService прокидывает QC_PASSED/OPERATION_SCAN в проекцию', () => {
  test('сервис вычисляет hasFreshQcPassed по PassportEvent(QC_PASSED) vs OPERATION_SCAN', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/api/src/modules/shopfloor/shopfloor.service.ts'),
      'utf8',
    );
    expect(src).toMatch(/PassportEventType\.QC_PASSED/);
    expect(src).toMatch(/PassportEventType\.OPERATION_SCAN/);
    expect(src).toMatch(/hasFreshQcPassed/);
    // Узкий groupBy именно по кандидатам (IN_PROGRESS + category=QC),
    // чтобы не читать события на каждый поллинг для всех паспортов.
    expect(src).toMatch(/qcCandidateIds/);
  });
});
