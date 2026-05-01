/**
 * Smoke-тесты экрана `/shopfloor/display` (Шаг 10b — light-theme dashboard).
 *
 * Проверяем три уровня:
 *
 *   1. Чистая проекция `projectShopfloorDisplay` — фиксирует контракт
 *      «матрица цвет × размер × stage» (нормализация чёрный/белый,
 *      раздельные блоки, итоги по цвету и общий total).
 *
 *   2. Источники истины UI (`display-board.tsx`, `page.tsx`) — без
 *      React-рендерера это самый дешёвый способ зафиксировать, что:
 *        - используется light-theme (`display-screen--light`);
 *        - убраны блоки «Активные заказы» и «Проблемы»;
 *        - есть KPI-row, production matrix, EquipmentPanel;
 *        - equipment отрисован компактными плитками с иконками;
 *        - сохранён polling и read-only режим (нет `<button>`/`<form>`).
 *
 *   3. Backend-контракт `/api/shopfloor/display` (controller + service)
 *      объявлен и тянет за собой `kind` оборудования + KPI «выпущено
 *      сегодня».
 *
 * Полноценный integration-тест с базой — в
 * `tests/integration/shopfloor-display.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OperationCategory, PassportStatus } from '@prisma/client';
import { describe, expect, test } from 'vitest';
import {
  SHOPFLOOR_DISPLAY_MATRIX_STAGES,
  SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY,
} from '@sewing/shared/shopfloor';
import {
  projectShopfloorDisplay,
  type DisplayProjectionPassport,
  type ProjectionSize,
} from '../../apps/api/src/modules/shopfloor/shopfloor-projection';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const SIZE_S: ProjectionSize = { id: 'sz-s', code: 'S', sortOrder: 10 };
const SIZE_M: ProjectionSize = { id: 'sz-m', code: 'M', sortOrder: 20 };
const SIZE_L: ProjectionSize = { id: 'sz-l', code: 'L', sortOrder: 30 };

function pp(
  overrides: Partial<DisplayProjectionPassport> = {},
): DisplayProjectionPassport {
  return {
    sizeId: SIZE_M.id,
    color: 'Чёрный',
    qtyCut: 5,
    qtyGood: 5,
    qtyDefect: 0,
    status: PassportStatus.CREATED,
    currentOperationCategory: null,
    currentOperationId: null,
    currentOperationName: null,
    currentOperationSortOrder: null,
    assignedShiftSewingOperationId: null,
    assignedShiftSewingOperationName: null,
    assignedShiftSewingOperationSortOrder: null,
    hasOpenBox: false,
    hasFreshQcPassed: false,
    hasFreshWtoPassed: false,
    ...overrides,
  };
}

/** Удобный shortcut для passport, попавшего в SEWING-бакет на конкретной операции. */
function sewingOn(
  op: { id: string; name: string; sortOrder: number },
  overrides: Partial<DisplayProjectionPassport> = {},
): DisplayProjectionPassport {
  return pp({
    status: PassportStatus.IN_PROGRESS,
    currentOperationCategory: OperationCategory.SEWING,
    currentOperationId: op.id,
    currentOperationName: op.name,
    currentOperationSortOrder: op.sortOrder,
    ...overrides,
  });
}

/**
 * Shortcut для passport, который швея уже «приняла в работу»
 * (`issueToEmployee`), но ещё не отдельно отсканировала на свою
 * операцию: `currentOperation` всё ещё CUTTING (CUT_DIVISION),
 * а реальная sewing-операция живёт в открытой смене швеи. Это
 * самый частый кейс в продакшене — именно его должна корректно
 * раскладывать display-проекция, а не валить в pending.
 */
function issuedToSeamstressOn(
  op: { id: string; name: string; sortOrder: number },
  overrides: Partial<DisplayProjectionPassport> = {},
): DisplayProjectionPassport {
  return pp({
    status: PassportStatus.IN_PROGRESS,
    currentOperationCategory: OperationCategory.CUTTING,
    currentOperationId: 'op-cut-division',
    currentOperationName: 'Деление кроя',
    currentOperationSortOrder: 40,
    assignedShiftSewingOperationId: op.id,
    assignedShiftSewingOperationName: op.name,
    assignedShiftSewingOperationSortOrder: op.sortOrder,
    ...overrides,
  });
}

const sizeMeta = new Map<string, ProjectionSize>([
  [SIZE_S.id, SIZE_S],
  [SIZE_M.id, SIZE_M],
  [SIZE_L.id, SIZE_L],
]);

