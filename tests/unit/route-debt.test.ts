/**
 * Юнит-тесты `computeRouteDebts` — правил «что считать незакрытой
 * работой позади паспорта». Без БД: чистая функция над уже выбранными
 * данными.
 *
 * Сценарии повторяют реальные случаи прода, чтобы правила нельзя было
 * молча ослабить:
 *   - 17-18.08.2026, заказ 02-00013: швея взяла 10 паспортов на
 *     «Ф РАСПОШИВ» и не закрыла ни одного, ОТК увела их вперёд сканом;
 *   - параллельная группа {киперка, распошив} — НЕ долг: за группу
 *     паспорт не выпустит AND-гейт перед ОТК;
 *   - повтор операции в маршруте (02 Ф ОВЕРЛОК дважды в 02-00013):
 *     первый проход закрыт, второй нет — долг ровно по второму.
 */
import { describe, expect, test } from 'vitest';
import {
  computeRouteDebts,
  type RouteDebtPassportInput,
  type RouteDebtStepInput,
} from '../../apps/api/src/modules/production-board/route-debt';

const d = (iso: string) => new Date(iso);

function step(over: Partial<RouteDebtStepInput> = {}): RouteDebtStepInput {
  return {
    index: 0,
    operationId: 'op-rasposhiv',
    operationCode: '04',
    operationName: 'Ф РАСПОШИВ',
    parallelGroup: null,
    isSewing: true,
    ...over,
  };
}

function passport(
  over: Partial<RouteDebtPassportInput> = {},
): RouteDebtPassportInput {
  return {
    passportId: 'p1',
    passportNumber: 'P-20260810-0005',
    orderId: 'o1',
    orderNumber: '02-00013',
    currentRouteStepIndex: 5,
    qty: 14,
    finishedOperationIds: [],
    issuedByOperation: new Map([
      ['op-rasposhiv', { employeeName: 'Кенжабаева Барчиной', at: d('2026-08-17T11:47:00Z') }],
    ]),
    ...over,
  };
}

/** Линейный маршрут 02-00013: оверлок, окантовка, оверлок, распошив, ОТК. */
const ROUTE: readonly RouteDebtStepInput[] = [
  step({ index: 1, operationId: 'op-overlock', operationCode: '02', operationName: 'Ф ОВЕРЛОК' }),
  step({ index: 2, operationId: 'op-okantovka', operationCode: '11', operationName: 'Ф ОКАНТОВКА' }),
  step({ index: 3, operationId: 'op-overlock', operationCode: '02', operationName: 'Ф ОВЕРЛОК' }),
  step({ index: 4 }),
  step({ index: 5, operationId: 'op-qc', operationCode: '05', operationName: 'ОТК', isSewing: false }),
];

const BY_ORDER = new Map<string, readonly RouteDebtStepInput[]>([['o1', ROUTE]]);

/** Всё, кроме распошива, закрыто — иначе каждый тест ловил бы лишние долги. */
const CLOSED_BEFORE = ['op-overlock', 'op-okantovka', 'op-overlock'];

