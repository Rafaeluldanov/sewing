/**
 * Smoke-тест проекции экрана «Цех» для бакета `SEWING_DONE`
 * («Сшито, ждёт ОТК»).
 *
 * Проверяет чистую функцию `projectShopfloor` (без Prisma и сети) —
 * фиксирует контракт «после „Завершить операцию“ паспорт визуально
 * уезжает из колонки `Пошив` в `Сшито, ждёт ОТК`, не меняя
 * `Passport.status`». Полный аналог `shopfloor-qc-done.smoke.test.ts`.
 * См. ADR-0013 §«SEWING_DONE bucket».
 *
 * Покрываем acceptance:
 *   1) SEWING + без исполнителя + свежий OPERATION_FINISHED → `SEWING_DONE`;
 *   2) на руках у швеи (`currentEmployeeId != null`) — всегда `SEWING`,
 *      даже если старый финиш «свежий» (сервис его и не считает);
 *   3) без исполнителя, но без свежего финиша (откат мастером/ОТК) —
 *      `SEWING` («ждёт выдачи»);
 *   4) CUT-rollback (CUTTING без исполнителя) остаётся `CUT`;
 *   5) бакеты `SEWING`/`SEWING_DONE` взаимоисключающие, сумма не меняется;
 *   6) контракт shared: стадия в `SHOPFLOOR_STAGES` между `SEWING` и `QC`,
 *      подпись и qty-ключ;
 *   7) shopfloor-сервис фактически считает `hasFreshSewingFinished` по
 *      `OPERATION_FINISHED` vs `ISSUED_TO_EMPLOYEE`/`OPERATION_SCAN`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OperationCategory, PassportStatus } from '@prisma/client';
import { describe, expect, test } from 'vitest';
import {
  SHOPFLOOR_STAGES,
  SHOPFLOOR_STAGE_LABELS,
  SHOPFLOOR_STAGE_QTY_KEYS,
} from '@sewing/shared/shopfloor';
import {
  bucketOf,
  projectShopfloor,
  projectShopfloorDisplay,
  type DisplayProjectionPassport,
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
    currentOperationCategory: OperationCategory.SEWING,
    currentEmployeeId: null,
    hasOpenBox: false,
    hasFreshQcPassed: false,
    hasFreshWtoPassed: false,
    hasFreshSewingFinished: false,
    ...overrides,
  };
}

describe('shopfloor projection: SEWING_DONE bucket (после «Завершить операцию»)', () => {
  test('IN_PROGRESS + SEWING + без исполнителя + hasFreshSewingFinished → SEWING_DONE', () => {
    expect(bucketOf(passport({ hasFreshSewingFinished: true }))).toBe(
      'SEWING_DONE',
    );
  });

  test('на руках у швеи (currentEmployeeId != null) → SEWING, флаг не важен', () => {
    expect(
      bucketOf(passport({ currentEmployeeId: 'emp-1', hasFreshSewingFinished: true })),
    ).toBe('SEWING');
    expect(
      bucketOf(passport({ currentEmployeeId: 'emp-1', hasFreshSewingFinished: false })),
    ).toBe('SEWING');
  });

  test('без исполнителя, но без свежего финиша (откат мастером/ОТК) → SEWING («ждёт выдачи»)', () => {
    expect(bucketOf(passport({ hasFreshSewingFinished: false }))).toBe('SEWING');
  });

  test('CUT-rollback: CUTTING без исполнителя остаётся CUT, а CUTTING на руках — SEWING', () => {
    expect(
      bucketOf(
        passport({
          currentOperationCategory: OperationCategory.CUTTING,
          currentEmployeeId: null,
          // CUT-ветка стоит раньше проверки буфера — даже с флагом
          // паспорт в ячейке кроя не должен уехать в «Сшито».
          hasFreshSewingFinished: true,
        }),
      ),
    ).toBe('CUT');
    expect(
      bucketOf(
        passport({
          currentOperationCategory: OperationCategory.CUTTING,
          currentEmployeeId: 'emp-1',
        }),
      ),
    ).toBe('SEWING');
  });

  test('Проекция кладёт qty в qtySewingDone и зануляет qtySewing для того же паспорта', () => {
    const { rows, summary } = projectShopfloor({
      passports: [passport({ hasFreshSewingFinished: true, qtyCut: 7 })],
      sizes: [SIZE_M],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].qtySewing).toBe(0);
    expect(rows[0].qtySewingDone).toBe(7);
    expect(summary.qtySewing).toBe(0);
    expect(summary.qtySewingDone).toBe(7);
  });

  test('После OPERATION_SCAN ОТК (категория QC) qty уходит в QC', () => {
    const { rows } = projectShopfloor({
      passports: [
        passport({
          // Сервис флаг для не-SEWING категорий не считает — моделируем итог.
          hasFreshSewingFinished: false,
          currentOperationCategory: OperationCategory.QC,
          qtyCut: 7,
        }),
      ],
      sizes: [SIZE_M],
    });
    expect(rows[0].qtySewing).toBe(0);
    expect(rows[0].qtySewingDone).toBe(0);
    expect(rows[0].qtyQc).toBe(7);
  });

  test('Бакеты SEWING и SEWING_DONE — взаимоисключающие: сумма живых бакетов не меняется', () => {
    const passports: ProjectionPassport[] = [
      passport({ sizeId: 'a', hasFreshSewingFinished: true, qtyCut: 4 }),
      passport({ sizeId: 'b', currentEmployeeId: 'emp-1', qtyCut: 6 }),
      passport({ sizeId: 'c', hasFreshSewingFinished: false, qtyCut: 3 }),
    ];
    const sizes: ProjectionSize[] = [
      { id: 'a', code: 'A', sortOrder: 1 },
      { id: 'b', code: 'B', sortOrder: 2 },
      { id: 'c', code: 'C', sortOrder: 3 },
    ];
    const { summary } = projectShopfloor({ passports, sizes });
    expect(summary.qtySewing).toBe(9);
    expect(summary.qtySewingDone).toBe(4);
    const sumLive =
      summary.qtyCut +
      summary.qtySewing +
      summary.qtySewingDone +
      summary.qtyQc +
      summary.qtyQcDone +
      summary.qtyWto +
      summary.qtyWtoDone +
      summary.qtyPacking +
      summary.qtyFinished;
    expect(sumLive).toBe(13);
  });

  test('CANCELLED игнорируется: ни в SEWING, ни в SEWING_DONE не попадает', () => {
    const { rows, summary } = projectShopfloor({
      passports: [
        passport({
          status: PassportStatus.CANCELLED,
          hasFreshSewingFinished: true,
        }),
      ],
      sizes: [SIZE_M],
    });
    expect(rows).toHaveLength(0);
    expect(summary.qtySewingDone).toBe(0);
  });

  test('display-проекция: SEWING_DONE не входит в sewingByOp, инвариант Σ sewingByOp === qtySewing', () => {
    const op = { id: 'op-ovl', name: 'Оверлок 1', sortOrder: 10 };
    const dp = (o: Partial<DisplayProjectionPassport>): DisplayProjectionPassport => ({
      ...passport({}),
      color: 'Чёрный',
      currentOperationId: op.id,
      currentOperationName: op.name,
      currentOperationSortOrder: op.sortOrder,
      assignedShiftSewingOperationId: null,
      assignedShiftSewingOperationName: null,
      assignedShiftSewingOperationSortOrder: null,
      ...o,
    });
    const { totals, colors } = projectShopfloorDisplay(
      {
        passports: [
          dp({ currentEmployeeId: 'emp-1', qtyCut: 5 }),
          dp({ hasFreshSewingFinished: true, qtyCut: 3 }),
        ],
      },
      new Map([[SIZE_M.id, SIZE_M]]),
    );
    expect(totals.qtySewing).toBe(5);
    expect(totals.qtySewingDone).toBe(3);
    const sumByOp = Object.values(totals.sewingByOp).reduce((a, b) => a + b, 0);
    expect(sumByOp).toBe(totals.qtySewing);
    expect(colors[0]!.totals.qtySewingDone).toBe(3);
    expect(colors[0]!.rows[0]!.qtySewingDone).toBe(3);
  });
});

describe('shared-контракт стадии SEWING_DONE', () => {
  test('порядок стадий: … SEWING, SEWING_DONE, QC, QC_DONE …', () => {
    const i = SHOPFLOOR_STAGES.indexOf('SEWING_DONE');
    expect(i).toBeGreaterThan(0);
    expect(SHOPFLOOR_STAGES[i - 1]).toBe('SEWING');
    expect(SHOPFLOOR_STAGES[i + 1]).toBe('QC');
  });

  test('подпись и qty-ключ', () => {
    expect(SHOPFLOOR_STAGE_LABELS.SEWING_DONE).toBe('Сшито, ждёт ОТК');
    expect(SHOPFLOOR_STAGE_QTY_KEYS.SEWING_DONE).toBe('qtySewingDone');
  });
});

describe('ShopfloorService прокидывает OPERATION_FINISHED/ISSUED_TO_EMPLOYEE/OPERATION_SCAN в проекцию', () => {
  test('сервис вычисляет hasFreshSewingFinished по текущей операции паспорта', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/api/src/modules/shopfloor/shopfloor.service.ts'),
      'utf8',
    );
    expect(src).toMatch(/PassportEventType\.OPERATION_FINISHED/);
    expect(src).toMatch(/PassportEventType\.ISSUED_TO_EMPLOYEE/);
    expect(src).toMatch(/hasFreshSewingFinished: freshSewingFinishedSet\.has\(p\.id\)/);
    // Узкий groupBy именно по кандидатам (IN_PROGRESS + SEWING +
    // без исполнителя), с фильтром финиша по текущей операции.
    expect(src).toMatch(/computeFreshSewingFinishedSet/);
    expect(src).toMatch(/sewingCandidateOps/);
    // KPI «В работе» на дисплее включает буфер пошива.
    expect(src).toMatch(/totals\.qtySewingDone \+/);
  });

  test('потребители web показывают пару ▶/✔ для пошива', () => {
    const tab = readFileSync(
      path.join(
        repoRoot,
        'apps/web/components/orders/view/tabs/order-production-tab.tsx',
      ),
      'utf8',
    );
    expect(tab).toMatch(/done=\{sf\?\.qtySewingDone\}/);
    const display = readFileSync(
      path.join(repoRoot, 'apps/web/app/shopfloor/display/display-board.tsx'),
      'utf8',
    );
    expect(display).toMatch(/case 'SEWING_DONE':/);
  });
});