describe('projectShopfloorDisplay: матрица цвет × размер × stage', () => {
  test('Группирует по цвету (нормализованному) и по размеру', () => {
    const { colors, totals } = projectShopfloorDisplay(
      {
        passports: [
          pp({ color: 'Чёрный', sizeId: SIZE_S.id, qtyCut: 3 }),
          pp({ color: 'чёрный', sizeId: SIZE_M.id, qtyCut: 4 }),
          pp({ color: 'Белый', sizeId: SIZE_M.id, qtyCut: 2 }),
          pp({ color: 'white', sizeId: SIZE_L.id, qtyCut: 1 }),
        ],
      },
      sizeMeta,
    );
    // Канонический порядок: black → white → остальные.
    expect(colors.map((c) => c.colorKey)).toEqual(['black', 'white']);
    expect(colors[0].colorLabel).toBe('Чёрный');
    expect(colors[1].colorLabel).toBe('Белый');

    const black = colors[0];
    expect(black.rows).toHaveLength(2);
    expect(black.rows.map((r) => r.sizeCode)).toEqual(['S', 'M']);
    expect(black.totals.qtyCut).toBe(7);

    const white = colors[1];
    expect(white.rows.map((r) => r.sizeCode)).toEqual(['M', 'L']);
    expect(white.totals.qtyCut).toBe(3);

    expect(totals.qtyCut).toBe(10);
  });

  test('Stage buckets распределены так же, как в `/shopfloor/state`', () => {
    const { totals } = projectShopfloorDisplay(
      {
        passports: [
          // 10 кроя «ждёт» (CREATED)
          pp({
            color: 'black',
            qtyCut: 10,
            status: PassportStatus.CREATED,
          }),
          // 3 в шитье
          pp({
            color: 'black',
            qtyCut: 3,
            status: PassportStatus.IN_PROGRESS,
            currentOperationCategory: OperationCategory.SEWING,
          }),
          // 5 в ОТК
          pp({
            color: 'white',
            qtyCut: 5,
            status: PassportStatus.IN_PROGRESS,
            currentOperationCategory: OperationCategory.QC,
          }),
          // 2 ОТК завершено (свежий QC_PASSED) → QC_DONE
          pp({
            color: 'white',
            qtyCut: 2,
            status: PassportStatus.IN_PROGRESS,
            currentOperationCategory: OperationCategory.QC,
            hasFreshQcPassed: true,
          }),
          // 7 в упаковке (PACKED + open box)
          pp({
            color: 'black',
            qtyGood: 7,
            status: PassportStatus.PACKED,
            hasOpenBox: true,
          }),
          // 4 готово (PACKED + закрытая коробка)
          pp({
            color: 'black',
            qtyGood: 4,
            status: PassportStatus.PACKED,
            hasOpenBox: false,
          }),
        ],
      },
      sizeMeta,
    );
    expect(totals.qtyCut).toBe(10);
    expect(totals.qtySewing).toBe(3);
    expect(totals.qtyQc).toBe(5);
    expect(totals.qtyQcDone).toBe(2);
    expect(totals.qtyPacking).toBe(7);
    expect(totals.qtyFinished).toBe(4);
  });

  test('CANCELLED-паспорта не попадают ни в один блок', () => {
    const { colors, totals } = projectShopfloorDisplay(
      {
        passports: [
          pp({
            color: 'black',
            status: PassportStatus.CANCELLED,
            qtyCut: 99,
            qtyDefect: 99,
          }),
        ],
      },
      sizeMeta,
    );
    expect(colors).toHaveLength(0);
    expect(totals.qtyCut).toBe(0);
    expect(totals.qtyDefect).toBe(0);
  });

  test('Неизвестный цвет образует отдельный блок и идёт после канонических', () => {
    const { colors } = projectShopfloorDisplay(
      {
        passports: [
          pp({ color: 'Хаки', qtyCut: 1 }),
          pp({ color: 'Чёрный', qtyCut: 2 }),
        ],
      },
      sizeMeta,
    );
    expect(colors.map((c) => c.colorKey)).toEqual(['black', 'хаки']);
  });

  test('Пустой `color` маппится в служебный блок «Без цвета»', () => {
    const { colors } = projectShopfloorDisplay(
      { passports: [pp({ color: null, qtyCut: 5 })] },
      sizeMeta,
    );
    expect(colors).toHaveLength(1);
    expect(colors[0].colorLabel).toBe('Без цвета');
  });
});

// ---------------------------------------------------------------------------
// Детализация sewing-колонок (Шаг «Display board: pошив по операциям»)
// ---------------------------------------------------------------------------
//
// На `/shopfloor/display` стадия «Пошив» больше не одна колонка, а
// разворачивается в набор колонок по фактическим sewing-операциям
// (Оверлок 1, Киперка, Распошивальная и т. п.). Источник колонок —
// `Passport.currentOperation` живых паспортов, без хардкода списка
// строк. Эти тесты фиксируют главные обещания backend'а:
//
//   1. SEWING из `SHOPFLOOR_DISPLAY_MATRIX_STAGES` исключён — контракт
//      явный, UI не должен пытаться рисовать его как «обычную» колонку.
//   2. Колонки появляются только для операций с ненулевой Σ; пустые
//      исключаются из ответа полностью.
//   3. Если по операции есть продукция хотя бы у одной строки/цвета —
//      колонка есть и значения корректны; в строках без этой операции
//      backend ключ просто не добавляет (UI рендерит 0 по умолчанию).
//   4. Σ `sewingByOp` на каждом уровне (row / colorTotals / grandTotals)
//      строго равна `qtySewing` соответствующего уровня — иначе KPI и
//      матрица «разъезжаются».
//   5. Паспорт в SEWING-бакете без явной sewing-операции (CUTTING-
//      категория после выдачи кроя до первого скана, либо
//      `currentOperation = NULL`) попадает в служебную pending-колонку
//      `SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY`, и она тоже исчезает,
//      если по ней Σ = 0.
//   6. Порядок колонок стабилен: по `Operation.sortOrder`, pending
//      всегда последним.

