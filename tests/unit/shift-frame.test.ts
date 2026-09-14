/**
 * Unit-тесты рамки смены для хронометража окладника
 * (`apps/api/src/modules/costs/shift-frame.ts`, решение владельца
 * 14.09.2026): интервал «взяла → сдала» учитывается только внутри смен
 * сотрудника, а потом режется по UTC-суткам для простоя по дню.
 */
import { describe, expect, test } from 'vitest';
import {
  clipToShiftFrames,
  mergeShiftFrames,
  splitByUtcDay,
} from '@sewing/api/modules/costs/shift-frame';

const T0 = Date.UTC(2026, 8, 14, 0, 0, 0); // 2026-09-14T00:00Z
const h = (hours: number): number => T0 + hours * 3_600_000;
const lenMin = (iv: { startMs: number; endMs: number }): number =>
  (iv.endMs - iv.startMs) / 60_000;

describe('mergeShiftFrames', () => {
  test('склеивает пересекающиеся и соприкасающиеся смены, сортирует', () => {
    const merged = mergeShiftFrames([
      { startMs: h(13), endMs: h(17) },
      { startMs: h(9), endMs: h(13) }, // соприкасается с 13–17
      { startMs: h(20), endMs: h(22) },
      { startMs: h(21), endMs: h(23) }, // пересекается с 20–22
      { startMs: h(5), endMs: h(5) }, // нулевая — выбрасывается
    ]);
    expect(merged).toEqual([
      { startMs: h(9), endMs: h(17) },
      { startMs: h(20), endMs: h(23) },
    ]);
  });
});

describe('clipToShiftFrames', () => {
  test('«взяла вечером — сдала назавтра»: остаётся только время внутри смен', () => {
    // Смена 1: 09:00–18:00 (14.09), смена 2: 09:00–18:00 (15.09).
    const frames = mergeShiftFrames([
      { startMs: h(9), endMs: h(18) },
      { startMs: h(24 + 9), endMs: h(24 + 18) },
    ]);
    // Взяла в 17:00, сдала назавтра в 10:00 → 1 ч вчера + 1 ч сегодня.
    const clipped = clipToShiftFrames(
      [{ passportId: 'A', operationId: 'sew', startMs: h(17), endMs: h(24 + 10) }],
      frames,
    );
    expect(clipped).toHaveLength(2);
    expect(lenMin(clipped[0])).toBe(60);
    expect(lenMin(clipped[1])).toBe(60);
    expect(clipped.every((c) => c.passportId === 'A' && c.operationId === 'sew')).toBe(true);
  });

  test('интервал целиком вне смен → пусто; без смен → пусто', () => {
    const frames = [{ startMs: h(9), endMs: h(18) }];
    expect(
      clipToShiftFrames(
        [{ passportId: 'A', operationId: null, startMs: h(19), endMs: h(21) }],
        frames,
      ),
    ).toEqual([]);
    expect(
      clipToShiftFrames(
        [{ passportId: 'A', operationId: null, startMs: h(10), endMs: h(11) }],
        [],
      ),
    ).toEqual([]);
  });

  test('интервал внутри смены не меняется', () => {
    const frames = [{ startMs: h(9), endMs: h(18) }];
    const clipped = clipToShiftFrames(
      [{ passportId: 'A', operationId: 'x', startMs: h(10), endMs: h(12.5) }],
      frames,
    );
    expect(clipped).toEqual([
      { passportId: 'A', operationId: 'x', startMs: h(10), endMs: h(12.5) },
    ]);
  });
});

describe('splitByUtcDay', () => {
  test('кусок через полночь UTC делится на два дня', () => {
    const pieces = splitByUtcDay([
      { passportId: 'A', operationId: 'x', startMs: h(23), endMs: h(25) },
    ]);
    expect(pieces).toEqual([
      { passportId: 'A', operationId: 'x', startMs: h(23), endMs: h(24), dayKey: '2026-09-14' },
      { passportId: 'A', operationId: 'x', startMs: h(24), endMs: h(25), dayKey: '2026-09-15' },
    ]);
  });

  test('кусок внутри суток остаётся одним', () => {
    const pieces = splitByUtcDay([
      { passportId: 'A', operationId: null, startMs: h(10), endMs: h(11) },
    ]);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].dayKey).toBe('2026-09-14');
  });
});
