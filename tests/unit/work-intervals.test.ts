/**
 * Unit-тесты строителя интервалов реальной работы сотрудника
 * (`apps/api/src/modules/costs/work-intervals.ts`).
 *
 * Покрываем оба пути accept→complete:
 *   - явный ISSUE→COMPLETE (швейные/сменные окладные);
 *   - терминал без ISSUE с фолбэком по разрыву (ОТК/ВТО/упаковка);
 *   - cap «забыл закрыть»;
 *   - первый терминал дня = minMs;
 *   - перевыдача (повторный ISSUE) перетирает accept.
 */
import { describe, expect, test } from 'vitest';
import {
  buildWorkIntervals,
  type WorkEvent,
} from '@sewing/api/modules/costs/work-intervals';

const m = (minute: number): number => minute * 60_000;
const OPTS = { capMs: m(60), minMs: m(1) };

function lenMin(iv: { startMs: number; endMs: number }): number {
  return (iv.endMs - iv.startMs) / 60_000;
}

describe('buildWorkIntervals', () => {
  test('явный ISSUE→COMPLETE даёт точный интервал', () => {
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: 'div', kind: 'ISSUE', atMs: m(0) },
      { passportId: 'A', operationId: 'div', kind: 'COMPLETE', atMs: m(12) },
    ];
    const res = buildWorkIntervals(events, OPTS);
    expect(res).toHaveLength(1);
    expect(lenMin(res[0])).toBeCloseTo(12, 9);
  });

  test('терминал без ISSUE: первый = minMs, следующий = разрыв', () => {
    // Упаковщик: первый PACKED в 10:00, второй в 10:04 → 1 мин и 4 мин.
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: null, kind: 'COMPLETE', atMs: m(100) },
      { passportId: 'B', operationId: null, kind: 'COMPLETE', atMs: m(104) },
    ];
    const res = buildWorkIntervals(events, OPTS);
    expect(res).toHaveLength(2);
    expect(lenMin(res[0])).toBeCloseTo(1, 9); // первый — minMs
    expect(lenMin(res[1])).toBeCloseTo(4, 9); // разрыв 100→104
  });

  test('cap ограничивает огромный разрыв', () => {
    // Между двумя завершениями прошло 3 часа — учитываем только cap=60.
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: null, kind: 'COMPLETE', atMs: m(0) },
      { passportId: 'B', operationId: null, kind: 'COMPLETE', atMs: m(180) },
    ];
    const res = buildWorkIntervals(events, OPTS);
    expect(lenMin(res[1])).toBeCloseTo(60, 9);
  });

  test('cap ограничивает устаревший ISSUE', () => {
    // ISSUE в 0, COMPLETE через 2 часа → cap до 60 мин.
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: 'qc', kind: 'ISSUE', atMs: m(0) },
      { passportId: 'A', operationId: 'qc', kind: 'COMPLETE', atMs: m(120) },
    ];
    const res = buildWorkIntervals(events, OPTS);
    expect(lenMin(res[0])).toBeCloseTo(60, 9);
  });

  test('перевыдача: повторный ISSUE перетирает accept', () => {
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: 'qc', kind: 'ISSUE', atMs: m(0) },
      { passportId: 'A', operationId: 'qc', kind: 'ISSUE', atMs: m(8) },
      { passportId: 'A', operationId: 'qc', kind: 'COMPLETE', atMs: m(10) },
    ];
    const res = buildWorkIntervals(events, OPTS);
    expect(res).toHaveLength(1);
    expect(lenMin(res[0])).toBeCloseTo(2, 9); // 8→10, не 0→10
  });

  test('COMPLETE без открытого ISSUE по другой паре уходит в фолбэк', () => {
    // ISSUE по (A,div), COMPLETE по (B,null) — пара не совпала.
    const events: WorkEvent[] = [
      { passportId: 'A', operationId: 'div', kind: 'ISSUE', atMs: m(0) },
      { passportId: 'B', operationId: null, kind: 'COMPLETE', atMs: m(5) },
    ];
    const res = buildWorkIntervals(events, OPTS);
    expect(res).toHaveLength(1);
    expect(res[0].passportId).toBe('B');
    expect(lenMin(res[0])).toBeCloseTo(1, 9); // первый терминал → minMs
  });

  test('пустой вход → пустой выход', () => {
    expect(buildWorkIntervals([], OPTS)).toEqual([]);
  });
});
