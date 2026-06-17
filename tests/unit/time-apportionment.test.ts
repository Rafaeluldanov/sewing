/**
 * Unit-тесты чистого ядра разноса реального времени окладника по
 * паспортам (`apps/api/src/modules/costs/time-apportionment.ts`).
 *
 * Покрываем: одиночный интервал, парный нахлёст 1/2, тройной нахлёст
 * 1/3, непересекающиеся интервалы (простой между ними не теряется и не
 * распределяется), агрегацию нескольких интервалов одного паспорта,
 * отбраковку вырожденных интервалов и инвариант «Σ minutes = |union|».
 */
import { describe, expect, test } from 'vitest';
import {
  apportionEmployeeTime,
  type WorkInterval,
} from '@sewing/api/modules/costs/time-apportionment';

/** Утилита: минута epoch → мс (просто для читаемости интервалов). */
const m = (minute: number): number => minute * 60_000;

function minutesOf(
  result: ReturnType<typeof apportionEmployeeTime>,
  passportId: string,
): number {
  return result
    .filter((r) => r.passportId === passportId)
    .reduce((s, r) => s + r.minutes, 0);
}

describe('apportionEmployeeTime', () => {
  test('одиночный интервал отдаёт всю длину паспорту', () => {
    const intervals: WorkInterval[] = [
      { passportId: 'A', operationId: 'qc', startMs: m(0), endMs: m(10) },
    ];
    const res = apportionEmployeeTime(intervals);
    expect(minutesOf(res, 'A')).toBeCloseTo(10, 9);
  });

  test('парный нахлёст делит общий отрезок пополам', () => {
    // A: 0..10, B: 5..15 → [0,5] только A; [5,10] A+B; [10,15] только B.
    // A = 5 + 2.5 = 7.5; B = 2.5 + 5 = 7.5; union = 15.
    const intervals: WorkInterval[] = [
      { passportId: 'A', operationId: 'qc', startMs: m(0), endMs: m(10) },
      { passportId: 'B', operationId: 'qc', startMs: m(5), endMs: m(15) },
    ];
    const res = apportionEmployeeTime(intervals);
    expect(minutesOf(res, 'A')).toBeCloseTo(7.5, 9);
    expect(minutesOf(res, 'B')).toBeCloseTo(7.5, 9);
    const total = res.reduce((s, r) => s + r.minutes, 0);
    expect(total).toBeCloseTo(15, 9); // = |union(0..15)|
  });

  test('тройной нахлёст делит общий отрезок на три', () => {
    // Все три держатся одновременно 0..3 → каждый по 1 минуте.
    const intervals: WorkInterval[] = [
      { passportId: 'A', operationId: 'qc', startMs: m(0), endMs: m(3) },
      { passportId: 'B', operationId: 'qc', startMs: m(0), endMs: m(3) },
      { passportId: 'C', operationId: 'qc', startMs: m(0), endMs: m(3) },
    ];
    const res = apportionEmployeeTime(intervals);
    expect(minutesOf(res, 'A')).toBeCloseTo(1, 9);
    expect(minutesOf(res, 'B')).toBeCloseTo(1, 9);
    expect(minutesOf(res, 'C')).toBeCloseTo(1, 9);
  });

  test('непересекающиеся интервалы: простой между ними не распределяется', () => {
    // A: 0..5, B: 20..25 → каждый получает свою длину, «дыра» 5..20 — простой.
    const intervals: WorkInterval[] = [
      { passportId: 'A', operationId: 'qc', startMs: m(0), endMs: m(5) },
      { passportId: 'B', operationId: 'qc', startMs: m(20), endMs: m(25) },
    ];
    const res = apportionEmployeeTime(intervals);
    expect(minutesOf(res, 'A')).toBeCloseTo(5, 9);
    expect(minutesOf(res, 'B')).toBeCloseTo(5, 9);
    const total = res.reduce((s, r) => s + r.minutes, 0);
    expect(total).toBeCloseTo(10, 9); // союз = 10, не 25
  });

  test('два интервала одного паспорта агрегируются в одну строку', () => {
    const intervals: WorkInterval[] = [
      { passportId: 'A', operationId: 'qc', startMs: m(0), endMs: m(4) },
      { passportId: 'A', operationId: 'qc', startMs: m(10), endMs: m(13) },
    ];
    const res = apportionEmployeeTime(intervals);
    const rowsA = res.filter((r) => r.passportId === 'A');
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].minutes).toBeCloseTo(7, 9);
  });

  test('разные операции одного паспорта — раздельные строки', () => {
    const intervals: WorkInterval[] = [
      { passportId: 'A', operationId: 'qc', startMs: m(0), endMs: m(4) },
      { passportId: 'A', operationId: 'wto', startMs: m(10), endMs: m(13) },
    ];
    const res = apportionEmployeeTime(intervals);
    expect(res.filter((r) => r.passportId === 'A')).toHaveLength(2);
  });

  test('вырожденные интервалы (end<=start) отбраковываются', () => {
    const intervals: WorkInterval[] = [
      { passportId: 'A', operationId: 'qc', startMs: m(5), endMs: m(5) },
      { passportId: 'B', operationId: 'qc', startMs: m(10), endMs: m(8) },
    ];
    expect(apportionEmployeeTime(intervals)).toEqual([]);
  });

  test('пустой вход → пустой выход', () => {
    expect(apportionEmployeeTime([])).toEqual([]);
  });
});
