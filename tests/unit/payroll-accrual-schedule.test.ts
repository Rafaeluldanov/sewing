/**
 * Календарь расписания начисления зарплаты и правило отсечки.
 *
 * Чистые функции (`packages/shared/src/payroll-schedule.ts` +
 * `accrual-cutoff.ts`) держат самую опасную часть фичи: от них зависит,
 * в какой день человек получит деньги и попадёт ли его работа в
 * ближайшую выплату вообще. Ошибка здесь не падает исключением — она
 * молча сдвигает зарплату на месяц.
 */
import { describe, expect, test } from 'vitest';
import {
  accrualDatesInMonth,
  accrualPeriodFor,
  clampDayToMonth,
  daysBetweenIso,
  isAccrualDate,
  previousAccrualDate,
  upcomingAccrualDates,
} from '@sewing/shared/payroll-schedule';
import {
  passesAccrualCutoff,
  pieceworkAccrualWhere,
  resolveAccrualBounds,
} from '../../apps/api/src/modules/payroll-schedule/accrual-cutoff';

const DAYS = [5, 15, 25];

describe('календарь дней начисления', () => {
  test('даты месяца — по возрастанию, без дублей', () => {
    expect(accrualDatesInMonth(DAYS, 2026, 8)).toEqual([
      '2026-08-05',
      '2026-08-15',
      '2026-08-25',
    ]);
  });

  test('31-е в феврале схлопывается в последний день месяца', () => {
    // Иначе февраль просто пропустил бы начисление, и зарплата уехала
    // бы на месяц — самый дорогой из возможных багов этой фичи.
    expect(clampDayToMonth(2026, 2, 31)).toBe(28);
    expect(accrualDatesInMonth([31], 2026, 2)).toEqual(['2026-02-28']);
    expect(accrualDatesInMonth([31], 2024, 2)).toEqual(['2024-02-29']);
  });

  test('28 и 31 в феврале не дают двух одинаковых дат', () => {
    expect(accrualDatesInMonth([28, 31], 2026, 2)).toEqual(['2026-02-28']);
  });

  test('ближайшие даты перешагивают границу месяца и года', () => {
    expect(upcomingAccrualDates(DAYS, '2026-08-23', 3)).toEqual([
      '2026-08-25',
      '2026-09-05',
      '2026-09-15',
    ]);
    expect(upcomingAccrualDates([5], '2026-12-06', 2)).toEqual([
      '2027-01-05',
      '2027-02-05',
    ]);
  });

  test('сегодняшний день начисления входит в список', () => {
    expect(upcomingAccrualDates(DAYS, '2026-08-25', 1)).toEqual(['2026-08-25']);
    expect(isAccrualDate(DAYS, '2026-08-25')).toBe(true);
    expect(isAccrualDate(DAYS, '2026-08-24')).toBe(false);
  });

  test('пустое расписание = выключено, дат нет', () => {
    expect(upcomingAccrualDates([], '2026-08-23', 3)).toEqual([]);
    expect(previousAccrualDate([], '2026-08-23')).toBeNull();
    expect(isAccrualDate([], '2026-08-05')).toBe(false);
  });
});

describe('период документа', () => {
  test('со следующего дня после предыдущего начисления', () => {
    expect(accrualPeriodFor(DAYS, '2026-08-25')).toEqual({
      periodFrom: '2026-08-16',
      periodTo: '2026-08-25',
    });
  });

  test('первое начисление месяца берёт хвост прошлого', () => {
    expect(accrualPeriodFor(DAYS, '2026-09-05')).toEqual({
      periodFrom: '2026-08-26',
      periodTo: '2026-09-05',
    });
  });

  test('январское начисление тянется из декабря', () => {
    expect(accrualPeriodFor([15], '2027-01-15')).toEqual({
      periodFrom: '2026-12-16',
      periodTo: '2027-01-15',
    });
  });

  test('без расписания период не ограничен снизу', () => {
    expect(accrualPeriodFor([], '2026-08-25')).toEqual({
      periodFrom: null,
      periodTo: '2026-08-25',
    });
  });

  test('daysBetweenIso считает целые сутки', () => {
    expect(daysBetweenIso('2026-08-23', '2026-08-25')).toBe(2);
    expect(daysBetweenIso('2026-08-25', '2026-08-25')).toBe(0);
    expect(daysBetweenIso('2026-12-31', '2027-01-01')).toBe(1);
  });
});

