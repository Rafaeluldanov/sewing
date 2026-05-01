/**
 * Unit-тесты pure-helper-а `evaluateOrderDeadline`
 * (`packages/shared/src/order-deadlines.ts`).
 *
 * Helper — единственное место в системе, где правило «как считать
 * статус срока заказа» закреплено формулой. И backend
 * (`OrdersService.list/getOne`), и web (`/admin/orders`,
 * `/admin/orders/[id]`, `/admin`) обращаются к нему — поэтому таблицу
 * правил MVP закрепляем здесь, чтобы случайный refactor не сместил
 * ни один бакет (OVERDUE / AT_RISK / ON_TRACK / NO_DUE_DATE / DONE).
 *
 * Сравнение по календарному дню (UTC) сознательно — иначе «на час
 * позже» из-за TZ сервера сместил бы бакет; см. комментарии в helper-е.
 */
import { describe, expect, test } from 'vitest';
import {
  computeProgressPercent,
  evaluateOrderDeadline,
  ORDER_DEADLINE_AT_RISK_DAYS,
  ORDER_DEADLINE_AT_RISK_PROGRESS,
  ORDER_DEADLINE_LABELS,
  ORDER_DEADLINE_SORT_PRIORITY,
  ORDER_DEADLINE_STATUSES,
  ORDER_DEADLINE_TONES,
} from '@sewing/shared/order-deadlines';

const TODAY = new Date('2026-04-25T12:00:00Z');

function dayOffset(days: number, base: Date = TODAY): Date {
  const ms = base.getTime() + days * 24 * 60 * 60 * 1000;
  return new Date(ms);
}

describe('evaluateOrderDeadline — таблица правил MVP', () => {
  test('DONE → DONE («Готов»), tone success', () => {
    const r = evaluateOrderDeadline({
      status: 'DONE',
      dueDate: dayOffset(-5),
      qtyPlan: 10,
      qtyFinished: 10,
      now: TODAY,
    });
    expect(r.status).toBe('DONE');
    expect(r.label).toBe('Готов');
    expect(r.tone).toBe('success');
    expect(r.daysLeft).toBeNull();
  });

  test('CANCELLED → терминальный (DONE-tier с muted тоном)', () => {
    const r = evaluateOrderDeadline({
      status: 'CANCELLED',
      dueDate: dayOffset(-5),
      qtyPlan: 10,
      qtyFinished: 0,
      now: TODAY,
    });
    expect(r.status).toBe('DONE');
    expect(r.label).toBe('Отменён');
    expect(r.tone).toBe('muted');
  });

  test('нет dueDate → NO_DUE_DATE («Без срока»), tone muted', () => {
    const r = evaluateOrderDeadline({
      status: 'IN_PRODUCTION',
      dueDate: null,
      qtyPlan: 10,
      qtyFinished: 1,
      now: TODAY,
    });
    expect(r.status).toBe('NO_DUE_DATE');
    expect(r.label).toBe('Без срока');
    expect(r.tone).toBe('muted');
    expect(r.daysLeft).toBeNull();
  });

  test('некорректная dueDate-строка → NO_DUE_DATE (без исключений)', () => {
    const r = evaluateOrderDeadline({
      status: 'IN_PRODUCTION',
      dueDate: 'not-a-date',
      qtyPlan: 5,
      qtyFinished: 0,
      now: TODAY,
    });
    expect(r.status).toBe('NO_DUE_DATE');
  });

  test('вчерашняя dueDate, IN_PRODUCTION → OVERDUE («Просрочен»), tone danger', () => {
    const r = evaluateOrderDeadline({
      status: 'IN_PRODUCTION',
      dueDate: dayOffset(-1),
      qtyPlan: 10,
      qtyFinished: 5,
      now: TODAY,
    });
    expect(r.status).toBe('OVERDUE');
    expect(r.label).toBe('Просрочен');
    expect(r.tone).toBe('danger');
    expect(r.daysLeft).toBe(-1);
    expect(r.reason).toMatch(/Срок прошёл/i);
  });

  test('завтрашняя dueDate, прогресс 20% → AT_RISK («В риске»), tone warning', () => {
    const r = evaluateOrderDeadline({
      status: 'IN_PRODUCTION',
      dueDate: dayOffset(1),
      qtyPlan: 10,
      qtyFinished: 2,
      now: TODAY,
    });
    expect(r.status).toBe('AT_RISK');
    expect(r.label).toBe('В риске');
    expect(r.tone).toBe('warning');
    expect(r.daysLeft).toBe(1);
    expect(r.progressPercent).toBe(20);
  });

  test('завтрашняя dueDate, прогресс 90% → ON_TRACK (порог 80%)', () => {
    const r = evaluateOrderDeadline({
      status: 'IN_PRODUCTION',
      dueDate: dayOffset(1),
      qtyPlan: 10,
      qtyFinished: 9,
      now: TODAY,
    });
    expect(r.status).toBe('ON_TRACK');
    expect(r.label).toBe('В срок');
    expect(r.tone).toBe('success');
    expect(r.daysLeft).toBe(1);
    expect(r.progressPercent).toBe(90);
  });

  test('срок через 5 дней, прогресс 10% → ON_TRACK (вне окна риска)', () => {
    const r = evaluateOrderDeadline({
      status: 'IN_PRODUCTION',
      dueDate: dayOffset(5),
      qtyPlan: 10,
      qtyFinished: 1,
      now: TODAY,
    });
    expect(r.status).toBe('ON_TRACK');
    expect(r.daysLeft).toBe(5);
    expect(r.progressPercent).toBe(10);
  });

  test('сегодняшняя dueDate, прогресс 0% → AT_RISK (daysLeft = 0)', () => {
    const r = evaluateOrderDeadline({
      status: 'IN_PRODUCTION',
      dueDate: TODAY,
      qtyPlan: 10,
      qtyFinished: 0,
      now: TODAY,
    });
    expect(r.status).toBe('AT_RISK');
    expect(r.daysLeft).toBe(0);
    expect(r.reason).toMatch(/сегодня/i);
  });

  test('qtyPlan = 0 → progressPercent = null, AT_RISK не срабатывает (нечего ускорять)', () => {
    const r = evaluateOrderDeadline({
      status: 'IN_PRODUCTION',
      dueDate: dayOffset(1),
      qtyPlan: 0,
      qtyFinished: 0,
      now: TODAY,
    });
    expect(r.progressPercent).toBeNull();
    expect(r.status).toBe('ON_TRACK');
  });

  test('окно риска: ровно ORDER_DEADLINE_AT_RISK_DAYS дней + < 80% → AT_RISK', () => {
    const r = evaluateOrderDeadline({
      status: 'IN_PRODUCTION',
      dueDate: dayOffset(ORDER_DEADLINE_AT_RISK_DAYS),
      qtyPlan: 10,
      qtyFinished: 7,
      now: TODAY,
    });
    expect(r.status).toBe('AT_RISK');
    expect(r.progressPercent).toBe(70);
    expect(70).toBeLessThan(ORDER_DEADLINE_AT_RISK_PROGRESS);
  });

  test('сравнение по UTC-дню: dueDate сегодня (00:00 UTC), now = 23:59 UTC того же дня → daysLeft = 0', () => {
    const morning = new Date('2026-04-25T00:00:00Z');
    const lateNight = new Date('2026-04-25T23:59:00Z');
    const r = evaluateOrderDeadline({
      status: 'IN_PRODUCTION',
      dueDate: morning,
      qtyPlan: 10,
      qtyFinished: 10, // ON_TRACK, чтобы не уйти в AT_RISK
      now: lateNight,
    });
    expect(r.daysLeft).toBe(0);
    expect(r.status).not.toBe('OVERDUE');
  });
});

