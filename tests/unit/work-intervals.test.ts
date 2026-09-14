/**
 * Unit-тесты строителя интервалов реальной работы сотрудника
 * (`apps/api/src/modules/costs/work-intervals.ts`).
 *
 * После решения владельца 14.09.2026 строитель знает только один путь —
 * явный `ISSUE→COMPLETE`. Завершение без своего accept уходит в
 * `unmatched` (его считает нормативная ветка: норма × объём), а не
 * «по разрыву» и не с потолком в 60 минут — рамкой смены занимается
 * `shift-frame.ts`.
 */
import { describe, expect, test } from 'vitest';
import {
  buildWorkIntervals,
  type WorkEvent,
} from '@sewing/api/modules/costs/work-intervals';

const m = (minute: number): number => minute * 60_000;

function lenMin(iv: { startMs: number; endMs: number }): number {
  return (iv.endMs - iv.startMs) / 60_000;
}

describe('buildWorkIntervals', () => {
  test('явный ISSUE→COMPLETE даёт точный интервал', () => {
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: 'div', kind: 'ISSUE', atMs: m(0) },
      { passportId: 'A', operationId: 'div', kind: 'COMPLETE', atMs: m(12) },
    ];
    const res = buildWorkIntervals(events);
    expect(res.intervals).toHaveLength(1);
    expect(lenMin(res.intervals[0])).toBeCloseTo(12, 9);
    expect(res.unmatched).toEqual([]);
  });

  test('терминал без ISSUE → unmatched, интервала нет', () => {
    // ОТК: два QC_PASSED без accept — раньше первый давал 1 мин, второй
    // «разрыв» 4 мин; теперь оба идут в норму × объём.
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: 'qc', kind: 'COMPLETE', atMs: m(100), qty: 10 },
      { passportId: 'B', operationId: 'qc', kind: 'COMPLETE', atMs: m(104), qty: 5 },
    ];
    const res = buildWorkIntervals(events);
    expect(res.intervals).toEqual([]);
    expect(res.unmatched.map((u) => [u.passportId, u.qty])).toEqual([
      ['A', 10],
      ['B', 5],
    ]);
  });

  test('длинный интервал не режется: потолка больше нет', () => {
    // ISSUE в 0, COMPLETE через 26 часов — целиком; ночь отрежет рамка смены.
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: 'sew', kind: 'ISSUE', atMs: m(0) },
      { passportId: 'A', operationId: 'sew', kind: 'COMPLETE', atMs: m(26 * 60) },
    ];
    const res = buildWorkIntervals(events);
    expect(lenMin(res.intervals[0])).toBeCloseTo(26 * 60, 9);
  });

  test('перевыдача: повторный ISSUE перетирает accept', () => {
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: 'sew', kind: 'ISSUE', atMs: m(0) },
      { passportId: 'A', operationId: 'sew', kind: 'ISSUE', atMs: m(8) },
      { passportId: 'A', operationId: 'sew', kind: 'COMPLETE', atMs: m(10) },
    ];
    const res = buildWorkIntervals(events);
    expect(res.intervals).toHaveLength(1);
    expect(lenMin(res.intervals[0])).toBeCloseTo(2, 9); // 8→10, не 0→10
  });

  test('COMPLETE по другой паре не забирает чужой ISSUE', () => {
    // ISSUE по (A,div), COMPLETE по (B,null) — пара не совпала: B в unmatched,
    // accept по A остаётся открытым (паспорт ещё на руках).
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: 'div', kind: 'ISSUE', atMs: m(0) },
      { passportId: 'B', operationId: null, kind: 'COMPLETE', atMs: m(5) },
    ];
    const res = buildWorkIntervals(events);
    expect(res.intervals).toEqual([]);
    expect(res.unmatched).toHaveLength(1);
    expect(res.unmatched[0].passportId).toBe('B');
  });

  test('ISSUE без COMPLETE интервала не даёт', () => {
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: 'sew', kind: 'ISSUE', atMs: m(0) },
    ];
    const res = buildWorkIntervals(events);
    expect(res.intervals).toEqual([]);
    expect(res.unmatched).toEqual([]);
  });

  test('accept в ту же миллисекунду, что и complete → unmatched, accept снят', () => {
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: 'sew', kind: 'ISSUE', atMs: m(5) },
      { passportId: 'A', operationId: 'sew', kind: 'COMPLETE', atMs: m(5) },
      // Следующее завершение по той же паре не должно взять тот accept.
      { passportId: 'A', operationId: 'sew', kind: 'COMPLETE', atMs: m(9) },
    ];
    const res = buildWorkIntervals(events);
    expect(res.intervals).toEqual([]);
    expect(res.unmatched).toHaveLength(2);
  });

  test('порядок на входе не важен', () => {
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: 'sew', kind: 'COMPLETE', atMs: m(12) },
      { passportId: 'A', operationId: 'sew', kind: 'ISSUE', atMs: m(0) },
    ];
    const res = buildWorkIntervals(events);
    expect(res.intervals).toHaveLength(1);
    expect(lenMin(res.intervals[0])).toBeCloseTo(12, 9);
  });

  test('пустой вход → пустой выход', () => {
    expect(buildWorkIntervals([])).toEqual({ intervals: [], unmatched: [] });
  });
});