describe('display board: sewing breakdown по операциям', () => {
  const SEW_OVER_1 = { id: 'op-over-1', name: 'Оверлок 1', sortOrder: 80 };
  const SEW_OVER_2 = { id: 'op-over-2', name: 'Оверлок 2', sortOrder: 100 };
  const SEW_KIP = { id: 'op-kip', name: 'Киперка', sortOrder: 90 };

  test('SHOPFLOOR_DISPLAY_MATRIX_STAGES не содержит SEWING (UI рисует динамические колонки)', () => {
    expect(SHOPFLOOR_DISPLAY_MATRIX_STAGES).not.toContain('SEWING');
    // CUT/QC/WTO/PACKING/FINISHED по-прежнему статичны.
    expect(SHOPFLOOR_DISPLAY_MATRIX_STAGES).toContain('CUT');
    expect(SHOPFLOOR_DISPLAY_MATRIX_STAGES).toContain('QC');
    expect(SHOPFLOOR_DISPLAY_MATRIX_STAGES).toContain('WTO');
    expect(SHOPFLOOR_DISPLAY_MATRIX_STAGES).toContain('PACKING');
    expect(SHOPFLOOR_DISPLAY_MATRIX_STAGES).toContain('FINISHED');
  });

  test('Только sewing-операции с ненулевой Σ попадают в sewingColumns', () => {
    // Чёрный, два размера — одна и та же sewing-операция (Оверлок 1):
    // 3 шт на S, 2 шт на M; и 4 шт на Киперке для размера M.
    // Оверлок 2 нигде не встречается → колонки быть не должно.
    const { sewingColumns, totals } = projectShopfloorDisplay(
      {
        passports: [
          sewingOn(SEW_OVER_1, { sizeId: SIZE_S.id, qtyCut: 3 }),
          sewingOn(SEW_OVER_1, { sizeId: SIZE_M.id, qtyCut: 2 }),
          sewingOn(SEW_KIP, { sizeId: SIZE_M.id, qtyCut: 4 }),
        ],
      },
      sizeMeta,
    );
    expect(sewingColumns.map((c) => c.key)).toEqual([
      // Порядок по sortOrder: Оверлок 1 (80), Киперка (90).
      SEW_OVER_1.id,
      SEW_KIP.id,
    ]);
    // Оверлок 2 (sortOrder 100) тоже сюда НЕ попадает — Σ = 0.
    expect(sewingColumns.find((c) => c.key === SEW_OVER_2.id)).toBeUndefined();
    expect(totals.qtySewing).toBe(3 + 2 + 4);
    // Σ sewingByOp == qtySewing на уровне totals.
    const sumByOp = Object.values(totals.sewingByOp).reduce(
      (s, v) => s + v,
      0,
    );
    expect(sumByOp).toBe(totals.qtySewing);
  });

  test('Если есть только одна sewing-операция, показывается только одна колонка', () => {
    const { sewingColumns, totals } = projectShopfloorDisplay(
      {
        passports: [sewingOn(SEW_OVER_1, { sizeId: SIZE_S.id, qtyCut: 7 })],
      },
      sizeMeta,
    );
    expect(sewingColumns).toHaveLength(1);
    expect(sewingColumns[0]).toMatchObject({
      key: SEW_OVER_1.id,
      label: SEW_OVER_1.name,
      sortOrder: SEW_OVER_1.sortOrder,
    });
    expect(totals.sewingByOp[SEW_OVER_1.id]).toBe(7);
  });

  test('Если ни одной sewing-операции нет, sewingColumns пустой и матрица не ломается', () => {
    const { sewingColumns, colors, totals } = projectShopfloorDisplay(
      {
        passports: [
          // Только крой и упаковка — ни одного паспорта в SEWING.
          pp({ qtyCut: 4, status: PassportStatus.CREATED }),
          pp({ qtyGood: 5, status: PassportStatus.PACKED, hasOpenBox: false }),
        ],
      },
      sizeMeta,
    );
    expect(sewingColumns).toEqual([]);
    expect(totals.qtySewing).toBe(0);
    expect(totals.sewingByOp).toEqual({});
    // Цвета и стадии остаются на месте — просто без sewing-колонок.
    expect(colors.length).toBeGreaterThan(0);
  });

  test('Per-row и per-color totals сохраняют разбивку по операциям', () => {
    const { colors, totals } = projectShopfloorDisplay(
      {
        passports: [
          // Чёрный: S — Оверлок 1 (3), M — Киперка (5).
          sewingOn(SEW_OVER_1, {
            color: 'Чёрный',
            sizeId: SIZE_S.id,
            qtyCut: 3,
          }),
          sewingOn(SEW_KIP, {
            color: 'Чёрный',
            sizeId: SIZE_M.id,
            qtyCut: 5,
          }),
          // Белый: M — Оверлок 1 (2).
          sewingOn(SEW_OVER_1, {
            color: 'Белый',
            sizeId: SIZE_M.id,
            qtyCut: 2,
          }),
        ],
      },
      sizeMeta,
    );
    const black = colors.find((c) => c.colorKey === 'black')!;
    const white = colors.find((c) => c.colorKey === 'white')!;

    // Row-level: каждой строке начислили только её операцию.
    const blackS = black.rows.find((r) => r.sizeCode === 'S')!;
    const blackM = black.rows.find((r) => r.sizeCode === 'M')!;
    expect(blackS.sewingByOp[SEW_OVER_1.id]).toBe(3);
    expect(blackS.sewingByOp[SEW_KIP.id]).toBeUndefined();
    expect(blackM.sewingByOp[SEW_KIP.id]).toBe(5);
    expect(blackM.sewingByOp[SEW_OVER_1.id]).toBeUndefined();

    // Color totals: Σ по каждой операции по цвету.
    expect(black.totals.sewingByOp[SEW_OVER_1.id]).toBe(3);
    expect(black.totals.sewingByOp[SEW_KIP.id]).toBe(5);
    expect(black.totals.qtySewing).toBe(8);
    expect(white.totals.sewingByOp[SEW_OVER_1.id]).toBe(2);
    expect(white.totals.sewingByOp[SEW_KIP.id]).toBeUndefined();

    // Grand totals: Σ по всем цветам.
    expect(totals.sewingByOp[SEW_OVER_1.id]).toBe(5);
    expect(totals.sewingByOp[SEW_KIP.id]).toBe(5);
    expect(totals.qtySewing).toBe(10);
  });

  test('Pending-колонка ловит SEWING-паспорта без явной sewing-операции и стоит последней', () => {
    // Один паспорт SEWING-бакета с CUTTING-категорией (выдан швее до
    // первого OPERATION_SCAN), один — Оверлок 1.
    const { sewingColumns, totals } = projectShopfloorDisplay(
      {
        passports: [
          pp({
            status: PassportStatus.IN_PROGRESS,
            currentOperationCategory: OperationCategory.CUTTING,
            qtyCut: 6,
          }),
          sewingOn(SEW_OVER_1, { qtyCut: 4 }),
        ],
      },
      sizeMeta,
    );
    // Оверлок 1 + pending = 2 колонки, pending — последняя.
    expect(sewingColumns).toHaveLength(2);
    expect(sewingColumns[0].key).toBe(SEW_OVER_1.id);
    expect(sewingColumns[1].key).toBe(SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY);
    expect(totals.sewingByOp[SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY]).toBe(6);
    expect(totals.sewingByOp[SEW_OVER_1.id]).toBe(4);
    // Полный итог пошива — сумма обеих колонок.
    expect(totals.qtySewing).toBe(10);
  });

  test('Pending-колонка не показывается, если по ней Σ = 0', () => {
    const { sewingColumns } = projectShopfloorDisplay(
      { passports: [sewingOn(SEW_OVER_1, { qtyCut: 5 })] },
      sizeMeta,
    );
    expect(
      sewingColumns.find(
        (c) => c.key === SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY,
      ),
    ).toBeUndefined();
  });

  // Регрессия: главный продакшен-кейс, который раньше уезжал в pending.
  // Швея открыла смену на «Распошив», нажала «Принять крой», но ещё
  // не отдельно отсканировала на операцию (или вообще не сканирует —
  // на пилоте scan происходит редко, основной поток идёт через issue).
  // На этом шаге `Passport.currentOperationId` всё ещё CUT_DIVISION
  // (категория CUTTING), а sewing-операция живёт только в открытой
  // ShiftSession этой швеи. До фикса такой паспорт валился в «Ожидает» —
  // теперь должен сразу попадать в свою колонку.
  test('Issued-but-not-scanned: assignedShift раскладывает паспорт по реальной sewing-операции', () => {
    const { sewingColumns, totals } = projectShopfloorDisplay(
      {
        passports: [
          // 6 шт «Оверлок 1» — смена швеи на нём, ещё не сканировано.
          issuedToSeamstressOn(SEW_OVER_1, { qtyCut: 6 }),
          // 4 шт «Распошив» — другая швея, тоже без скана.
          issuedToSeamstressOn(SEW_KIP, { qtyCut: 4 }),
        ],
      },
      sizeMeta,
    );
    // Обе sewing-операции видимы; pending-колонки нет (всё распознано).
    expect(sewingColumns.map((c) => c.key)).toEqual([
      SEW_OVER_1.id, // sortOrder 80
      SEW_KIP.id, // sortOrder 90
    ]);
    expect(
      sewingColumns.find(
        (c) => c.key === SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY,
      ),
    ).toBeUndefined();
    // Метаданные колонок берутся из shift-операции, а не из «Деление
    // кроя» в currentOperation — иначе на дисплее у такого паспорта
    // была бы подпись «Деление кроя», что доменно неправильно.
    expect(sewingColumns[0]?.label).toBe(SEW_OVER_1.name);
    expect(sewingColumns[1]?.label).toBe(SEW_KIP.name);
    // qtySewing/sewingByOp инвариант сохранён.
    expect(totals.qtySewing).toBe(10);
    expect(totals.sewingByOp[SEW_OVER_1.id]).toBe(6);
    expect(totals.sewingByOp[SEW_KIP.id]).toBe(4);
  });

  // Если switch уже отсканировал паспорт явно (currentOperation =
  // SEWING) — приоритет за currentOperation, а не за shift-сменой.
  // Это страхует на случай, если швея взяла паспорт в смене на
  // Оверлоке 1 и потом перешла сама за Оверлок 2: «истина» — куда
  // паспорт реально съездил по событию OPERATION_SCAN.
  test('Явный OPERATION_SCAN перебивает assignedShift fallback', () => {
    const { sewingColumns, totals } = projectShopfloorDisplay(
      {
        passports: [
          // currentOperation = Оверлок 2, смена ещё открыта на Оверлоке 1.
          sewingOn(SEW_OVER_2, {
            qtyCut: 3,
            assignedShiftSewingOperationId: SEW_OVER_1.id,
            assignedShiftSewingOperationName: SEW_OVER_1.name,
            assignedShiftSewingOperationSortOrder: SEW_OVER_1.sortOrder,
          }),
        ],
      },
      sizeMeta,
    );
    expect(sewingColumns).toHaveLength(1);
    expect(sewingColumns[0]?.key).toBe(SEW_OVER_2.id);
    expect(totals.sewingByOp[SEW_OVER_2.id]).toBe(3);
    expect(totals.sewingByOp[SEW_OVER_1.id]).toBeUndefined();
  });

  // Pending теперь означает «реально некуда положить»: ни явной
  // sewing-операции (currentOperation), ни активной sewing-смены
  // у закреплённой швеи. Самый типичный пример — паспорт, у
  // которого `currentEmployeeId` уже снят (швея завершила работу,
  // но следующий исполнитель ещё не подхватил).
  test('Pending — только когда нет ни sewing currentOperation, ни sewing-смены у швеи', () => {
    const { sewingColumns, totals } = projectShopfloorDisplay(
      {
        passports: [
          // CUTTING, без assigned shift → действительно pending.
          pp({
            status: PassportStatus.IN_PROGRESS,
            currentOperationCategory: OperationCategory.CUTTING,
            currentOperationId: 'op-cut-division',
            qtyCut: 5,
          }),
        ],
      },
      sizeMeta,
    );
    expect(sewingColumns).toHaveLength(1);
    expect(sewingColumns[0]?.key).toBe(SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY);
    expect(totals.sewingByOp[SHOPFLOOR_DISPLAY_SEWING_PENDING_KEY]).toBe(5);
  });
});