describe('computeProgressPercent', () => {
  test('null/0 qtyPlan → null', () => {
    expect(computeProgressPercent(null, 5)).toBeNull();
    expect(computeProgressPercent(0, 5)).toBeNull();
  });
  test('обычный случай: округление до целого', () => {
    expect(computeProgressPercent(3, 1)).toBe(33);
    expect(computeProgressPercent(3, 2)).toBe(67);
  });
  test('clamp 0..100 даже если факт > плана', () => {
    expect(computeProgressPercent(10, 15)).toBe(100);
  });
  test('null qtyFinished считается как 0', () => {
    expect(computeProgressPercent(10, null)).toBe(0);
  });
});

describe('константы и таблицы', () => {
  test('ORDER_DEADLINE_STATUSES содержит все 5 бакетов', () => {
    expect([...ORDER_DEADLINE_STATUSES].sort()).toEqual(
      ['AT_RISK', 'DONE', 'NO_DUE_DATE', 'ON_TRACK', 'OVERDUE'].sort(),
    );
  });
  test('ORDER_DEADLINE_LABELS — на каждый бакет один лейбл', () => {
    for (const s of ORDER_DEADLINE_STATUSES) {
      expect(typeof ORDER_DEADLINE_LABELS[s]).toBe('string');
      expect(ORDER_DEADLINE_LABELS[s].length).toBeGreaterThan(0);
    }
  });
  test('ORDER_DEADLINE_TONES — на каждый бакет валидный tone', () => {
    for (const s of ORDER_DEADLINE_STATUSES) {
      expect(ORDER_DEADLINE_TONES[s]).toMatch(/^(danger|warning|success|muted|info)$/);
    }
  });
  test('ORDER_DEADLINE_SORT_PRIORITY: OVERDUE приоритетнее остальных', () => {
    const p = ORDER_DEADLINE_SORT_PRIORITY;
    expect(p.OVERDUE).toBeLessThan(p.AT_RISK);
    expect(p.AT_RISK).toBeLessThan(p.ON_TRACK);
    expect(p.ON_TRACK).toBeLessThan(p.NO_DUE_DATE);
    expect(p.NO_DUE_DATE).toBeLessThan(p.DONE);
  });
});
