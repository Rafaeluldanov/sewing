/**
 * Unit-тесты планировщика правки маршрута в производстве
 * (`planRouteAmendment` из `@sewing/shared/amendments`).
 *
 * Планировщик — вся арифметика индексов вкладки «Маршрут» drawer-а
 * «Изменить заказ в производстве»: он считает, что добавлено / убрано /
 * переставлено, и стережёт инварианты (замороженный префикс до фронта,
 * дубли операций, удаление шага с выработкой).
 */
import { describe, expect, test } from 'vitest';
import {
  planRouteAmendment,
  type RoutePlanCurrentStep,
} from '@sewing/shared/amendments';

/** Маршрут: крой → выдача → оверлок → распошив → ОТК. */
const CURRENT: RoutePlanCurrentStep[] = [
  { index: 0, operationId: 'cut', parallelGroup: null },
  { index: 1, operationId: 'issue', parallelGroup: null },
  { index: 2, operationId: 'overlock', parallelGroup: null },
  { index: 3, operationId: 'coverstitch', parallelGroup: null },
  { index: 4, operationId: 'qc', parallelGroup: null },
];

const target = (...ids: string[]) =>
  ids.map((operationId) => ({ operationId, parallelGroup: null }));

describe('planRouteAmendment — инварианты фронта', () => {
  test('вставка после фронта: план знает позицию и не трогает префикс', () => {
    // Фронт на шаге 2 (индексы 0..2 заморожены).
    const res = planRouteAmendment(
      CURRENT,
      target('cut', 'issue', 'overlock', 'coverstitch', 'binding', 'qc'),
      2,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.addedOperationIds).toEqual(['binding']);
    expect(res.plan.removedOperationIds).toEqual([]);
    // Хвост сдвинулся, но это не «перестановка» — относительный порядок цел.
    expect(res.plan.movedOperationIds).toEqual([]);
    expect(res.plan.placements.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(res.plan.placements[4]).toMatchObject({
      operationId: 'binding',
      index: 4,
      fromIndex: null,
    });
    expect(res.plan.placements[5]).toMatchObject({
      operationId: 'qc',
      fromIndex: 4,
    });
    expect(res.plan.noop).toBe(false);
  });

  test('вставка ПЕРЕД фронтом отклоняется', () => {
    const res = planRouteAmendment(
      CURRENT,
      target('cut', 'binding', 'issue', 'overlock', 'coverstitch', 'qc'),
      2,
    );
    expect(res).toEqual({
      ok: false,
      violation: { code: 'FRONTIER_CHANGED', index: 1 },
    });
  });

  test('перестановка замороженных шагов отклоняется', () => {
    const res = planRouteAmendment(
      CURRENT,
      target('issue', 'cut', 'overlock', 'coverstitch', 'qc'),
      2,
    );
    expect(res).toEqual({
      ok: false,
      violation: { code: 'FRONTIER_CHANGED', index: 0 },
    });
  });

  test('удаление замороженного шага отклоняется', () => {
    const res = planRouteAmendment(
      CURRENT,
      target('cut', 'issue', 'coverstitch', 'qc'),
      2,
    );
    expect(res).toEqual({
      ok: false,
      violation: { code: 'FRONTIER_CHANGED', index: 2 },
    });
  });

  test('шаг НА фронте (в работе) тоже заморожен', () => {
    // frontier = 3: паспорт стоит на «распошиве», его двигать нельзя.
    const res = planRouteAmendment(
      CURRENT,
      target('cut', 'issue', 'overlock', 'qc', 'coverstitch'),
      3,
    );
    expect(res).toEqual({
      ok: false,
      violation: { code: 'FRONTIER_CHANGED', index: 3 },
    });
  });

  test('без паспортов (frontier = −1) свободен весь маршрут', () => {
    const res = planRouteAmendment(
      CURRENT,
      target('qc', 'coverstitch', 'overlock', 'issue', 'cut'),
      -1,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.movedOperationIds.length).toBeGreaterThan(0);
    expect(res.plan.addedOperationIds).toEqual([]);
    expect(res.plan.removedOperationIds).toEqual([]);
  });
});

describe('planRouteAmendment — перестановка и удаление впереди фронта', () => {
  test('перестановка хвоста помечает только реально переехавшие шаги', () => {
    const res = planRouteAmendment(
      CURRENT,
      target('cut', 'issue', 'overlock', 'qc', 'coverstitch'),
      2,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.movedOperationIds.sort()).toEqual(['coverstitch', 'qc']);
    expect(res.plan.placements.find((p) => p.operationId === 'qc')).toMatchObject(
      { index: 3, fromIndex: 4 },
    );
  });

  test('удаление шага впереди фронта возвращает его индекс', () => {
    const res = planRouteAmendment(
      CURRENT,
      target('cut', 'issue', 'overlock', 'qc'),
      2,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.removedOperationIds).toEqual(['coverstitch']);
    expect(res.plan.removedIndexes).toEqual([3]);
    expect(res.plan.placements).toHaveLength(4);
  });

  test('удаление шага с выработкой отклоняется', () => {
    const res = planRouteAmendment(
      CURRENT,
      target('cut', 'issue', 'overlock', 'qc'),
      2,
      new Set(['coverstitch']),
    );
    expect(res).toEqual({
      ok: false,
      violation: { code: 'STEP_HAS_WORK', operationId: 'coverstitch' },
    });
  });

  test('дубль операции отклоняется', () => {
    const res = planRouteAmendment(
      CURRENT,
      target('cut', 'issue', 'overlock', 'coverstitch', 'qc', 'qc'),
      2,
    );
    expect(res).toEqual({
      ok: false,
      violation: { code: 'DUPLICATE_OPERATION', operationId: 'qc' },
    });
  });
});

describe('planRouteAmendment — параллельные группы и no-op', () => {
  test('маршрут без изменений — noop', () => {
    const res = planRouteAmendment(
      CURRENT,
      target('cut', 'issue', 'overlock', 'coverstitch', 'qc'),
      2,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.noop).toBe(true);
  });

  test('связывание двух шагов в группу — не noop', () => {
    const res = planRouteAmendment(
      CURRENT,
      [
        { operationId: 'cut', parallelGroup: null },
        { operationId: 'issue', parallelGroup: null },
        { operationId: 'overlock', parallelGroup: null },
        { operationId: 'coverstitch', parallelGroup: 1 },
        { operationId: 'qc', parallelGroup: 1 },
      ],
      2,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.noop).toBe(false);
    expect(res.plan.movedOperationIds.sort()).toEqual(['coverstitch', 'qc']);
  });

  test('смена группы у замороженного шага отклоняется', () => {
    const res = planRouteAmendment(
      CURRENT,
      [
        { operationId: 'cut', parallelGroup: null },
        { operationId: 'issue', parallelGroup: 1 },
        { operationId: 'overlock', parallelGroup: 1 },
        { operationId: 'coverstitch', parallelGroup: null },
        { operationId: 'qc', parallelGroup: null },
      ],
      2,
    );
    expect(res).toEqual({
      ok: false,
      violation: { code: 'FRONTIER_CHANGED', index: 1 },
    });
  });
});
