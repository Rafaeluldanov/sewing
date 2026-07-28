/**
 * Юнит-тесты `computeRouteDivergences` — правил «что считать работой
 * мимо маршрута». Без БД: чистая функция над уже выбранными данными.
 *
 * Сценарии повторяют реальные инциденты прода, чтобы правила нельзя
 * было молча ослабить:
 *   - 28.07.2026: окантовка (11) вместо киперки (03) — расхождение,
 *     пока нет правила замены, и НЕ расхождение после его заведения;
 *   - 29.05.2026: полный распошив (04) вместо сплита {0001, 16} —
 *     не расхождение, правило замены есть;
 *   - свёртка в пару (заказ, операция): 70 паспортов = одна строка.
 */
import { describe, expect, test } from 'vitest';
import {
  computeRouteDivergences,
  type DivergenceEventInput,
} from '../../apps/api/src/modules/production-board/route-divergence';

const d = (iso: string) => new Date(iso);

function ev(
  over: Partial<DivergenceEventInput> = {},
): DivergenceEventInput {
  return {
    passportId: 'p1',
    passportNumber: 'P-1',
    orderId: 'o1',
    orderNumber: 'O-1',
    operationId: 'op-okantovka',
    operationCode: '11',
    operationName: 'ОКАНТОВКА ПЛЕЧЕВЫХ И ГОРЛОВИНЫ',
    employeeName: 'Андашова Астра',
    createdAt: d('2026-07-01T08:00:00Z'),
    ...over,
  };
}

/** Маршрут сплит-шаблона 02: киперка + подгиб низа + рукав. */
const SPLIT_ROUTE = new Map<string, ReadonlySet<string>>([
  ['o1', new Set(['op-kiperka', 'op-podgib', 'op-rukav'])],
]);

describe('computeRouteDivergences', () => {
  test('операция вне маршрута без правила замены → расхождение', () => {
    const out = computeRouteDivergences([ev()], SPLIT_ROUTE, []);
    expect(out).toHaveLength(1);
    expect(out[0].operationCode).toBe('11');
    expect(out[0].passportCount).toBe(1);
    expect(out[0].orderNumber).toBe('O-1');
  });

  test('то же самое ПОСЛЕ заведения правила замены 03 ← 11 → тишина', () => {
    const out = computeRouteDivergences([ev()], SPLIT_ROUTE, [
      { satisfiesOpId: 'op-kiperka', substituteOpId: 'op-okantovka' },
    ]);
    expect(out).toEqual([]);
  });

  test('полный распошив вместо сплита — не расхождение (04 замещает 0001 и 16)', () => {
    const out = computeRouteDivergences(
      [ev({ operationId: 'op-full', operationCode: '04' })],
      SPLIT_ROUTE,
      [
        { satisfiesOpId: 'op-podgib', substituteOpId: 'op-full' },
        { satisfiesOpId: 'op-rukav', substituteOpId: 'op-full' },
      ],
    );
    expect(out).toEqual([]);
  });

  test('правило замены на операцию, которой нет в ЭТОМ маршруте, не спасает', () => {
    // 04 замещает подгиб/рукав, но маршрут заказа их не содержит —
    // значит закрывать нечего и это всё равно работа мимо плана.
    const route = new Map<string, ReadonlySet<string>>([
      ['o1', new Set(['op-kiperka'])],
    ]);
    const out = computeRouteDivergences(
      [ev({ operationId: 'op-full', operationCode: '04' })],
      route,
      [
        { satisfiesOpId: 'op-podgib', substituteOpId: 'op-full' },
        { satisfiesOpId: 'op-rukav', substituteOpId: 'op-full' },
      ],
    );
    expect(out).toHaveLength(1);
  });

  test('операция в маршруте есть → не расхождение', () => {
    const out = computeRouteDivergences(
      [ev({ operationId: 'op-kiperka', operationCode: '03' })],
      SPLIT_ROUTE,
      [],
    );
    expect(out).toEqual([]);
  });

  test('у заказа нет снимка маршрута → пропускаем (это другая находка)', () => {
    const out = computeRouteDivergences([ev()], new Map(), []);
    expect(out).toEqual([]);
  });

  test('свёртка: много паспортов одного заказа = ОДНА строка', () => {
    const events = Array.from({ length: 70 }, (_, i) =>
      ev({
        passportId: `p${i}`,
        passportNumber: `P-${i}`,
        createdAt: d(`2026-07-0${(i % 3) + 1}T08:00:00Z`),
        employeeName: i % 2 === 0 ? 'Андашова Астра' : 'Кисембаева Перизат',
      }),
    );
    const out = computeRouteDivergences(events, SPLIT_ROUTE, []);
    expect(out).toHaveLength(1);
    expect(out[0].passportCount).toBe(70);
    // Исполнители — уникальные и отсортированные.
    expect(out[0].employees).toEqual([
      'Андашова Астра',
      'Кисембаева Перизат',
    ]);
    expect(out[0].firstAt).toEqual(d('2026-07-01T08:00:00Z'));
    expect(out[0].lastAt).toEqual(d('2026-07-03T08:00:00Z'));
  });

  test('разные операции одного заказа — разные строки', () => {
    const out = computeRouteDivergences(
      [
        ev(),
        ev({ passportId: 'p2', operationId: 'op-x', operationCode: 'X' }),
      ],
      SPLIT_ROUTE,
      [],
    );
    expect(out).toHaveLength(2);
  });

  test('сортировка: самые застарелые сверху', () => {
    const out = computeRouteDivergences(
      [
        ev({ operationId: 'op-new', createdAt: d('2026-07-20T08:00:00Z') }),
        ev({
          passportId: 'p2',
          operationId: 'op-old',
          createdAt: d('2026-07-01T08:00:00Z'),
        }),
      ],
      SPLIT_ROUTE,
      [],
    );
    expect(out.map((g) => g.operationId)).toEqual(['op-old', 'op-new']);
  });
});