describe('UI: light-theme dashboard на /shopfloor/display', () => {
  const board = readSrc('apps/web/app/shopfloor/display/display-board.tsx');
  const page = readSrc('apps/web/app/shopfloor/display/page.tsx');

  test('Используется light-theme: класс `display-screen--light`', () => {
    expect(board).toMatch(/display-screen--light/);
  });

  test('Убраны блоки «Активные заказы» и «Проблемы»', () => {
    // Старые компоненты больше не существуют на странице.
    expect(board).not.toMatch(/BlockActiveOrders/);
    expect(board).not.toMatch(/BlockProblems/);
    expect(board).not.toMatch(/Активные заказы/);
    // Слово «Проблемы» в README/доках допустимо, но в UI — больше нет.
    expect(board).not.toMatch(/Проблем(ы|ам)/);
    expect(board).not.toMatch(/listShopfloorOrders/);
  });

  test('Есть KPI-row с восемью карточками', () => {
    expect(board).toMatch(/data-testid="display-kpi-row"/);
    for (const label of [
      'Выпущено сегодня',
      'В работе',
      'Ждёт',
      'ОТК',
      'ВТО',
      'Упаковка',
      'Готово',
      'Брак',
    ]) {
      expect(board).toContain(label);
    }
  });

  test('Production flow matrix отрисована компонентом со всеми стадиями', () => {
    expect(board).toMatch(/data-testid="display-production-flow"/);
    expect(board).toMatch(/SHOPFLOOR_DISPLAY_MATRIX_STAGES/);
    expect(board).toMatch(/ProductionFlowMatrix/);
    expect(board).toMatch(/Поток производства/);
  });

  test('Sewing на матрице отрисовывается динамическими колонками из backend', () => {
    // Источник колонок — `summary.sewingColumns`, прокидывается в
    // ProductionFlowMatrix как отдельный prop. Никакого хардкода
    // «Оверлок/Киперка/Распошив» в TSX быть не должно: колонки
    // берутся из доменной модели операций.
    expect(board).toMatch(/sewingColumns/);
    expect(board).toMatch(/sewingColumns:\s*ShopfloorDisplaySewingColumnDto/);
    // UI разрезает SHOPFLOOR_DISPLAY_MATRIX_STAGES вокруг CUT и
    // вставляет sewing-колонки между «Крой» и «ОТК».
    expect(board).toMatch(/splitStagesAroundSewing/);
    // Значения берутся из `row.sewingByOp[col.key]` (а не пере-
    // вычисляются на клиенте).
    expect(board).toMatch(/sewingByOp\[/);
    // Захардкоженные русские названия sewing-операций в исходниках
    // дисплея категорически запрещены — это и есть главное обещание
    // «источник доменный».
    expect(board).not.toMatch(/Оверлок/);
    expect(board).not.toMatch(/Киперк/);
    expect(board).not.toMatch(/Распошив/);
  });

  test('Equipment panel — компактные плитки с иконкой и номером', () => {
    expect(board).toMatch(/data-testid="display-equipment-panel"/);
    expect(board).toMatch(/data-testid="display-equipment-grid"/);
    expect(board).toMatch(/display-equipment-tile/);
    expect(board).toMatch(/EquipmentIcon/);
    // Легенда статусов.
    expect(board).toMatch(/Онлайн/);
    expect(board).toMatch(/Простой/);
    expect(board).toMatch(/Оффлайн/);
    // Иконки оборудования по типам.
    expect(board).toMatch(/IconSewingMachine/);
    expect(board).toMatch(/IconCuttingTable/);
    expect(board).toMatch(/IconIron/);
    expect(board).toMatch(/IconQcMagnifier/);
    expect(board).toMatch(/IconBox/);
  });

  test('Read-only: нет <button>, <form>, onSubmit, onClick', () => {
    expect(board).not.toMatch(/<button/);
    expect(board).not.toMatch(/<form/);
    expect(board).not.toMatch(/onClick/);
    expect(board).not.toMatch(/onSubmit/);
  });

  test('Сохранён polling 5–10 секунд (healthy cadence)', () => {
    // Ровно 7 секунд (по ТЗ — окно 5–10, ADR-0007).
    expect(board).toMatch(/POLL_INTERVAL_MS\s*=\s*7000/);
    // Seconds clock в шапке всё ещё на `setInterval` — это дешевле,
    // чем ставить отдельный таймер. Polling сам ушёл на recursive
    // `setTimeout` (см. ниже).
    expect(board).toMatch(/setInterval/);
  });

  test('Polling переключается на degraded-cadence при ошибках', () => {
    // После первой же ошибки cadence удлиняется до
    // `POLL_INTERVAL_DEGRADED_MS` (15 c) — это снижает нагрузку на
    // backend в момент проблем и даёт ему время восстановиться.
    expect(board).toMatch(/POLL_INTERVAL_DEGRADED_MS\s*=\s*15000/);
    // Условие выбора cadence в планировщике (recursive setTimeout):
    // больше нуля ошибок — degraded, иначе healthy.
    expect(board).toMatch(/failuresRef\.current\s*>\s*0/);
  });

  test('Recursive setTimeout вместо setInterval для polling', () => {
    // Полл-tick планируется ТОЛЬКО из `finally` предыдущего, чтобы
    // запросы не наслаивались и cadence честно реагировал на backoff.
    expect(board).toMatch(/scheduleNext/);
    // Хелпер scheduleNext должен вызываться через `.finally(...)`,
    // а не из setInterval-цикла.
    expect(board).toMatch(/refresh\(\)\.finally\(scheduleNext\)/);
  });

  test('Fetch timeout с запасом (>= 5 c)', () => {
    // Старое 2500 мс почти всегда обрезало даже честные ответы при
    // лёгкой деградации сети. Новое значение — 6 c — комфортно
    // лежит выше реальной p99 latency `getDisplaySummary`.
    expect(board).toMatch(/FETCH_TIMEOUT_MS\s*=\s*6000/);
  });

  test('Soft-ошибки классифицируются по типу и не суммируются с auth', () => {
    // Плоский enum типов ошибок fetch'а.
    expect(board).toMatch(/type\s+FetchErrorKind/);
    for (const kind of [
      "'timeout'",
      "'network'",
      "'auth'",
      "'server'",
      "'client'",
      "'parse'",
    ]) {
      expect(board).toContain(kind);
    }
    // Auth НЕ должен инкрементировать `setFailures` (счётчик soft-
    // ошибок) — иначе истёкшая сессия маскируется под «Нет связи».
    expect(board).toMatch(/if\s*\(\s*kind\s*===\s*['"]auth['"]\s*\)/);
  });

  test('Snapshot последнего успешного ответа не очищается ошибкой', () => {
    // Контракт «retained snapshot»: catch-ветка `refresh` НЕ должна
    // вызывать `setSnap(... null ...)` или сброс на `initialSummary`.
    expect(board).toMatch(/Никогда не очищается ошибкой/);
    // Setter snapshot'а вызывается только в success-ветке.
    const snapWrites = board.match(/setSnap\(/g) ?? [];
    // Допустимы только: (1) initial state в useState, (2) success-апдейт,
    // (3) проставление lastSuccessAt после mount при initialSummary.
    expect(snapWrites.length).toBeLessThanOrEqual(3);
  });

  test('In-flight запрос корректно абортится на unmount', () => {
    // На unmount планировщик и AbortController должны быть очищены —
    // иначе fetch продолжит жить и попытается setState уже после
    // размонтирования.
    expect(board).toMatch(/inFlightCtrlRef/);
    expect(board).toMatch(/inFlightCtrlRef\.current\.abort\(\)/);
    expect(board).toMatch(/clearTimeout\(timerRef\.current\)/);
  });

  test('Display-status чип покрывает 4 состояния', () => {
    // Каждый из 4 модификаторов должен присутствовать в JSX —
    // online / degraded / offline / auth (см. CSS .display-status--*).
    for (const mod of ['online', 'degraded', 'offline', 'auth']) {
      expect(board).toMatch(
        new RegExp(`display-status--\\$\\{statusKind\\}`),
      );
      // `data-status` attribute с тем же ключом — для тестов и QA.
      expect(board).toContain(`'${mod}'`);
    }
  });

  test('RSC-обёртка `page.tsx` тянет единый display-summary endpoint', () => {
    expect(page).toMatch(/getShopfloorDisplaySummary/);
    expect(page).not.toMatch(/listShopfloorOrders/);
    expect(page).not.toMatch(/getProductionDashboard/);
  });
});

/**
 * Структурные layout-контракты fullscreen-экрана для TV.
 *
 * Эти проверки защищают «цепочку overflow + min-height: 0», без
 * которой матрица на 44" TV в fullscreen-режиме схлопывалась до
 * заголовков (см. фикс «TV layout / 44” fullscreen»). Тесты намеренно
 * structural (regex по CSS), а не визуальные — у проекта нет screenshot
 * runner'а, а ломкая цепочка высот ловится именно на уровне CSS-правил.
 */
describe('UI layout: fullscreen / TV geometry на /shopfloor/display', () => {
  const css = readSrc('apps/web/app/globals.css');
  const board = readSrc('apps/web/app/shopfloor/display/display-board.tsx');

  test('display-screen — fixed fullscreen с предсказуемой grid-row схемой', () => {
    expect(css).toMatch(/\.display-screen\s*\{[\s\S]*?position:\s*fixed/);
    expect(css).toMatch(/\.display-screen\s*\{[\s\S]*?inset:\s*0/);
    // header + KPI + board (1fr) — board строка должна жить в minmax(0,1fr),
    // иначе её min-content раздувает grid выше viewport.
    expect(css).toMatch(
      /\.display-screen\s*\{[\s\S]*?grid-template-rows:\s*auto\s+auto\s+minmax\(0,\s*1fr\)/,
    );
    // 100dvh — стабильнее на TV/embedded WebView.
    expect(css).toMatch(/\.display-screen\s*\{[\s\S]*?height:\s*100dvh/);
    // Сама обёртка ничего не скроллит — скроллятся только внутренние зоны.
    expect(css).toMatch(/\.display-screen\s*\{[\s\S]*?overflow:\s*hidden/);
  });

  test('display-board: двухколоночный grid + min-height/min-width: 0', () => {
    // Двухколоночный layout (production 2fr, equipment 1fr с минимумом 320px).
    expect(css).toMatch(
      /\.display-board\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*2fr\)\s+minmax\(320px,\s*1fr\)/,
    );
    expect(css).toMatch(/\.display-board\s*\{[\s\S]*?min-height:\s*0/);
    expect(css).toMatch(/\.display-board\s*\{[\s\S]*?min-width:\s*0/);
  });

  test('production / equipment колонки — flex column с min-height: 0', () => {
    expect(css).toMatch(
      /\.display-board__production[\s\S]*?\.display-board__equipment[\s\S]*?flex-direction:\s*column[\s\S]*?min-height:\s*0/,
    );
    expect(css).toMatch(
      /\.display-board__production\s*>\s*\.display-block,\s*\n\s*\.display-board__equipment\s*>\s*\.display-block\s*\{[\s\S]*?flex:\s*1\s+1\s+auto[\s\S]*?min-height:\s*0/,
    );
  });

  test('display-matrix__scroll — явный flex-child + scroll + min-height: 0', () => {
    // Главный фикс: scroll-область матрицы должна явно занимать
    // остаток высоты, иметь min-height: 0 и сама быть scroll-ancestor'ом.
    expect(css).toMatch(
      /\.display-matrix__scroll\s*\{[\s\S]*?flex:\s*1\s+1\s+auto/,
    );
    expect(css).toMatch(
      /\.display-matrix__scroll\s*\{[\s\S]*?min-height:\s*0/,
    );
    expect(css).toMatch(
      /\.display-matrix__scroll\s*\{[\s\S]*?overflow:\s*auto/,
    );
    // DOM-обёртка по-прежнему присутствует в JSX матрицы.
    expect(board).toMatch(/className="display-matrix__scroll"/);
  });

  test('display-equipment-grid — flex-child со своим внутренним скроллом', () => {
    expect(css).toMatch(
      /\.display-equipment-grid\s*\{[\s\S]*?flex:\s*1\s+1\s+auto[\s\S]*?min-height:\s*0[\s\S]*?overflow-y:\s*auto/,
    );
  });

  test('display-block — flex column с overflow: hidden и min-height: 0', () => {
    expect(css).toMatch(
      /\.display-block\s*\{[\s\S]*?flex-direction:\s*column[\s\S]*?min-height:\s*0[\s\S]*?overflow:\s*hidden/,
    );
  });

  test('display-empty заполняет пустой блок (а не лепится к заголовку)', () => {
    // Когда матрица/оборудование пустые, placeholder должен растянуться
    // и центрировать сообщение — иначе экран выглядит «полупустым».
    expect(css).toMatch(
      /\.display-empty\s*\{[\s\S]*?flex:\s*1\s+1\s+auto[\s\S]*?min-height:\s*0/,
    );
  });

  test('Sticky <th> матрицы — z-index >= 2 и непрозрачный фон', () => {
    // z-index ниже 2 раньше пускал color-row (z-index: 1) поверх sticky
    // на TV/WebKit при быстром скролле; background-clip фиксирует, что
    // под заголовком не «протекают» строки.
    expect(css).toMatch(
      /\.display-matrix__th\s*\{[\s\S]*?position:\s*sticky[\s\S]*?z-index:\s*2/,
    );
    expect(css).toMatch(
      /\.display-matrix__th\s*\{[\s\S]*?background-clip:\s*padding-box/,
    );
  });

  test('TV / large-display layer существует и не схлопывает board', () => {
    // Намеренно отдельный media query ≥ 1600px (выше десктопного 1199),
    // чтобы laptop/desktop-вид не перерастал в TV-режим случайно.
    expect(css).toMatch(/@media\s*\(min-width:\s*1600px\)/);
    // Внутри TV-слоя размер ячеек матрицы и плиток должен расти,
    // а не board — переключаться в одну колонку.
    const tvLayer =
      css.match(/@media\s*\(min-width:\s*1600px\)\s*\{[\s\S]*?\n\}/)?.[0] ??
      '';
    expect(tvLayer).toMatch(/\.display-matrix__cell/);
    expect(tvLayer).toMatch(/\.display-kpi__value/);
    // В TV-слое НЕ должно быть переключения board в одноколоночный режим.
    expect(tvLayer).not.toMatch(/grid-template-columns:\s*1fr\s*;/);
  });

  test('Single-column collapse — только узкие экраны (<= 1199px)', () => {
    // Защита от случайного триггера single-column режима на TV: правило
    // про `grid-template-columns: 1fr` должно сидеть только под
    // `max-width: 1199px`, и нигде в `min-width` слоях.
    expect(css).toMatch(
      /@media\s*\(max-width:\s*1199px\)\s*\{[\s\S]*?\.display-board\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
    );
  });

  test('body:has(.display-screen) изолирует страницу от глобального layout', () => {
    // На странице display-board глобальный `.app-main` не должен
    // оставлять padding/min-height: иначе под fixed-обёрткой может
    // возникнуть лишний scrollbar у body на TV.
    expect(css).toMatch(
      /body:has\(\.display-screen\)\s+\.app-main\s*\{[\s\S]*?padding:\s*0[\s\S]*?min-height:\s*0/,
    );
    expect(css).toMatch(
      /body:has\(\.display-screen\)\s*\{[\s\S]*?overflow:\s*hidden/,
    );
  });
});

describe('Backend: /api/shopfloor/display + equipment kind', () => {
  test('Контроллер объявляет GET display и сервис умеет getDisplaySummary', () => {
    const ctrl = readSrc(
      'apps/api/src/modules/shopfloor/shopfloor.controller.ts',
    );
    expect(ctrl).toMatch(/@Get\('display'\)/);
    expect(ctrl).toMatch(/getDisplaySummary\(\)/);

    const svc = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    expect(svc).toMatch(/getDisplaySummary/);
    expect(svc).toMatch(/projectShopfloorDisplay/);
    // KPI «Выпущено сегодня» — Σ qtyGood по PACKED-событиям UTC-сегодня.
    expect(svc).toMatch(/PassportEventType\.PACKED/);
    expect(svc).toMatch(/setUTCHours\(0, 0, 0, 0\)/);
  });

  test('getDisplaySummary гоняет независимые запросы параллельно', () => {
    // Три независимых запроса (eventMaxes / packedToday / equipment)
    // должны идти одним `Promise.all`, а не последовательно — это
    // основная backend-оптимизация против таймаутов polling-цикла.
    const svc = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    expect(svc).toMatch(/eventMaxesPromise/);
    expect(svc).toMatch(/packedTodayPromise/);
    expect(svc).toMatch(/equipmentPromise/);
    expect(svc).toMatch(
      /Promise\.all\(\[\s*eventMaxesPromise,\s*packedTodayPromise,\s*equipmentPromise/,
    );
  });

  test('listEquipmentStatus тянет equipment и activeShifts параллельно', () => {
    const svc = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    // equipment и activeShifts независимы — должны быть в одном Promise.all.
    expect(svc).toMatch(
      /const \[equipment, activeShifts\]\s*=\s*await Promise\.all\(/,
    );
  });

  test('Equipment status DTO включает `kind` для иконки', () => {
    const shared = readSrc('packages/shared/src/shopfloor.ts');
    expect(shared).toMatch(/SHOPFLOOR_EQUIPMENT_KINDS/);
    expect(shared).toMatch(/kind:\s*ShopfloorEquipmentKind/);

    const svc = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    expect(svc).toMatch(/pickEquipmentKind/);
    expect(svc).toMatch(/EQUIPMENT_KIND_PRIORITY/);
  });
});
