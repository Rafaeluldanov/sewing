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
    currentEmployeeId: null,
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
    // `currentEmployeeId != null` — обязательный признак «issued»;
    // без него bucketOf трактует это как master-rollback на CUT.
    currentEmployeeId: 'emp-issued',
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

  test('SHOPFLOOR_DISPLAY_MATRIX_STAGES — только статичные стадии (CUT/PACKING/FINISHED)', () => {
    // Контракт «единая логика WIP по всему потоку»:
    //   - SEWING давно вынесен в динамические split-колонки `▶/✔`
    //     (`ShopfloorDisplayDto.sewingRoute`);
    //   - QC/QC_DONE и WTO/WTO_DONE НА ДИСПЛЕЕ тоже стали split'ами
    //     `▶/✔` (см. `display-board.tsx` → `buildProcessSplits` и
    //     `docs/screens.md §9a.4`). Их не должно быть в матрице как
    //     отдельных одно-клеточных колонок — иначе оператор видит
    //     дубль смысла («ОТК» ⊕ «Проверено ОТК») и историческое
    //     накопление done.
    //   - В static-списке остаются только зоны, у которых нет
    //     отдельной семантики «в работе vs ожидает следующего»:
    //     CUT, PACKING, FINISHED (плюс Брак, который не stage).
    expect(SHOPFLOOR_DISPLAY_MATRIX_STAGES).not.toContain('SEWING');
    expect(SHOPFLOOR_DISPLAY_MATRIX_STAGES).not.toContain('QC');
    expect(SHOPFLOOR_DISPLAY_MATRIX_STAGES).not.toContain('QC_DONE');
    expect(SHOPFLOOR_DISPLAY_MATRIX_STAGES).not.toContain('WTO');
    expect(SHOPFLOOR_DISPLAY_MATRIX_STAGES).not.toContain('WTO_DONE');
    // Static-зоны: КРОЙ → … (split'ы) → УПАКОВКА → ГОТОВО.
    expect(Array.from(SHOPFLOOR_DISPLAY_MATRIX_STAGES)).toEqual([
      'CUT',
      'PACKING',
      'FINISHED',
    ]);
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
    // первого OPERATION_SCAN), один — Оверлок 1. Чтобы попасть в
    // SEWING-бакет (а не в CUT после rollback мастера), CUTTING-
    // паспорт должен иметь `currentEmployeeId != null` — это и есть
    // признак «issued, ещё не scanned» (см. `bucketOf` rollback edge).
    const { sewingColumns, totals } = projectShopfloorDisplay(
      {
        passports: [
          pp({
            status: PassportStatus.IN_PROGRESS,
            currentOperationCategory: OperationCategory.CUTTING,
            currentEmployeeId: 'emp-pending',
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
    // Паспорт «issued, ещё не scanned» (швее назначен, но
    // OPERATION_SCAN не пришёл и активная sewing-смена не подтянута).
    // `currentEmployeeId != null` обязателен — иначе bucketOf
    // считает это master-rollback и кладёт в CUT-бакет, см. правило
    // «CUTTING + employeeId === null → CUT».
    const { sewingColumns, totals } = projectShopfloorDisplay(
      {
        passports: [
          pp({
            status: PassportStatus.IN_PROGRESS,
            currentOperationCategory: OperationCategory.CUTTING,
            currentEmployeeId: 'emp-pending',
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

  test('Sewing на матрице отрисовывается split-колонками ▶/✔ из sewingRoute', () => {
    // Источник колонок — `summary.sewingRoute` (агрегат маршрутных
    // sewing-шагов). Каждая операция превращается в ДВЕ колонки:
    // ▶ (inProgress) и ✔ (done). Никакого захардкоженного списка
    // операций в TSX быть не должно — колонки берутся из доменной
    // модели (Operation × OrderRouteStep + currentRouteStepIndex,
    // см. `buildSewingRoute` на backend).
    expect(board).toMatch(/sewingRoute/);
    expect(board).toMatch(/sewingRoute:\s*ShopfloorDisplayRouteOperationDto/);
    // UI разрезает SHOPFLOOR_DISPLAY_MATRIX_STAGES вокруг CUT и
    // вставляет sewing-колонки между «Крой» и «ОТК» — splitStagesAroundSewing
    // и SHOPFLOOR_DISPLAY_MATRIX_STAGES остаются обязательными.
    expect(board).toMatch(/splitStagesAroundSewing/);
    // Старая single-column модель (sewingByOp / sewingColumns) на UI
    // больше не используется: матрица читает только sewingRoute.
    expect(board).not.toMatch(/sewingByOp\[/);
    expect(board).not.toMatch(/ShopfloorDisplaySewingColumnDto/);
    // Захардкоженные русские названия sewing-операций в исходниках
    // дисплея категорически запрещены — это и есть главное обещание
    // «источник доменный».
    expect(board).not.toMatch(/Оверлок/);
    expect(board).not.toMatch(/Киперк/);
    expect(board).not.toMatch(/Распошив/);
    // Значения для split-ячеек берутся из routeQty(lookup, sizeCode, dir),
    // а не считаются на клиенте отдельным проходом по passport'ам.
    expect(board).toMatch(/routeQty\(/);
    // Шапка операции — два th с маркерами, оба подписываются data-testid
    // для тестов и QA. После унификации (sewing + ОТК + ВТО под одним
    // `SplitSubHeader`) testid выбирается динамически в зависимости
    // от типа split'а, но для sewing-операций сохраняется ровно
    // прежний contractный литерал `display-matrix-sew-in/done` —
    // существующие e2e/интеграционные тесты ловят его именно так.
    expect(board).toMatch(/['"`]display-matrix-sew-in['"`]/);
    expect(board).toMatch(/['"`]display-matrix-sew-done['"`]/);
    // Иконки строк ровно те, что в ТЗ.
    expect(board).toContain('▶');
    expect(board).toContain('✔');
    // Отдельного route-блока больше нет (маршрут встроен в матрицу).
    expect(board).not.toMatch(/SewingRouteBlock/);
    expect(board).not.toMatch(/SewingRouteOpCard/);
    expect(board).not.toMatch(/data-testid="display-sewing-route"/);
    expect(board).not.toMatch(/data-testid="display-sewing-route-op"/);
  });

  // Регрессия: ОТК и ВТО на дисплее тоже отрисованы как split-блоки
  // ▶/✔ (унификация с sewing). Отдельных колонок «Проверено ОТК» /
  // «ВТО завершено» в матрице больше быть не должно — иначе на TV
  // оператор видит дубль смысла и историческое накопление done.
  // Источник правды для split'ов QC/ВТО — те же `qtyQc/qtyQcDone/
  // qtyWto/qtyWtoDone`, что и раньше; меняется только способ отрисовки.
  test('ОТК и ВТО — split-колонки ▶/✔ (нет отдельных «Проверено ОТК» / «ВТО завершено»)', () => {
    // Унифицированный конструктор split-блоков на UI содержит сразу
    // и sewing-операции, и QC, и ВТО. Это и есть «единая логика WIP
    // по всему потоку» из ТЗ.
    expect(board).toMatch(/buildProcessSplits/);
    expect(board).toMatch(/SplitSubHeader/);
    expect(board).toMatch(/SplitHeadIcon/);
    // Каждый из трёх типов split'а (sew/qc/wto) — пометка в шапке
    // через `data-testid="display-matrix-split-<kind>"`. Без QC/WTO
    // split'ов оператор не сможет увидеть разделение «в работе vs
    // ждёт следующего этапа» для ОТК и ВТО — а ради этого вся
    // унификация и затевалась.
    expect(board).toMatch(/data-testid=\{?[`'"]display-matrix-split-/);
    // ОТК и ВТО берут свои значения из тех же `row.qtyQc`/`qtyQcDone`/
    // `row.qtyWto`/`qtyWtoDone`, что и раньше (проекция уже даёт
    // правильную семантику «в работе / ждёт следующего», см.
    // `bucketOf` в shopfloor-projection).
    expect(board).toMatch(/row\.qtyQc\b/);
    expect(board).toMatch(/row\.qtyQcDone\b/);
    expect(board).toMatch(/row\.qtyWto\b/);
    expect(board).toMatch(/row\.qtyWtoDone\b/);
    // Старые «отдельные колонки» ОТК/ВТО исчезли:
    //   - в `summaryQty(row, s)` для PACKING/FINISHED по-прежнему
    //     берутся `s.qtyPacking/qtyFinished`, но ОТК/ВТО в матрицу
    //     уже не приходят как отдельные `s` — потому что их в
    //     `SHOPFLOOR_DISPLAY_MATRIX_STAGES` больше нет (см. отдельный
    //     контракт-тест выше);
    //   - живой UI-текст «Проверено ОТК»/«Проверено ВТО»/«ВТО
    //     завершено» категорически не должен оставаться в TSX
    //     (исторические надписи из старой модели колонок).
    expect(board).not.toMatch(/Проверено\s+ОТК/);
    expect(board).not.toMatch(/Проверено\s+ВТО/);
    expect(board).not.toMatch(/ВТО\s+завершено/);
    // SHOPFLOOR_STAGE_LABELS.QC = «ОТК», SHOPFLOOR_STAGE_LABELS.WTO =
    // «ВТО» — UI должен использовать именно эти доменные подписи как
    // имя split-блока (а не хардкодить русские строки).
    expect(board).toMatch(/SHOPFLOOR_STAGE_LABELS\.QC/);
    expect(board).toMatch(/SHOPFLOOR_STAGE_LABELS\.WTO/);
  });

  // Регрессия: split-таблица показывает ТЕКУЩЕЕ накопление WIP, а не
  // исторический факт «эта операция когда-то выполнена». Старая логика
  // `currentRouteStepIndex > step.index → done` вешала ✔ на пройденные
  // шаги — это категорически запрещено новой семантикой (см.
  // `docs/screens.md §9a.4` и блок-комментарий `buildSewingRoute`).
  test('buildSewingRoute не накапливает done на исторически пройденных шагах (idx > step.index)', () => {
    const service = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    // Старого условия больше нет ни в коде, ни в комментарии-описании
    // алгоритма. (Текстовый match достаточно строгий: новая логика
    // оперирует `idx === step.index`, а не `idx > step.index`.)
    expect(service).not.toMatch(/idx\s*>\s*step\.index/);
    // Новые гварды для ✔ — без исполнителя и ровно на текущем шаге.
    expect(service).toMatch(/currentEmployeeId\s*===\s*null/);
    expect(service).toMatch(/idx\s*===\s*step\.index/);
  });

  test('Шапка split-блоков (sewing/ОТК/ВТО) двухстрочная: имя в row-1, ▶/✔ в row-2', () => {
    // Имя split-блока должно жить в собственном <th> с colSpan=2 и
    // классом `display-matrix__th--sewing-op` — это row-1 шапки.
    // (Класс исторически называется `--sewing-op`, но используется
    // и для ОТК/ВТО — он задаёт «надзаголовок над парой ▶/✔», а
    // не «sewing-специфичный стиль».)
    expect(board).toMatch(/display-matrix__th--sewing-op/);
    expect(board).toMatch(/colSpan=\{2\}/);
    expect(board).toMatch(/scope="colgroup"/);
    // Постоянные колонки (Размер/Крой/Упаковка/...) — единый rowSpan=2,
    // чтобы выровнять их с двумя строками шапки split-блоков.
    expect(board).toMatch(/rowSpan=\{2\}/);
    // Подколонки ▶/✔ — отдельный sub-header компонент во второй
    // строке шапки. После унификации (sewing + ОТК + ВТО под одним
    // абстрактным `ProcessSplit`) компонент называется
    // `SplitSubHeader`. Старые inline-варианты не должны
    // воскреснуть.
    expect(board).toMatch(/SplitSubHeader/);
    expect(board).not.toMatch(/function SewingOpHeader\b/);
    expect(board).not.toMatch(/function SewingOpSubHeader\b/);
    expect(board).toMatch(/display-matrix__th--sub/);
    // Имя операции и маркеры разнесены по разным элементам:
    // в шапке-имени НЕТ символов ▶/✔, а в шапке-маркерах НЕТ
    // span'а с именем операции (`display-matrix__th-op`).
    // Проверяем структурно: после первого открытия
    // `display-matrix__th--sewing-op` до его закрытия не должно
    // встретиться маркеров ▶/✔.
    const opHeaderMatch = board.match(
      /display-matrix__th--sewing-op[\s\S]*?<\/th>/,
    );
    expect(opHeaderMatch).not.toBeNull();
    expect(opHeaderMatch?.[0]).not.toMatch(/▶|✔/);
    // А в саб-хедере (display-matrix__th--sub) НЕТ имени операции:
    // имя вынесено наружу, остаются только маркеры.
    expect(board).not.toMatch(
      /display-matrix__th--sub[^<]*<span className="display-matrix__th-op"/,
    );
  });

  test('CSS: двухстрочная шапка имеет компактные подколонки и липкую вторую строку', () => {
    const css = readSrc('apps/web/app/globals.css');
    // Под именем операции — рамка-разделитель + центрирование.
    expect(css).toMatch(/\.display-matrix__th--sewing-op\b/);
    expect(css).toMatch(
      /\.display-matrix__th--sewing-op\s*\{[\s\S]*?text-align:\s*center/,
    );
    // Вторая строка шапки прилипает не к top:0, а ниже первой —
    // иначе подколонки накладываются на имя операции при скролле.
    expect(css).toMatch(/\.display-matrix__th--sub\s*\{[\s\S]*?top:\s*[\d.]+rem/);
    // Подколонки ▶/✔ имеют фиксированную узкую ширину (синхронно
    // выравниваются с ячейками тела таблицы, которые тоже узкие).
    expect(css).toMatch(/\.display-matrix__th--sew-in[\s\S]*?width:\s*[\d.]+rem/);
    expect(css).toMatch(/\.display-matrix__th--sew-done[\s\S]*?border-left:\s*0/);
  });

  test('Между sewing-операциями стоит ровно одна вертикальная линия (op-divider)', () => {
    // Фронт: класс `display-matrix__op-divider` навешивается ТОЛЬКО на
    // «открывающую» (▶) ячейку каждой sewing-операции, кроме первой.
    // Гейт «второй и последующие» сидит внутри унифицированных
    // helper'ов потоковых разделителей (`splitInDividerClass`,
    // `splitHeadDividerClass`, `splitSubDividerOn`) и проверяется по
    // характерному `idx > 0` в `kind === 'sew'`-ветке — это и есть
    // обещание «у первой sewing-операции линии нет, у всех остальных есть».
    expect(board).toMatch(/display-matrix__op-divider/);
    expect(board).toMatch(/splitInDividerClass/);
    expect(board).toMatch(
      /idx\s*>\s*0[\s\S]{0,80}display-matrix__op-divider/,
    );
    // ✔-колонка (`display-matrix__cell--sew-done`, `display-matrix__th--sew-done`)
    // НИКОГДА не получает класс divider'а — иначе между ▶ и ✔ внутри
    // одной операции вылезла бы вторая вертикальная линия и пара
    // ▶/✔ распалась бы визуально.
    expect(board).not.toMatch(
      /display-matrix__cell--sew-done[^"`]*display-matrix__op-divider/,
    );
    expect(board).not.toMatch(
      /display-matrix__th--sew-done[^"`]*display-matrix__op-divider/,
    );
    // CSS: divider — тонкая «спокойная» полупрозрачная линия слева.
    // Чёрный «жирный» border-left = 1px solid #000 запрещён: на TV
    // он режет глаз и создаёт ощущение колонок-в-колонках.
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(
      /\.display-matrix__op-divider\s*\{[\s\S]*?border-left:\s*2px\s+solid\s+rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.15\s*\)/,
    );
    // Защита от «двойной линии» внутри одной операции: на ✔-ячейке
    // `border-left` явно сброшен (на ▶ при этом продолжает работать
    // `display-matrix__op-divider`).
    expect(css).toMatch(
      /\.display-matrix__cell--sew-done\s*\{[\s\S]*?border-left:\s*none/,
    );
  });

  test('Потоковые разделители: КРОЙ │ SEWING │ ОТК │ ВТО │ УПАКОВКА │ ГОТОВО', () => {
    // Контракт UI: матрица визуально разрезается на зоны маршрута
    // классами:
    //   - `display-matrix__cut-divider` — после КРОЙ (`border-right`);
    //   - `display-matrix__qc-divider`  — перед ОТК split-блоком
    //                                     (`border-left` на ▶-ячейке);
    //   - `display-matrix__wto-divider` — перед ВТО split-блоком
    //                                     И перед УПАКОВКОЙ (тот же
    //                                     класс с двух сторон, см.
    //                                     `afterStageDividerClass`).
    // Все три типа существуют отдельно от `display-matrix__op-divider`,
    // который отвечает только за линии МЕЖДУ sewing-операциями —
    // никакого пересечения / дублирования.
    expect(board).toMatch(/display-matrix__cut-divider/);
    expect(board).toMatch(/display-matrix__qc-divider/);
    expect(board).toMatch(/display-matrix__wto-divider/);
    // Линия после КРОЙ не должна стоять, если sewing-зона пустая
    // (иначе на стыке КРОЙ↔ОТК склеятся `border-right` cut-divider'а
    // и `border-left` qc-divider'а — это и есть «двойная линия»).
    // Гейт `s === 'CUT' && hasSewing` должен быть в исходниках
    // буквально — это и есть обещание «нет двойных линий».
    expect(board).toMatch(/s\s*===\s*'CUT'\s*&&\s*hasSewing/);
    // qc-divider навешивается на split-блок ОТК (`kind === 'qc'`):
    // даже без sewing-операций ровно одна полупрозрачная линия между
    // КРОЙ и ОТК сохраняется, а cut-divider при этом гасится.
    expect(board).toMatch(/sp\.kind\s*===\s*'qc'/);
    // wto-divider — на split-блоке ВТО (`kind === 'wto'`) И на
    // колонке `PACKING` (вход в зону упаковки). Один и тот же класс
    // с обеих сторон по контракту — это даёт «единый язык» зональных
    // разделителей.
    expect(board).toMatch(/sp\.kind\s*===\s*'wto'/);
    expect(board).toMatch(/s\s*===\s*'PACKING'/);
    // Sewing-divider не сломан: класс `display-matrix__op-divider`
    // продолжает существовать в TSX и навешивается так же, как раньше
    // (проверка существующего теста выше остаётся в силе).
    expect(board).toMatch(/display-matrix__op-divider/);
    // Потоковые разделители не должны попадать на ✔-подколонку
    // split-блока (`display-matrix__cell--sew-done` /
    // `display-matrix__th--sew-done`) — иначе внутри пары ▶/✔
    // вылезла бы вторая вертикальная линия и блок распался бы
    // визуально. Покрываем все три типа потоковых линий.
    expect(board).not.toMatch(
      /display-matrix__cell--sew-done[^"`]*display-matrix__(cut|qc|wto)-divider/,
    );
    expect(board).not.toMatch(
      /display-matrix__th--sew-done[^"`]*display-matrix__(cut|qc|wto)-divider/,
    );
  });

  test('CSS: cut/qc/wto-divider — тонкие полупрозрачные линии тем же цветом, что и op-divider', () => {
    const css = readSrc('apps/web/app/globals.css');
    // Линия после КРОЙ — `border-right: 2px solid rgba(0,0,0,.15)`.
    // ВАЖНО: именно `border-right`, не `border-left`, чтобы не
    // конфликтовать с qc-divider'ом на следующей колонке.
    expect(css).toMatch(
      /\.display-matrix__cut-divider\s*\{[\s\S]*?border-right:\s*2px\s+solid\s+rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.15\s*\)/,
    );
    // Линии перед ОТК и ВТО — `border-left: 2px solid rgba(0,0,0,.15)`.
    // Цвет/толщина у обоих стыков совпадают с op-divider'ом, чтобы все
    // потоковые разделители читались как одна визуальная система.
    expect(css).toMatch(
      /\.display-matrix__qc-divider\s*\{[\s\S]*?border-left:\s*2px\s+solid\s+rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.15\s*\)/,
    );
    expect(css).toMatch(
      /\.display-matrix__wto-divider\s*\{[\s\S]*?border-left:\s*2px\s+solid\s+rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.15\s*\)/,
    );
    // Защита от случайного дублирования: cut-divider НЕ должен
    // ставить `border-left` (это работа qc/wto-divider'а), а они,
    // в свою очередь, НЕ должны ставить `border-right` (это работа
    // cut-divider'а).
    expect(css).not.toMatch(
      /\.display-matrix__cut-divider\s*\{[^}]*border-left:/,
    );
    expect(css).not.toMatch(
      /\.display-matrix__qc-divider\s*\{[^}]*border-right:/,
    );
    expect(css).not.toMatch(
      /\.display-matrix__wto-divider\s*\{[^}]*border-right:/,
    );
  });

  // ---------------------------------------------------------------------
  // Подсветка узкого места (bottleneck) в split-блоках.
  //
  // Контракт продукта: если у какой-то операции потока (sewing → QC →
  // ВТО) накопился самый большой ✔-буфер (паспорта, ждущие перехода
  // на следующий этап) — значит, тормозит ИМЕННО СЛЕДУЮЩАЯ операция.
  // UI должен мягко (coral pulse) подсветить ВЕСЬ её столбец — шапку,
  // обе подколонки ▶/✔, body-rows и итоги. Алгоритм — чисто
  // визуальный, считается из уже агрегированных processSplits на
  // клиенте; backend / DTO / polling не трогаем.
  //
  // Edge-cases, которые тест намеренно фиксирует через структурные
  // matcher'ы (без рендера):
  //   - пороговая константа `BOTTLENECK_MIN_QTY = 10` (защита от
  //     ложных срабатываний на старте смены — см. блок-комментарий
  //     в `display-board.tsx`);
  //   - выбор подсветки именно `processSplits[i + 1]` (СЛЕДУЮЩАЯ
  //     операция, а не «победитель по ✔»);
  //   - bottleneck-классы реально живут и в TSX, и в CSS.
  // ---------------------------------------------------------------------
  test('Bottleneck: пороговая константа и эвристика выбора СЛЕДУЮЩЕЙ операции', () => {
    // Порог 10 — точное значение из ТЗ. Любое его «ослабление» (на 1,
    // на 5, на «без порога») сделает экран мигающим уже на первых
    // паспортах смены — это и есть основная причина, почему порог
    // вынесен в именованную константу, а не зашит литералом.
    expect(board).toMatch(/BOTTLENECK_MIN_QTY\s*=\s*10\b/);
    // Эвристика — отдельная функция `detectBottlenecks`. Без неё
    // диффузная логика «где подсветить» расползлась бы по JSX и
    // повторно проверить её было бы нечем.
    expect(board).toMatch(/function\s+detectBottlenecks\b/);
    // Ключевой инвариант: подсвечивается именно `processSplits[i + 1]`,
    // а не сам «победитель по ✔». Эту строку проверяем буквально —
    // именно она и есть смысл всей фичи (без неё мы бы подсвечивали
    // ту операцию, которая как раз работает быстрее всех).
    expect(board).toMatch(/processSplits\[\s*i\s*\+\s*1\s*\]/);
    // Гейт на минимум — `< BOTTLENECK_MIN_QTY` означает «ничего не
    // подсвечиваем». Без явного early-return карта получалась бы
    // непустой даже при maxDone === 0 (если бы кто-то поправил
    // условие на `<=`), и экран бы пульсировал на пустом потоке.
    expect(board).toMatch(/maxDone\s*<\s*BOTTLENECK_MIN_QTY/);
    // Хук в самом ProductionFlowMatrix вызывает detectBottlenecks
    // через useMemo — пересчёт только при смене splits/totals,
    // а не на каждом «секундном» ререндере часов.
    expect(board).toMatch(/useMemo[\s\S]{0,80}detectBottlenecks/);
  });

  test('Bottleneck: подсветка вешается на ВЕСЬ столбец (header + sub-header + body + totals)', () => {
    // Header row-1 (имя split-блока) получает свой класс +
    // вспомогательный span-маркер ⚠. Без модификации шапки оператор
    // не поймёт, какая именно колонка «горит» — пульс на body-ячейках
    // без подсказки в шапке читается как «ошибка отрисовки».
    expect(board).toMatch(/display-matrix__th--bottleneck/);
    expect(board).toMatch(/display-matrix__bottleneck-mark/);
    expect(board).toContain('⚠');
    // Sub-header (▶/✔) и body-cells используют один общий класс
    // `display-matrix__bottleneck-col` — ровно один источник
    // визуального правила, который покрывает всю вертикаль.
    expect(board).toMatch(/display-matrix__bottleneck-col/);
    // Класс должен присутствовать и для ▶, и для ✔: подсвечиваем
    // ВЕСЬ столбец операции, а не одну её половину.
    // Простейшая структурная гарантия — общий `bnClass`-локал,
    // который вкручивается в className обеих ячеек пары.
    expect(board).toMatch(/bottlenecks\.has\(\s*sp\.key\s*\)/);
  });

  test('Bottleneck CSS: переменная цвета + класс пульса + плавные keyframes', () => {
    const css = readSrc('apps/web/app/globals.css');
    // Цвет вынесен в CSS-переменную, чтобы его можно было перебить
    // под конкретный TV/branding без редактирования всех правил.
    // Значение — coral `#fb7185` из ТЗ; никаких алертных красных.
    expect(css).toMatch(
      /--display-bottleneck-color:\s*#fb7185\b/,
    );
    // Сам класс пульсирующего фона.
    expect(css).toMatch(/\.display-matrix__bottleneck-col\s*\{/);
    // Анимация — мягкая (≥ 2 c, чтобы «дышать», а не «мигать»),
    // ease-in-out, бесконечный цикл. Резкое мигание на TV
    // оператора утомляет — это явно прописано в ТЗ.
    expect(css).toMatch(
      /\.display-matrix__bottleneck-col\s*\{[\s\S]*?animation:\s*display-bottleneck-pulse\s+2\.4s\s+ease-in-out\s+infinite/,
    );
    // Keyframes именно с этим именем (используются в animation выше).
    expect(css).toMatch(/@keyframes\s+display-bottleneck-pulse\s*\{/);
    // Coral pulse использует rgba именно от `#fb7185` (251, 113, 133)
    // в keyframes — иначе цвет анимации разъедется с переменной.
    expect(css).toMatch(
      /@keyframes\s+display-bottleneck-pulse\s*\{[\s\S]*?rgba\(\s*251\s*,\s*113\s*,\s*133\s*,/,
    );
    // Header-маркер ⚠ — сабкласс с минимальным `margin-left` и
    // `font-size`, чтобы не ломать вертикальный ритм шапки.
    expect(css).toMatch(/\.display-matrix__bottleneck-mark\s*\{/);
  });

  // ---------------------------------------------------------------------
  // «Полный маршрут» на дисплее (контракт: 0/0-операции тоже видны).
  //
  // Backend (`buildSewingRoute`) теперь возвращает ВСЕ sewing-операции
  // активных order-route snapshots, даже если по операции сейчас 0/0.
  // Это нужно для bottleneck-эвристики (`processSplits[i + 1]`):
  // если перед пустой операцией накопилось ✔ ≥ BOTTLENECK_MIN_QTY,
  // именно эту пустую операцию мы и должны подсветить. Если же
  // фронт «защитит экран от пустоты» фильтром по totals — UI снова
  // не сможет показать «следующая операция простаивает».
  //
  // Эти structural-проверки фиксируют главные frontend-инварианты:
  //   1. `buildProcessSplits` не имеет фильтра типа
  //      `.filter(sp => sp.totalIn || sp.totalDone)` ни на sewing,
  //      ни на QC/WTO — в matrix отдаётся всё, что пришло из DTO.
  //   2. `detectBottlenecks` ходит по `processSplits[i + 1]` без
  //      каких-либо предварительных фильтраций (этот инвариант уже
  //      проверяется выше — сейчас явно повторяем рядом, чтобы
  //      рефакторщик видел оба гварда вместе).
  //   3. Документация (`docs/screens.md §9a.4`) обновлена и
  //      содержит явный пример «Оверлок ✔ 32 → Киперка 0/0
  //      подсвечена», иначе следующий разработчик логично решит
  //      «нулевая операция = баг» и снова добавит фильтр.
  // ---------------------------------------------------------------------
  test('Full route: processSplits не фильтруется по totals (0/0 операции остаются видимы)', () => {
    // Для sewing: `buildProcessSplits` мапит `summary.sewingRoute`
    // 1:1 в split'ы. Никаких .filter по `totalIn`/`totalDone` в TSX
    // быть не должно — иначе бэкендный «полный маршрут» снова
    // схлопнется на UI до «только активные операции».
    expect(board).not.toMatch(
      /\.filter\(\s*\(?\s*sp\b[^)]*\)\s*=>\s*sp\.totalIn\b/,
    );
    expect(board).not.toMatch(
      /\.filter\(\s*\(?\s*sp\b[^)]*\)\s*=>\s*sp\.totalDone\b/,
    );
    expect(board).not.toMatch(/sp\.totalIn\s*\|\|\s*sp\.totalDone/);
    expect(board).not.toMatch(/sp\.totalIn\s*\+\s*sp\.totalDone\s*>\s*0/);
    // Для QC/WTO (всегда видимы) — тот же запрет: никакого
    // «спрячем, если row.qtyQc + row.qtyQcDone === 0».
    expect(board).not.toMatch(/row\.qtyQc\s*\+\s*row\.qtyQcDone\s*===\s*0/);
    expect(board).not.toMatch(/row\.qtyWto\s*\+\s*row\.qtyWtoDone\s*===\s*0/);
    // Прямой контракт: процесс-split строится из `summary.sewingRoute`
    // без промежуточной фильтрации. Регекс ловит «buildProcessSplits …
    // sewingRoute … return splits» без инлайн-`.filter`.
    const builderMatch = board.match(
      /function\s+buildProcessSplits[\s\S]*?\n\}/,
    );
    expect(builderMatch).not.toBeNull();
    expect(builderMatch![0]).toMatch(/sewingRoute/);
    expect(builderMatch![0]).not.toMatch(/\.filter\(/);
  });

  test('Full route: detectBottlenecks читает processSplits[i + 1] без totals-фильтра (повтор-страховка)', () => {
    // Этот инвариант уже зафиксирован выше отдельным тестом про
    // bottleneck-константу/эвристику; повторяем рядом со «full route»-
    // блоком, чтобы при будущих рефакторах любой человек, читающий
    // «full route» smoke, видел: «нулевая операция нужна именно
    // bottleneck'у, и связь между ними — буквально processSplits[i + 1]».
    expect(board).toMatch(/function\s+detectBottlenecks\b/);
    expect(board).toMatch(/processSplits\[\s*i\s*\+\s*1\s*\]/);
    // Внутри detectBottlenecks нет .filter по totals — только
    // компаратор по `s.totalDone` для выбора «победителя ✔», без
    // отбрасывания соседей.
    const fnMatch = board.match(/function\s+detectBottlenecks[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).not.toMatch(/\.filter\(/);
  });

  // ---------------------------------------------------------------------
  // Инвариант «операция активного маршрута НЕ МОЖЕТ исчезнуть».
  //
  // Это структурные проверки на уровне исходника `shopfloor.service.ts`,
  // которые ловят регрессы ДО выкатки на TV (без подъёма базы).
  // Конкретно фиксируем:
  //
  //   1. В `buildSewingRoute` НЕТ skip-условий вида
  //      `if (cells.size === 0)`, `if (rows.length === 0)`,
  //      `if (!hasData)` — любой такой ранний return снова
  //      обнулял бы блок 0/0-операции и оператор видел бы
  //      «исчезшую» операцию на матрице.
  //   2. В `buildSewingRoute` есть fallback на `orderItemSizes`
  //      (размеры из OrderItem). Без него заказ со всеми
  //      PACKED-паспортами или вообще без паспортов снова
  //      получал бы `rows = []` и блок выглядел бы пустым.
  //   3. Список orderId для запроса route-snapshots берётся
  //      из активных `Order` (а не из `passports.map(p.orderId)`):
  //      иначе активный заказ без паспортов выпадал бы из
  //      `routeSteps` и его операции исчезали бы целиком.
  //   4. Defensive warn-log на случай будущих регрессов: если
  //      операция из routeSteps не попала в результат,
  //      `console.warn('DISPLAY: missing operation …')` поможет
  //      найти причину быстрее, чем дебаг через UI монитора.
  // ---------------------------------------------------------------------
  test('Invariant: buildSewingRoute не имеет skip-условий по cells/rows/hasData', () => {
    const svc = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    const fnMatch = svc.match(
      /function\s+buildSewingRoute\b[\s\S]*?\n\}\n/,
    );
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![0];
    expect(body).not.toMatch(/if\s*\(\s*cells\.size\s*===\s*0\s*\)/);
    expect(body).not.toMatch(/if\s*\(\s*rows\.length\s*===\s*0\s*\)/);
    expect(body).not.toMatch(/if\s*\(\s*!hasData\s*\)/);
    // Раннего return-а из горячего цикла по operationId / opMeta тоже
    // быть не должно: блок ВСЕГДА создаётся для каждой операции
    // маршрута, даже с rows=[].
    expect(body).not.toMatch(/blocks\.delete\(/);
  });

  test('Invariant: buildSewingRoute fallback на OrderItem.size (orderItemSizes)', () => {
    const svc = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    // Сигнатура расширена параметром `orderItemSizes: Map<string,
    // Set<string>>`.
    expect(svc).toMatch(/orderItemSizes:\s*Map<string,\s*Set<string>>/);
    // Fallback используется в Pass 1b.
    expect(svc).toMatch(/orderItemSizes\.get\(orderId\)/);
    // Вызывающий передаёт fallback в `buildSewingRoute` четвёртым
    // аргументом.
    expect(svc).toMatch(
      /buildSewingRoute\(\s*sewingRouteInput,\s*routeSteps,\s*sizes,\s*orderItemSizes/,
    );
  });

  test('Invariant: route-snapshots тянутся из активных Order, а не из passports.map', () => {
    const svc = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    // Старый источник списка orderId («только заказы с живыми
    // паспортами») — главный root cause «исчезающего» активного
    // заказа без паспортов. Эта строка не должна вернуться.
    expect(svc).not.toMatch(
      /Array\.from\(\s*new Set\(\s*passports\.map\(\s*\(p\)\s*=>\s*p\.orderId\)/,
    );
    // Новая выборка — `prisma.order.findMany` с тем же фильтром
    // активных статусов (DONE/CANCELLED исключены). Тянем `items`,
    // чтобы построить fallback `orderItemSizes`.
    expect(svc).toMatch(/activeOrdersPromise\s*=\s*this\.prisma\.order\.findMany/);
    expect(svc).toMatch(/notIn:\s*\[OrderStatus\.DONE,\s*OrderStatus\.CANCELLED\]/);
    expect(svc).toMatch(/items:\s*\{\s*select:\s*\{\s*sizeId:\s*true\s*\}\s*\}/);
    // routeSteps — потомки активных order'ов, и фильтр по
    // `OperationCategory.SEWING` остался прежним.
    expect(svc).toMatch(
      /orderIdsForRoute\s*=\s*activeOrders\.map\(\s*\(o\)\s*=>\s*o\.id\)/,
    );
    expect(svc).toMatch(/operation:\s*\{\s*category:\s*OperationCategory\.SEWING\s*\}/);
  });

  test('Invariant: defensive warn-log на пропущенные операции маршрута', () => {
    const svc = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    // Будущий регресс «операция исчезла» сразу всплывёт в логах API,
    // а не в спорадических ручных проверках UI цеха.
    expect(svc).toMatch(/DISPLAY: missing operation in sewingRoute/);
  });

  test('Full route: docs/screens.md §9a.4 описывает «весь маршрут + 0/0 + bottleneck-пример»', () => {
    const docs = readSrc('docs/screens.md');
    // Документация должна явно объяснять: дисплей показывает весь
    // route snapshot активных заказов, операции 0/0 — нормальное
    // состояние, и приводить пример «Оверлок ✔ 32 → Киперка 0/0
    // подсвечена». Без этого фрагмента следующий разработчик
    // увидит на проде нулевую колонку и логично её спрячет.
    expect(docs).toMatch(/весь\s+(?:маршрут|route)/i);
    expect(docs).toMatch(/0\s*\/\s*0/);
    expect(docs).toMatch(/Оверлок[\s\S]*32[\s\S]*Киперк/);
    expect(docs).toMatch(/bottleneck|узкое\s+место/i);
  });

  test('Bottleneck не трогает backend/DTO/polling/equipment/alerts', () => {
    // Чисто frontend-фича. Проверяем структурно:
    //   - в DTO ни нового поля, ни нового types-namespace'а;
    //   - в JSX нет ни звуков, ни alert/window-уведомлений
    //     («не добавлять alerts/звуки» из ТЗ).
    const shared = readSrc('packages/shared/src/shopfloor.ts');
    expect(shared).not.toMatch(/[Bb]ottleneck/);
    expect(board).not.toMatch(/window\.alert\(/);
    expect(board).not.toMatch(/new\s+Audio\(/);
    expect(board).not.toMatch(/\.play\(\s*\)/);
    // Polling-константы остаются прежними — bottleneck-эвристика
    // не должна была переписать cadence или ввести forced-refresh.
    expect(board).toMatch(/POLL_INTERVAL_MS\s*=\s*3000/);
    expect(board).toMatch(/POLL_INTERVAL_DEGRADED_MS\s*=\s*15000/);
  });

  test('Никаких процентов готовности в матрице', () => {
    // Контракт «display = только цифры»: проценты, completion-формулы
    // и слово «готовность» в матрице не рендерятся. Поиск ведётся по
    // живому JSX/строкам компонента (не по комментариям/доке).
    // Допустимы только line-комментарии (`//`) — их выкусываем перед
    // проверкой, чтобы не путать описание архитектуры с реальным UI.
    const noLineComments = board.replace(/\/\/[^\n]*/g, '');
    // Никаких математических расчётов «*100», «/100», «.toFixed(» —
    // это типичные следы percentage-вывода.
    expect(noLineComments).not.toMatch(/\*\s*100\b/);
    expect(noLineComments).not.toMatch(/\/\s*100\b/);
    expect(noLineComments).not.toMatch(/\.toFixed\(/);
    // Сам символ % в JSX-литералах тоже отсутствует.
    expect(noLineComments).not.toMatch(/>\s*%\s*</);
    expect(noLineComments).not.toMatch(/'%'/);
    expect(noLineComments).not.toMatch(/"%"/);
    expect(noLineComments).not.toMatch(/`\$\{[^`]+\}\s*%`/);
  });

  test('Equipment panel — компактная сетка с номером, текущими размерами и цветом статуса', () => {
    // Компактный блок: плитки несут displayNumber и актуальные размеры
    // активной работы (если есть). Статус оборудования читается
    // ЦВЕТОМ всей плитки (`display-equipment-tile--online/warning/
    // offline`) — отдельного status-dot'а больше нет. Никаких имён
    // оборудования, ФИО, текста статуса, больших карточек.
    expect(board).toMatch(/data-testid="display-equipment-panel"/);
    expect(board).toMatch(/data-testid="display-equipment-grid"/);
    expect(board).toMatch(/data-testid="display-equipment-tile"/);
    expect(board).toMatch(/display-equipment-tile/);
    expect(board).toMatch(/display-equipment-tile__num/);
    // displayNumber берётся напрямую из DTO.
    expect(board).toMatch(/eq\.displayNumber/);
    // currentSizes — компактная строка размеров под номером,
    // источник: `ShopfloorEquipmentStatusDto.currentSizes`. Поле
    // должно использоваться в JSX (а не «висеть» в DTO без потребителя).
    expect(board).toMatch(/display-equipment-tile__sizes/);
    expect(board).toMatch(/eq\.currentSizes/);
    // Status-dot убран намеренно: его сигнал теперь несёт ЦВЕТ всей
    // плитки. Любое возвращение `display-equipment-tile__dot` обратно
    // в JSX/CSS считается регрессом.
    expect(board).not.toMatch(/display-equipment-tile__dot/);
    // Никаких eq.name, eq.employeeName и «тяжёлых» EquipmentIcon-SVG
    // внутри плитки — это всё «большие карточки», от которых мы
    // намеренно отказались. Тонкая line-иконка из lucide-react
    // (см. отдельный тест ниже) — допустимое исключение: она остаётся
    // ВТОРИЧНЫМ маркером и не возвращает прежний «карточный» вес.
    expect(board).not.toMatch(/<EquipmentIcon\b/);
    expect(board).not.toMatch(/\bEquipmentIcon\b/);
    expect(board).not.toMatch(/display-equipment-tile__name/);
    expect(board).not.toMatch(/eq\.employeeName/);
    expect(board).not.toMatch(/eq\.name\b/);
    // Старая «полная» легенда статусов (Онлайн/Простой/Оффлайн) убрана —
    // её роль выполняет цвет самой плитки + компактный totals-чип.
    expect(board).not.toMatch(/display-equipment__legend/);
  });

  test('Equipment tile CSS: компактная строка размеров nowrap+ellipsis, без раздувания плитки', () => {
    const css = readSrc('apps/web/app/globals.css');
    // Стиль существует и ведёт себя «компактно»: одна строка,
    // line-height: 1, ellipsis при переполнении — иначе плитка
    // ломает грид при «M,L,XL» или длинном размере.
    expect(css).toMatch(/\.display-equipment-tile__sizes\b/);
    expect(css).toMatch(
      /\.display-equipment-tile__sizes\s*\{[\s\S]*?line-height:\s*1\b/,
    );
    expect(css).toMatch(
      /\.display-equipment-tile__sizes\s*\{[\s\S]*?white-space:\s*nowrap/,
    );
    expect(css).toMatch(
      /\.display-equipment-tile__sizes\s*\{[\s\S]*?text-overflow:\s*ellipsis/,
    );
  });

  test('Equipment tile — тонкая line-иконка (швейная машина / утюг для SEWING/IRONING)', () => {
    // На плитке появилась маленькая иконка типа оборудования, но
    // ровно как ВТОРИЧНЫЙ маркер: основной сигнал — номер + текущие
    // размеры; статус читается ЦВЕТОМ всей плитки (без status-dot'а).
    // Источник иконки — `eq.kind` (`ShopfloorEquipmentKind` из DTO),
    // маппинг — компонент `EquipmentKindIcon` в display-board.tsx.
    //
    // Для PACKING/CUTTING/QC используем lucide-react (Package, Scissors,
    // Search). Для SEWING и IRONING в `lucide-react@1.9.0` нет
    // подходящих иконок: прежние `Shirt`/`Heater` визуально читались
    // как «футболка» и «обогреватель», что путало оператора. Поэтому
    // SEWING и IRONING обслуживают локальные тонкие SVG
    // `IconSewingMachine` / `IconIron` (тот же line-style, что у
    // lucide-иконок).
    expect(board).toMatch(/from\s+['"]lucide-react['"]/);
    // Локальный компонент с фиксированной сигнатурой `({ kind })`.
    expect(board).toMatch(/function\s+EquipmentKindIcon\s*\(\s*\{\s*kind/);
    // Использование внутри плитки — рядом с `displayNumber`, без
    // отдельного слота в гриде плитки.
    expect(board).toMatch(/<EquipmentKindIcon\s+kind=\{eq\.kind\}/);

    // Прямые маркеры для пяти известных категорий — фиксируем, что
    // мы НЕ свернули таблицу к одному «фолбэку», который может молча
    // обнулиться при ребранде. SEWING и IRONING — локальные SVG,
    // остальные три — lucide-иконки.
    // SEWING/IRONING — это локальные SVG-иконки. Допустимы две формы
    // привязки к категории: либо инлайн-стрелка `(props) => <IconX .../>`,
    // либо именованный рендер `renderSewingIcon` / `renderIronIcon`,
    // у которого внутри тоже стоит соответствующий `<IconX>` (lint
    // `react/display-name` мешает оставить инлайн-форму).
    expect(board).toMatch(
      /SEWING:\s*(?:renderSewingIcon\b|\(\s*\{\s*className\s*\}\s*\)\s*=>\s*<IconSewingMachine\b)/,
    );
    expect(board).toMatch(
      /IRONING:\s*(?:renderIronIcon\b|\(\s*\{\s*className\s*\}\s*\)\s*=>\s*<IconIron\b)/,
    );
    // Для именованной формы дополнительно проверяем, что
    // `renderSewingIcon` действительно ссылается на `<IconSewingMachine>`
    // (а не на любой другой компонент).
    expect(board).toMatch(
      /const\s+renderSewingIcon\b[\s\S]*?<IconSewingMachine\b/,
    );
    expect(board).toMatch(/const\s+renderIronIcon\b[\s\S]*?<IconIron\b/);
    expect(board).toMatch(/PACKING:\s*lucide\(Package\)/);
    expect(board).toMatch(/CUTTING:\s*lucide\(Scissors\)/);
    expect(board).toMatch(/QC:\s*lucide\(Search\)/);
    // `OTHER` (и любая будущая «непонятная» категория) — иконку не
    // рисуем, плитка остаётся в прежнем виде без пустого слота.
    expect(board).toMatch(/OTHER:\s*null/);

    // Регрессия: SEWING больше НЕ должен ложиться на `Shirt` (футболка),
    // а IRONING — на `Heater` (обогреватель). Главное — чтобы Shirt/Heater
    // больше не импортировались из lucide-react и не использовались как
    // JSX-компоненты. (Упоминания в JSDoc-комментариях допустимы — там
    // объясняется, почему мы от них ушли.)
    expect(board).not.toMatch(/SEWING:\s*Shirt\b/);
    expect(board).not.toMatch(/IRONING:\s*Heater\b/);
    expect(board).not.toMatch(/<Shirt\b/);
    expect(board).not.toMatch(/<Heater\b/);
    // В импорт-листе lucide-react тоже не должно остаться Shirt/Heater.
    const lucideImport = board.match(/import\s*\{[^}]*\}\s*from\s*['"]lucide-react['"]/);
    expect(lucideImport).not.toBeNull();
    expect(lucideImport![0]).not.toMatch(/\bShirt\b/);
    expect(lucideImport![0]).not.toMatch(/\bHeater\b/);

    // Локальные SVG-иконки определены и в line-style:
    // currentColor + fill="none" + thin stroke.
    expect(board).toMatch(/function\s+IconSewingMachine\s*\(/);
    expect(board).toMatch(/function\s+IconIron\s*\(/);
    // Класс на самой иконке (CSS приглушает opacity, задаёт размер).
    expect(board).toMatch(/'display-equipment-tile__icon'/);
    // Тонкая обводка фиксируется в JSX lucide-обёртки — это и есть
    // «line»-иконка.
    expect(board).toMatch(/strokeWidth=\{1\.5\}/);
    // Старый emoji-helper и его switch на эмодзи больше не должны
    // существовать — иначе на плитке параллельно жили бы две версии
    // иконок и сигнал терялся.
    expect(board).not.toMatch(/function\s+getEquipmentIcon\s*\(/);
    expect(board).not.toMatch(/getEquipmentIcon\(eq\.kind\)/);
    expect(board).not.toMatch(/'🧵'/);
    expect(board).not.toMatch(/'📦'/);
    expect(board).not.toMatch(/'🔥'/);
    expect(board).not.toMatch(/'🔍'/);
    expect(board).not.toMatch(/'✂️'/);

    // В блоке EquipmentPanel разрешены только локальные иконки
    // `IconSewingMachine` и `IconIron` (под SEWING/IRONING) — больше
    // никаких StageIcon-style SVG (`IconBox`, `IconQcMagnifier`,
    // `IconCuttingTable`, `IconCheck`): они шире и «жирнее»
    // вторичной line-иконки. EquipmentKindIcon (и его
    // implementation-блок c `IconSewingMachine`/`IconIron`) живёт
    // прямо за `EquipmentPanel`, поэтому отрезаем по нему.
    const equipmentBlock = board.slice(
      board.indexOf('function EquipmentPanel'),
      board.indexOf('function parseDisplayNumber'),
    );
    expect(equipmentBlock).not.toMatch(/<IconBox\b/);
    expect(equipmentBlock).not.toMatch(/<IconQcMagnifier\b/);
    expect(equipmentBlock).not.toMatch(/<IconCuttingTable\b/);
    expect(equipmentBlock).not.toMatch(/<IconCheck\b/);
    // Имя оборудования (eq.name) внутри плитки по-прежнему не должно
    // появляться — иконка не должна тащить за собой подпись.
    expect(equipmentBlock).not.toMatch(/eq\.name\b/);

    // CSS: иконка приглушена (opacity 0.65 — заметно мягче, чем у
    // emoji-варианта) и физически мельче родительского числа.
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.display-equipment-tile__icon\b/);
    expect(css).toMatch(
      /\.display-equipment-tile__icon\s*\{[\s\S]*?opacity:\s*0\.65\b/,
    );
    expect(css).toMatch(
      /\.display-equipment-tile__icon\s*\{[\s\S]*?width:\s*0?\.\d+em/,
    );
    expect(css).toMatch(
      /\.display-equipment-tile__icon\s*\{[\s\S]*?height:\s*0?\.\d+em/,
    );
    // Старый `.display-equipment-tile__dot` тоже не должен остаться
    // в CSS — иначе появится «висячий» класс без потребителя.
    expect(css).not.toMatch(/\.display-equipment-tile__dot\b/);
  });

  test('Equipment status — ONLINE/WARNING/OFFLINE по currentSizes, без time-based порога', () => {
    // Новая бизнес-семантика для TV-витрины (см.
    // `ShopfloorService.listEquipmentStatus` и `docs/screens.md §9a.5`):
    //
    //   - OFFLINE — нет смены или `equipment.active = false`;
    //   - WARNING — смена есть, паспорт в работе нет (currentSizes пуст);
    //   - ONLINE  — смена есть И есть паспорт в работе.
    //
    // Зелёная плитка должна означать ровно «реально шьётся прямо
    // сейчас», а не «недавно сканировал». Это закрывает регрессию
    // ложно-зелёного станка с открытой сменой и без паспорта.
    const svc = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');

    // Ветка OFFLINE: явно проверяем `!eq.active || !shift`.
    expect(svc).toMatch(/if\s*\(\s*!eq\.active\s*\|\|\s*!shift\s*\)/);
    // Ветка ONLINE: `currentSizes.length > 0`.
    expect(svc).toMatch(
      /else if\s*\(\s*currentSizes\.length\s*>\s*0\s*\)\s*\{[\s\S]*?status\s*=\s*'ONLINE'/,
    );
    // WARNING — fallback else.
    expect(svc).toMatch(
      /else\s*\{[\s\S]*?status\s*=\s*'WARNING'/,
    );

    // Старая time-based ветка (`WARNING_AFTER_MS`) больше не должна
    // управлять статусом: ни константа, ни сравнение `ageMs <= ...`
    // в исходнике не присутствуют.
    expect(svc).not.toMatch(/WARNING_AFTER_MS/);
    expect(svc).not.toMatch(/ageMs\s*<=/);

    // currentSizes считается ДО status (новый порядок), иначе мы бы
    // не могли использовать его длину для ветвления.
    const fnStart = svc.indexOf('async listEquipmentStatus');
    const fnEnd = svc.indexOf('// DISPLAY SUMMARY', fnStart);
    const fn = svc.slice(fnStart, fnEnd);
    const sizesIdx = fn.indexOf('const currentSizes');
    const statusIdx = fn.indexOf('let status: ShopfloorEquipmentStatus');
    expect(sizesIdx).toBeGreaterThan(0);
    expect(statusIdx).toBeGreaterThan(sizesIdx);

    // `lastActivityAt` остаётся в DTO как диагностический ISO-таймстамп
    // (не управляет цветом плитки, но контракт сохранён).
    expect(svc).toMatch(/lastActivityAt/);
  });

  test('Equipment tile — статус через цвет, статус-модификаторы CSS', () => {
    // Тон плитки задаётся классом `display-equipment-tile--<status>`
    // (online/warning/offline). data-status дублирует значение для
    // тестов и QA.
    expect(board).toMatch(
      /display-equipment-tile--\$\{eq\.status\.toLowerCase\(\)\}/,
    );
    expect(board).toMatch(/data-status=\{eq\.status\}/);
    // CSS-правила существуют под каждый статус — это и есть «цвет
    // вместо текста».
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.display-equipment-tile--online\b/);
    expect(css).toMatch(/\.display-equipment-tile--warning\b/);
    expect(css).toMatch(/\.display-equipment-tile--offline\b/);
    // Грид компактный: 4–6 колонок (auto-fill / minmax(56px,1fr)).
    expect(css).toMatch(
      /\.display-equipment-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(56px,\s*1fr\)\)/,
    );
  });

  test('Read-only: нет <button>, <form>, onSubmit, onClick', () => {
    expect(board).not.toMatch(/<button/);
    expect(board).not.toMatch(/<form/);
    expect(board).not.toMatch(/onClick/);
    expect(board).not.toMatch(/onSubmit/);
  });

  test('Сохранён polling в healthy-cadence (1–10 секунд) с богатой защитой от ложных «Нет связи»', () => {
    // Базовый poll healthy-cadence — `POLL_INTERVAL_MS = 3000` (см.
    // блок-комментарий у константы в `display-board.tsx`). 3 c — это
    // осознанное решение «живая картина на TV», которое работает
    // только в связке с богатой защитой (degraded fallback,
    // FETCH_TIMEOUT_MS, MAX_NETWORK_GRACE, visibility recovery,
    // recursive setTimeout). Уменьшать ниже 1 c, увеличивать выше
    // 10 c или менять на setInterval нельзя — ломается ровно эта
    // защита. Поэтому диапазон, а не точное число.
    const match = board.match(/POLL_INTERVAL_MS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    const poll = Number(match![1]);
    expect(poll).toBeGreaterThanOrEqual(1000);
    expect(poll).toBeLessThanOrEqual(10000);
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

  // -------------------------------------------------------------------
  // Адаптив «под каждый экран» (globals.css → секция «Адаптив монитора»,
  // docs/display-board.md §9.4). Слоёв шесть, и у каждого своя роль;
  // самое хрупкое — что «ручные» слои (телефон/планшет) НЕ должны
  // обрезать контент, а киоск-слои НЕ должны включать внешний скролл.
  // -------------------------------------------------------------------

  test('Компактный слой (планшет/телефон) даёт витрине внутренний скролл', () => {
    // До этого слоя при схлопывании board'а в одну колонку панель
    // оборудования уезжала под `overflow: hidden` и была недостижима:
    // ни скролла страницы (`body:has(.display-screen){overflow:hidden}`),
    // ни скролла блока.
    const compact =
      css.match(
        /@media\s*\(max-width:\s*1199px\)\s*and\s*\(max-height:\s*1399px\)\s*\{[\s\S]*?\n\}/,
      )?.[0] ?? '';
    expect(compact).not.toBe('');
    expect(compact).toMatch(/\.display-screen\s*\{[\s\S]*?overflow-y:\s*auto/);
    // `max-content`, а не `auto`: у грида с определённой высотой
    // auto-строка ужимается до min-content (а он = 0 из-за цепочки
    // `min-height: 0`) и матрица схлопывается в несколько пикселей.
    expect(compact).toMatch(
      /\.display-screen\s*\{[\s\S]*?grid-template-rows:\s*max-content\s+max-content\s+max-content/,
    );
    // Матрица сохраняет СВОЙ скролл (иначе теряются sticky-шапки),
    // но ограничена долей экрана.
    expect(compact).toMatch(
      /\.display-matrix__scroll\s*\{[\s\S]*?max-height:\s*\d+dvh/,
    );
  });

  test('Портретный киоск (TV вертикально) остаётся киоском, board — стопкой', () => {
    // Отличаем от планшета по высоте вьюпорта: 1080×1920 / 2160×3840
    // дают >= 1400px, ни один планшет столько в портрете не выдаёт.
    const portrait =
      css.match(
        /@media\s*\(orientation:\s*portrait\)\s*and\s*\(min-height:\s*1400px\)\s*\{[\s\S]*?\n\}/,
      )?.[0] ?? '';
    expect(portrait).not.toBe('');
    // Никакого внешнего скролла: до экрана на стене никто не дотянется.
    expect(portrait).toMatch(/\.display-screen\s*\{[\s\S]*?overflow:\s*hidden/);
    // Матрица сверху, оборудование под ней — обе зоны со своим скроллом.
    expect(portrait).toMatch(
      /\.display-board\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0,\s*[\d.]+fr\)\s+minmax\(0,\s*1fr\)/,
    );
    expect(portrait).toMatch(
      /\.display-equipment-grid\s*\{[\s\S]*?overflow-y:\s*auto/,
    );
  });

  test('Липкая колонка «Размер» — вторая ось sticky у матрицы', () => {
    // При горизонтальном скролле матрицы (на телефоне — всегда, на TV —
    // при маршруте из 8+ операций) цифры не должны терять «адрес».
    expect(css).toMatch(
      /\.display-matrix__row-label\s*\{[\s\S]*?position:\s*sticky[\s\S]*?left:\s*0/,
    );
    // Фон обязателен и непрозрачен — иначе под меткой просвечивают
    // уезжающие ячейки.
    expect(css).toMatch(
      /\.display-matrix__row-label\s*\{[\s\S]*?background:\s*var\(--display-bg-card\)/,
    );
    // Угловая ячейка липнет по двум осям и лежит выше sticky-шапки (2).
    expect(css).toMatch(
      /\.display-matrix__th--first\s*\{[\s\S]*?left:\s*0[\s\S]*?z-index:\s*5/,
    );
    // Заголовок цветовой группы растянут colSpan'ом на всю таблицу,
    // поэтому липнет вложенный span, а не сама ячейка.
    expect(board).toMatch(/display-matrix__color-label-inner/);
    expect(css).toMatch(
      /\.display-matrix__color-label-inner\s*\{[\s\S]*?position:\s*sticky/,
    );
  });

  test('Мобильное меню не перекрывает низ витрины', () => {
    // `.mobile-nav` — fixed, z-index 25 (выше витрины) и на
    // `/shopfloor/display` единственный способ уйти со страницы у
    // ADMIN/SHOP_MANAGER с телефона: глобальный header тут скрыт.
    // Отступ вешаем через `:has()`, чтобы у учётки DISPLAY (меню не
    // рендерится) на зальном киоске не было пустой полосы снизу.
    expect(css).toMatch(
      /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?body:has\(\.mobile-nav\)\s+\.display-screen\s*\{[\s\S]*?padding-bottom/,
    );
  });

  test('viewportTier в display-board.tsx зеркалит css-слои', () => {
    // Поле `tier` в mount-логе — единственный способ понять с реального
    // TV/планшета, в какой слой попал экран. Значения должны совпадать
    // с брейкпоинтами globals.css (см. docs/display-board.md §9.4).
    expect(board).toMatch(/function viewportTier\(/);
    expect(board).toMatch(/'portrait-kiosk'/);
    expect(board).toMatch(/width\s*>=\s*1600\s*\)\s*return\s*'tv'/);
    expect(board).toMatch(/width\s*<=\s*767\s*\)\s*return\s*'phone'/);
    expect(board).toMatch(/width\s*<=\s*1199\s*\)\s*return\s*'compact'/);
    expect(board).toMatch(/kind:\s*'viewport'[\s\S]{0,220}tier:\s*viewportTier\(/);
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
    // Сервис вызывается из контроллера; сигнатура расширилась
    // опциональным `query` (см. divisionCode-фильтр), поэтому матчим
    // `getDisplaySummary(...)`, а не пустые скобки.
    expect(ctrl).toMatch(/getDisplaySummary\(/);

    const svc = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    expect(svc).toMatch(/getDisplaySummary/);
    expect(svc).toMatch(/projectShopfloorDisplay/);
    // KPI «Выпущено сегодня» — Σ qtyGood по PACKED-событиям UTC-сегодня.
    expect(svc).toMatch(/PassportEventType\.PACKED/);
    expect(svc).toMatch(/setUTCHours\(0, 0, 0, 0\)/);
  });

  // ---------------------------------------------------------------------
  // Фильтр по подразделению (CompanyDivision.code)
  // ---------------------------------------------------------------------
  test('Контракт `?divisionCode=…` валидируется Zod и тянется до Prisma `where`', () => {
    const sharedShop = readSrc('packages/shared/src/shopfloor.ts');
    expect(sharedShop).toMatch(/ShopfloorDisplayQuerySchema/);
    expect(sharedShop).toMatch(
      /divisionCode:\s*z\.string\(\)\.trim\(\)\.min\(1\)\.optional\(\)/,
    );

    const ctrl = readSrc(
      'apps/api/src/modules/shopfloor/shopfloor.controller.ts',
    );
    // Query валидируется тем же ZodValidationPipe, что и остальные DTO.
    expect(ctrl).toMatch(/ShopfloorDisplayQuerySchema/);
    expect(ctrl).toMatch(/ZodValidationPipe\(ShopfloorDisplayQuerySchema\)/);

    const svc = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    // Backend filter — никакой постфактум-фильтрации в проекции /
    // на клиенте быть не должно. Фильтр Prisma собирается через
    // `buildOrderDivisionFilter` по `companyDivision.code`.
    expect(svc).toMatch(/query\.divisionCode/);
    expect(svc).toMatch(/resolveDisplayDivisionCode/);
    expect(svc).toMatch(/buildOrderDivisionFilter/);
    expect(svc).toMatch(/companyDivision: \{ code: divisionCode \}/);
  });

  test('Web shopfloor-api пробрасывает divisionCode в запрос', () => {
    const api = readSrc('apps/web/lib/shopfloor-api.ts');
    expect(api).toMatch(/divisionCode\?:\s*string/);
    // Должен явно класть параметр в searchParams, а не дописывать вручную URL.
    expect(api).toMatch(/searchParams: divisionCode \? \{ divisionCode \}/);
  });

  test('RSC `page.tsx` читает searchParams.divisionCode и пробрасывает в API', () => {
    const page = readSrc('apps/web/app/shopfloor/display/page.tsx');
    expect(page).toMatch(/searchParams\?\.divisionCode/);
    // Web-уровень принимает legacy `?division=…` как deprecated alias
    // и тихо мапит его на `divisionCode`.
    expect(page).toMatch(/searchParams\?\.division/);
    expect(page).toMatch(/getShopfloorDisplaySummary/);
  });

  test('Order forms (create/edit) содержат select подразделения через CompanyDivisionDto', () => {
    const newForm = readSrc('apps/web/app/orders/new/new-order-form.tsx');
    expect(newForm).toMatch(/CompanyDivisionDto/);
    expect(newForm).toMatch(/name="companyDivisionId"/);

    const editForm = readSrc(
      'apps/web/app/orders/[id]/edit/edit-order-form.tsx',
    );
    expect(editForm).toMatch(/CompanyDivisionDto/);
    expect(editForm).toMatch(/name="companyDivisionId"/);

    const actions = readSrc('apps/web/app/orders/actions.ts');
    // buildCreateDto / buildUpdateDto оба должны прокидывать
    // companyDivisionId через общий parser, иначе бэкенд не получит поле.
    expect(actions).toMatch(/parseCompanyDivisionId/);
    expect(actions).toMatch(/companyDivisionId/);
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

  test('listEquipmentStatus тянет equipment, activeShifts и openMasterCalls параллельно', () => {
    const svc = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    // equipment, activeShifts и openMasterCalls независимы — должны
    // быть в одном Promise.all (master-calls добавлен с MVP «Мастер
    // цеха», см. `docs/domain.md §10a`).
    expect(svc).toMatch(
      /const \[equipment, activeShifts, openMasterCalls\]\s*=\s*await Promise\.all\(/,
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