describe('отсечка сдельщины', () => {
  const cutoff = new Date('2026-08-25T20:59:59.999Z');
  const rules = {
    cutoffBasis: 'ORDER_COMPLETED' as const,
    appliesToSewing: true,
    appliesToCutting: false,
  };

  const sewing = (orderCompletedAt: Date | null) => ({
    sourceEventType: 'OPERATION_TRANSITION' as never,
    approvedAt: new Date('2026-08-10T00:00:00.000Z'),
    orderCompletedAt,
  });

  test('закрытый до даты заказ — деньги идут в расчёт', () => {
    expect(
      passesAccrualCutoff(rules, cutoff, sewing(new Date('2026-08-20T10:00:00.000Z'))),
    ).toBe(true);
  });

  test('незакрытый заказ — деньги откладываются', () => {
    expect(passesAccrualCutoff(rules, cutoff, sewing(null))).toBe(false);
  });

  test('заказ, закрытый ПОСЛЕ даты начисления, ещё не оплачивается', () => {
    expect(
      passesAccrualCutoff(rules, cutoff, sewing(new Date('2026-08-27T10:00:00.000Z'))),
    ).toBe(false);
  });

  test('раскрой вне охвата платится независимо от заказа', () => {
    // `appliesToCutting = false` — раскройщик получает по факту выпуска
    // паспорта и не ждёт закрытия заказа вместе со швеями.
    expect(
      passesAccrualCutoff(rules, cutoff, {
        sourceEventType: 'PASSPORT_CREATED' as never,
        approvedAt: null,
        orderCompletedAt: null,
      }),
    ).toBe(true);
  });

  test('WORK_DATE = историческое поведение: проходит всё', () => {
    const legacy = { ...rules, cutoffBasis: 'WORK_DATE' as const };
    expect(passesAccrualCutoff(legacy, cutoff, sewing(null))).toBe(true);
  });

  test('PASSPORT_PACKED смотрит на подтверждение, а не на заказ', () => {
    const packed = { ...rules, cutoffBasis: 'PASSPORT_PACKED' as const };
    expect(passesAccrualCutoff(packed, cutoff, sewing(null))).toBe(true);
    expect(
      passesAccrualCutoff(packed, cutoff, {
        ...sewing(null),
        approvedAt: null,
      }),
    ).toBe(false);
  });

  test('where повторяет ту же развилку и всегда режет по APPROVED', () => {
    const where = pieceworkAccrualWhere(rules, cutoff);
    expect(where.status).toBe('APPROVED');
    expect(where.createdAt).toEqual({ lte: cutoff });
    // Две ветки: раскрой (без правила) и пошив (с правилом).
    expect(where.OR).toHaveLength(2);
    expect(JSON.stringify(where.OR)).toContain('completedAt');
  });
});

describe('границы дня начисления', () => {
  test('cutoff — конец МОСКОВСКИХ суток, а не UTC', () => {
    // Документ и предпросмотр обязаны резать по одной границе. Пока
    // документ жил на `endOfDayUtc`, ночная смена (00:00–03:00 МСК)
    // попадала в него, но не показывалась в предпросмотре.
    const { cutoff } = resolveAccrualBounds('2026-08-25');
    expect(cutoff.toISOString()).toBe('2026-08-25T20:59:59.999Z');
  });

  test('граница оклада — полночь UTC дня начисления', () => {
    // `SalaryEntry.date` — `@db.Date`: Prisma сравнивает его как
    // полночь UTC. Московское начало суток (21:00 предыдущего дня)
    // выбрасывало из предпросмотра весь день оклада.
    const { salaryDate } = resolveAccrualBounds('2026-08-25');
    expect(salaryDate.toISOString()).toBe('2026-08-25T00:00:00.000Z');
  });

  test('ночная смена по московским суткам остаётся за отсечкой', () => {
    const { cutoff } = resolveAccrualBounds('2026-08-25');
    // 26.08 01:30 МСК = 25.08 22:30Z — это уже следующий день цеха.
    expect(new Date('2026-08-25T22:30:00.000Z') > cutoff).toBe(true);
    // 25.08 23:00 МСК = 25.08 20:00Z — тот же день, попадает.
    expect(new Date('2026-08-25T20:00:00.000Z') <= cutoff).toBe(true);
  });
});

describe('догон пропущенного дня начисления', () => {
  test('после пропущенной даты она остаётся последней прошедшей', () => {
    // 5-е выпало на воскресенье, никто не открыл раздел. В понедельник
    // 6-го расписание обязано увидеть незакрытое 5-е, а не молча
    // пропустить выплату до следующего месяца.
    expect(isAccrualDate([5], '2026-09-06')).toBe(false);
    expect(previousAccrualDate([5], '2026-09-06')).toBe('2026-09-05');
  });

  test('в сам день начисления догонять нечего', () => {
    expect(isAccrualDate([5], '2026-09-05')).toBe(true);
  });
});
