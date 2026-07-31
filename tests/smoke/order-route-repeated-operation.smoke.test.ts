/**
 * Smoke-тест «Повтор операции в маршруте заказа».
 *
 * Одна операция может стоять в маршруте НЕСКОЛЬКО раз: ОТК и ВТО
 * чередуются со швейными шагами (проверка между этапами и финальная).
 * Раньше это было запрещено на всех ярусах сразу, и запреты были
 * рассыпаны по коду — поэтому стережём именно их снятие, покомпонентно.
 * Тихая поломка здесь выглядит как «второй ОТК не закрывается» или
 * «швея не получила денег за второй проход», а не как ошибка.
 *
 * Полноценного React-рендерера в vitest нет (см.
 * `order-route-snapshot.smoke.test.ts`), поэтому контракт фиксируем
 * текстовыми проверками исходников; арифметику планировщика покрывает
 * unit-тест `unit/route-amendment-plan.test.ts`.
 *
 * Что стережём:
 *   1. Палитра холста НЕ прячет операцию, уже стоящую в маршруте, —
 *      иначе второе вхождение просто нечем поставить.
 *   2. Идентичность шага — позиция снимка (`sourceIndex`), а не
 *      `operationId`: за строкой снимка висят per-order расценка, норма
 *      времени и поразмерные переопределения.
 *   3. Ключи чипов в React уникальны на вхождение.
 *   4. Продвижение паспорта считает ПРОХОДЫ, а не факт «операция закрыта».
 *   5. Сдельное начисление различает проходы (`OperationEntry.passOrdinal`).
 *   6. ОТК / ВТО / упаковка требуют столько проверок, сколько шагов в
 *      маршруте.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const CANVAS = 'apps/web/components/orders/amendments/route-amendment-tab.tsx';
const AMENDMENTS = 'packages/shared/src/amendments.ts';
const AMEND_SERVICE =
  'apps/api/src/modules/order-amendments/order-amendments.service.ts';
const PASSPORTS = 'apps/api/src/modules/passports/passports.service.ts';
const EARNINGS = 'apps/api/src/modules/earnings/earnings.service.ts';

describe('холст маршрута — палитра не прячет операции из маршрута', () => {
  test('пул не фильтруется по «уже в маршруте»', () => {
    const src = readSrc(CANVAS);
    // Прежний фильтр `!usedIds.has(op.id)` убирал чип после переноса —
    // ровно то, что ломало чередующиеся операции.
    expect(src).not.toMatch(/usedIds\.has\(op\.id\)/);
    expect(src).toMatch(/countByOperationId/);
  });

  test('backend отдаёт палитру со счётчиком вхождений, а не с вырезанными операциями', () => {
    const src = readSrc(AMEND_SERVICE);
    expect(src).not.toMatch(/notIn: \[\.\.\.usedOpIds\]/);
    expect(src).toMatch(/inRouteCount/);
  });
});

describe('идентичность шага — позиция снимка, а не операция', () => {
  test('DTO шага правки несёт `sourceIndex`', () => {
    const src = readSrc(AMENDMENTS);
    expect(src).toMatch(/sourceIndex: z\.number\(\)\.int\(\)/);
  });

  test('холст шлёт `sourceIndex` и держит уникальные ключи чипов', () => {
    const src = readSrc(CANVAS);
    expect(src).toMatch(/sourceIndex: s\.sourceIndex/);
    // Ключ нового шага — счётчик, иначе два одинаковых чипа схлопнутся.
    expect(src).toMatch(/draftKeySeq/);
    expect(src).not.toMatch(/key: `new:\$\{op\.id\}`/);
  });

  test('применение правки сопоставляет строки снимка по позиции', () => {
    const src = readSrc(AMEND_SERVICE);
    expect(src).toMatch(/stepByIndex/);
    expect(src).not.toMatch(/const stepById = new Map\(order\.routeSteps/);
    expect(src).toMatch(/p\.fromIndex === null \? undefined : stepByIndex\.get/);
  });

  test('запрещён только дубль внутри одной параллельной группы', () => {
    const src = readSrc(AMENDMENTS);
    expect(src).toMatch(/DUPLICATE_IN_PARALLEL_GROUP/);
    expect(src).not.toMatch(/'DUPLICATE_OPERATION'/);
  });
});

describe('продвижение паспорта считает проходы', () => {
  test('целевой шаг выбирается по числу закрытых проходов', () => {
    const src = readSrc(PASSPORTS);
    expect(src).toMatch(/countFinishedPasses/);
    expect(src).toMatch(/targetOccurrences/);
    // Гейты сверяют проход с порядковым номером вхождения шага.
    expect(src).toMatch(/ordinalByStepIndex/);
  });

  test('«операция уже пройдена» учитывает число вхождений в маршрут', () => {
    const src = readSrc(PASSPORTS);
    const block = src.slice(src.indexOf('private async assertOperationNotFinished'));
    expect(block).toMatch(/orderRouteStep\.count/);
    expect(block).toMatch(/Math\.max\(1, occurrences\)/);
  });
});

describe('деньги и гейты ОТК/ВТО/упаковки', () => {
  test('идемпотентность начисления включает номер прохода', () => {
    expect(readSrc('prisma/schema.prisma')).toMatch(
      /@@unique\(\[passportId, operationId, employeeId, sourceEventType, passOrdinal\]/,
    );
    const src = readSrc(EARNINGS);
    expect(src).toMatch(/resolvePassOrdinal/);
    expect(src).toMatch(/passOrdinal,/);
  });

  test('ОТК и ВТО не глохнут об идемпотентность на втором проходе', () => {
    const qc = readSrc('apps/api/src/modules/qc/qc.service.ts');
    expect(qc).toMatch(/passedCount >= Math\.max\(1, qcOccurrences\)/);
    const wto = readSrc('apps/api/src/modules/wto/wto.service.ts');
    expect(wto).toMatch(/passedCount >= Math\.max\(1, occurrences\)/);
  });

  test('упаковка требует столько проверок, сколько шагов в маршруте', () => {
    const src = readSrc('apps/api/src/modules/packing/packing.service.ts');
    expect(src).toMatch(/qc < qcSteps/);
    expect(src).toMatch(/wto < wtoSteps/);
  });
});
