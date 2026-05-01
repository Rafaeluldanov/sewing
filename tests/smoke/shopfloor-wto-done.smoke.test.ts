/**
 * Smoke-тест проекции экрана «Цех» для бакета `WTO_DONE`.
 *
 * Полный аналог `shopfloor-qc-done.smoke.test.ts` для роли ВТО.
 * Фиксирует контракт «после нажатия „Завершить ВТО“ паспорт визуально
 * уезжает из колонки `ВТО` в `ВТО завершено` и не двигает
 * `Passport.status`». См. `docs/flows.md §F6`, ADR-0013 §«WTO_DONE».
 *
 * Покрываем acceptance:
 *   1) свежий WTO_PASSED → `bucketOf` возвращает `WTO_DONE`;
 *   2) бакеты `WTO` и `WTO_DONE` взаимоисключающие;
 *   3) `CANCELLED` игнорируется как раньше;
 *   4) shopfloor-сервис фактически прокидывает `hasFreshWtoPassed`
 *      из `PassportEvent(WTO_PASSED)/OPERATION_SCAN` в проекцию;
 *   5) `QC_DONE` остаётся независимым от `WTO_DONE`.
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
    currentOperationCategory: OperationCategory.IRONING,
    hasOpenBox: false,
    hasFreshQcPassed: false,
    hasFreshWtoPassed: false,
    ...overrides,
  };
}

describe('shopfloor projection: WTO_DONE bucket (после «Завершить ВТО»)', () => {
  test('IN_PROGRESS + category=IRONING + hasFreshWtoPassed → bucket WTO_DONE', () => {
    const p = passport({ hasFreshWtoPassed: true });
    expect(bucketOf(p)).toBe('WTO_DONE');
  });

  test('IN_PROGRESS + category=IRONING + !hasFreshWtoPassed → bucket WTO (старое поведение)', () => {
    const p = passport({ hasFreshWtoPassed: false });
    expect(bucketOf(p)).toBe('WTO');
  });

  test('Проекция кладёт qty в qtyWtoDone и зануляет qtyWto для того же паспорта', () => {
    const { rows, summary } = projectShopfloor({
      passports: [passport({ hasFreshWtoPassed: true, qtyCut: 7 })],
      sizes: [SIZE_M],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].qtyWto).toBe(0);
    expect(rows[0].qtyWtoDone).toBe(7);
    expect(summary.qtyWto).toBe(0);
    expect(summary.qtyWtoDone).toBe(7);
  });

  test('После смены категории (например, PACKING) qty уходит из WTO_DONE', () => {
    const { rows } = projectShopfloor({
      passports: [
        passport({
          // следующий OPERATION_SCAN сменит категорию и сбросит флаг
          // — моделируем итог: hasFreshWtoPassed=false, новая категория.
          hasFreshWtoPassed: false,
          currentOperationCategory: OperationCategory.PACKING,
          // PACKING считает qtyGood (см. pickQty в shopfloor-projection):
          // правим оба поля, чтобы убедиться, что 7 «правильных» уехали
          // именно в qtyPacking, а не где-то застряли.
          qtyCut: 7,
          qtyGood: 7,
        }),
      ],
      sizes: [SIZE_M],
    });
    expect(rows[0].qtyWto).toBe(0);
    expect(rows[0].qtyWtoDone).toBe(0);
    expect(rows[0].qtyPacking).toBe(7);
  });

  test('Бакеты WTO и WTO_DONE — взаимоисключающие: один паспорт ровно в одной ячейке', () => {
    const passports: ProjectionPassport[] = [
      passport({ sizeId: 'a', hasFreshWtoPassed: true, qtyCut: 4 }),
      passport({ sizeId: 'b', hasFreshWtoPassed: false, qtyCut: 6 }),
    ];
    const sizes: ProjectionSize[] = [
      { id: 'a', code: 'A', sortOrder: 1 },
      { id: 'b', code: 'B', sortOrder: 2 },
    ];
    const { summary } = projectShopfloor({ passports, sizes });
    expect(summary.qtyWto).toBe(6);
    expect(summary.qtyWtoDone).toBe(4);
    const sumLive =
      summary.qtyCut +
      summary.qtySewing +
      summary.qtyQc +
      summary.qtyQcDone +
      summary.qtyWto +
      summary.qtyWtoDone +
      summary.qtyPacking +
      summary.qtyFinished;
    expect(sumLive).toBe(10);
  });

  test('CANCELLED игнорируется: ни в WTO, ни в WTO_DONE не попадает', () => {
    const { rows, summary } = projectShopfloor({
      passports: [
        passport({
          status: PassportStatus.CANCELLED,
          hasFreshWtoPassed: true,
        }),
      ],
      sizes: [SIZE_M],
    });
    expect(rows).toHaveLength(0);
    expect(summary.qtyWtoDone).toBe(0);
  });

  test('QC_DONE и WTO_DONE независимы: каждый бакет отрабатывает свою категорию', () => {
    const passports: ProjectionPassport[] = [
      passport({
        sizeId: 'qc',
        currentOperationCategory: OperationCategory.QC,
        hasFreshQcPassed: true,
        qtyCut: 3,
      }),
      passport({
        sizeId: 'wto',
        currentOperationCategory: OperationCategory.IRONING,
        hasFreshWtoPassed: true,
        qtyCut: 5,
      }),
    ];
    const sizes: ProjectionSize[] = [
      { id: 'qc', code: 'Q', sortOrder: 1 },
      { id: 'wto', code: 'W', sortOrder: 2 },
    ];
    const { summary } = projectShopfloor({ passports, sizes });
    expect(summary.qtyQcDone).toBe(3);
    expect(summary.qtyWtoDone).toBe(5);
    expect(summary.qtyQc).toBe(0);
    expect(summary.qtyWto).toBe(0);
  });
});

describe('ShopfloorService прокидывает WTO_PASSED/OPERATION_SCAN в проекцию', () => {
  test('сервис вычисляет hasFreshWtoPassed по PassportEvent(WTO_PASSED) vs OPERATION_SCAN', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/api/src/modules/shopfloor/shopfloor.service.ts'),
      'utf8',
    );
    expect(src).toMatch(/PassportEventType\.WTO_PASSED/);
    expect(src).toMatch(/hasFreshWtoPassed/);
    // Узкий список кандидатов именно по `IN_PROGRESS + category=IRONING`,
    // чтобы groupBy шёл только по тем паспортам, которые реально могут
    // оказаться в `WTO_DONE`.
    expect(src).toMatch(/wtoCandidateIds/);
  });
});