describe('computeRouteDebts', () => {
  test('взяли и не закрыли, паспорт уехал вперёд -> ABANDONED', () => {
    const out = computeRouteDebts(
      [passport({ finishedOperationIds: CLOSED_BEFORE })],
      BY_ORDER,
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('ABANDONED');
    expect(out[0].operationCode).toBe('04');
    expect(out[0].passportCount).toBe(1);
    expect(out[0].qty).toBe(14);
    expect(out[0].employees).toEqual(['Кенжабаева Барчиной']);
  });

  test('шаг закрыт -> тишина', () => {
    const out = computeRouteDebts(
      [
        passport({
          finishedOperationIds: [...CLOSED_BEFORE, 'op-rasposhiv'],
        }),
      ],
      BY_ORDER,
      [],
    );
    expect(out).toEqual([]);
  });

  test('шаг закрыт заместителем -> тишина', () => {
    const out = computeRouteDebts(
      [passport({ finishedOperationIds: [...CLOSED_BEFORE, 'op-podgib'] })],
      BY_ORDER,
      [{ satisfiesOpId: 'op-rasposhiv', substituteOpId: 'op-podgib' }],
    );
    expect(out).toEqual([]);
  });

  test('шаг параллельной группы -> НЕ долг (держит AND-гейт перед ОТК)', () => {
    const parallel = new Map<string, readonly RouteDebtStepInput[]>([
      [
        'o1',
        [
          step({ index: 1, operationId: 'op-overlock', operationCode: '02' }),
          step({ index: 2, operationId: 'op-kiperka', operationCode: '03', parallelGroup: 1 }),
          step({ index: 3, parallelGroup: 1 }),
        ],
      ],
    ]);
    const out = computeRouteDebts(
      [
        passport({
          currentRouteStepIndex: 3,
          finishedOperationIds: ['op-overlock'],
        }),
      ],
      parallel,
      [],
    );
    expect(out).toEqual([]);
  });

  test('не швейный шаг позади -> тишина (ОТК/крой закрываются не через OPERATION_FINISHED)', () => {
    const out = computeRouteDebts(
      [
        passport({
          currentRouteStepIndex: 6,
          finishedOperationIds: [...CLOSED_BEFORE, 'op-rasposhiv'],
        }),
      ],
      BY_ORDER,
      [],
    );
    expect(out).toEqual([]);
  });

  test('повтор операции в маршруте: закрыт первый проход, второй -> долг', () => {
    const out = computeRouteDebts(
      [
        passport({
          finishedOperationIds: ['op-overlock', 'op-okantovka', 'op-rasposhiv'],
          issuedByOperation: new Map(),
        }),
      ],
      BY_ORDER,
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].operationCode).toBe('02');
    expect(out[0].reason).toBe('SKIPPED');
  });

  test('шаг никто не брал -> SKIPPED, без дат и сотрудников', () => {
    const out = computeRouteDebts(
      [
        passport({
          finishedOperationIds: CLOSED_BEFORE,
          issuedByOperation: new Map(),
        }),
      ],
      BY_ORDER,
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('SKIPPED');
    expect(out[0].firstAt).toBeNull();
    expect(out[0].employees).toEqual([]);
  });

  test('10 паспортов одной швеи -> одна строка, qty суммируется', () => {
    const out = computeRouteDebts(
      Array.from({ length: 10 }, (_, i) =>
        passport({
          passportId: `p${i}`,
          passportNumber: `P-2026081${i}`,
          qty: 14,
          finishedOperationIds: CLOSED_BEFORE,
        }),
      ),
      BY_ORDER,
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].passportCount).toBe(10);
    expect(out[0].qty).toBe(140);
    expect(out[0].employees).toEqual(['Кенжабаева Барчиной']);
  });

  test('«взяли и бросили» и «проехали мимо» -> разные строки', () => {
    const out = computeRouteDebts(
      [
        passport({ finishedOperationIds: CLOSED_BEFORE }),
        passport({
          passportId: 'p2',
          finishedOperationIds: CLOSED_BEFORE,
          issuedByOperation: new Map(),
        }),
      ],
      BY_ORDER,
      [],
    );
    expect(out).toHaveLength(2);
    expect(out.map((g) => g.reason).sort()).toEqual(['ABANDONED', 'SKIPPED']);
  });

  test('самый застарелый долг — сверху, SKIPPED без дат — в конец', () => {
    const out = computeRouteDebts(
      [
        passport({
          orderId: 'o1',
          finishedOperationIds: CLOSED_BEFORE,
          issuedByOperation: new Map([
            ['op-rasposhiv', { employeeName: 'Новая', at: d('2026-08-20T06:00:00Z') }],
          ]),
        }),
        passport({
          passportId: 'p2',
          orderId: 'o2',
          orderNumber: '02-00014',
          finishedOperationIds: CLOSED_BEFORE,
          issuedByOperation: new Map([
            ['op-rasposhiv', { employeeName: 'Старая', at: d('2026-08-01T06:00:00Z') }],
          ]),
        }),
        passport({
          passportId: 'p3',
          orderId: 'o3',
          orderNumber: '02-00015',
          finishedOperationIds: CLOSED_BEFORE,
          issuedByOperation: new Map(),
        }),
      ],
      new Map<string, readonly RouteDebtStepInput[]>([
        ['o1', ROUTE],
        ['o2', ROUTE],
        ['o3', ROUTE],
      ]),
      [],
    );
    expect(out.map((g) => g.orderNumber)).toEqual([
      '02-00014',
      '02-00013',
      '02-00015',
    ]);
  });

  test('номера паспортов группы отдаются мастеру целиком', () => {
    // Свёртка до тройки нужна для РЕШЕНИЯ («что делать с этой пачкой»),
    // но не для поиска: «паспортов: 2» без номеров не позволяет ни
    // назвать их швее, ни проверить. Номера — по возрастанию, дубли
    // схлопнуты вместе с `passportCount`.
    const steps = [
      step({ index: 0, operationId: 'op-a', operationCode: '02' }),
      step({ index: 1, operationId: 'op-b', operationCode: '04' }),
    ];
    const groups = computeRouteDebts(
      [
        passport({
          passportId: 'p2',
          passportNumber: 'P-0002',
          currentRouteStepIndex: 1,
          finishedOperationIds: [],
          issuedByOperation: new Map([
            ['op-a', { employeeName: 'Швея', at: d('2026-08-14T08:00:00Z') }],
          ]),
        }),
        passport({
          passportId: 'p1',
          passportNumber: 'P-0001',
          currentRouteStepIndex: 1,
          finishedOperationIds: [],
          issuedByOperation: new Map([
            ['op-a', { employeeName: 'Швея', at: d('2026-08-14T09:00:00Z') }],
          ]),
        }),
      ],
      new Map([['o1', steps]]),
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].passportCount).toBe(2);
    expect(groups[0].passportNumbers).toEqual(['P-0001', 'P-0002']);
  });
});
