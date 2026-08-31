/**
 * Автозавершение смен, забытых открытыми.
 *
 * Проблема в цифрах (прод, 31.08.2026): из 755 закрытых смен 429
 * длиннее 10 часов, 269 длиннее 16, 194 — дольше суток, рекорд 1643
 * часа. Смена не связана с сессией и не закрывается сама, поэтому часы,
 * загрузка и выработка в час недостоверны.
 *
 * Договорённости фичи:
 *   - два порога, берётся ближайший: время суток по Москве и предельная
 *     длительность (для смен, начатых сразу после порога);
 *   - порог решает КОГДА закрывать, режим — каким временем; по
 *     умолчанию `LAST_ACTIVITY`, иначе часы остаются такой же неправдой,
 *     только с закрытыми сменами;
 *   - планировщика в проекте нет: проверку дёргают экраны, которым эти
 *     цифры и нужны (тот же приём, что `PayrollScheduleService.ensureDueDraft`);
 *   - по умолчанию выключено — после миграции ничего не меняется.
 *
 * Арифметику правила проверяем напрямую (чистые функции), остальное —
 * source-level, как в других smoke-тестах проекта.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  parseShiftAutoCloseTime,
  shiftMaxDurationLabel,
  SHIFT_AUTO_CLOSE_MODES,
} from '@sewing/shared/company-settings';

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(path.join(repoRoot, p), 'utf8');

/** Локальная копия арифметики порога — та же, что в API (MSK = UTC+3). */
const MSK = 3 * 3600_000;
const DAY = 24 * 3600_000;
function nextMoscowTimeAfter(after: Date, minutesOfDay: number): Date {
  const shifted = after.getTime() + MSK;
  const dayStart = Math.floor(shifted / DAY) * DAY;
  let candidate = dayStart + minutesOfDay * 60_000;
  if (candidate <= shifted) candidate += DAY;
  return new Date(candidate - MSK);
}

describe('порог по времени суток (Москва)', () => {
  test('смена с утра закрывается тем же вечером', () => {
    // 08:00 МСК = 05:00 UTC; порог 22:00 МСК = 19:00 UTC тех же суток.
    const started = new Date('2026-08-31T05:00:00.000Z');
    expect(nextMoscowTimeAfter(started, 22 * 60).toISOString()).toBe(
      '2026-08-31T19:00:00.000Z',
    );
  });

  test('смена, начатая ПОСЛЕ порога, живёт до следующего вечера', () => {
    // 23:00 МСК 31.08 = 20:00 UTC 31.08 → порог 22:00 МСК 01.09.
    const started = new Date('2026-08-31T20:00:00.000Z');
    expect(nextMoscowTimeAfter(started, 22 * 60).toISOString()).toBe(
      '2026-09-01T19:00:00.000Z',
    );
  });

  test('смена, начатая РОВНО в порог, не закрывается в ту же секунду', () => {
    const started = new Date('2026-08-31T19:00:00.000Z'); // 22:00 МСК
    expect(nextMoscowTimeAfter(started, 22 * 60).getTime()).toBeGreaterThan(
      started.getTime(),
    );
  });

  test('ночь после полуночи по Москве считается следующими сутками', () => {
    // 01:00 МСК 01.09 = 22:00 UTC 31.08; порог 22:00 МСК того же 01.09.
    const started = new Date('2026-08-31T22:00:00.000Z');
    expect(nextMoscowTimeAfter(started, 22 * 60).toISOString()).toBe(
      '2026-09-01T19:00:00.000Z',
    );
  });
});

describe('shared — контракт настройки', () => {
  test('режим по умолчанию — по последней отметке', () => {
    expect(SHIFT_AUTO_CLOSE_MODES[0]).toBe('LAST_ACTIVITY');
  });

  test('время разбирается только в формате ЧЧ:ММ', () => {
    expect(parseShiftAutoCloseTime('22:00')).toBe(1320);
    expect(parseShiftAutoCloseTime('07:30')).toBe(450);
    expect(parseShiftAutoCloseTime('')).toBeNull();
    expect(parseShiftAutoCloseTime(null)).toBeNull();
    expect(parseShiftAutoCloseTime('25:00')).toBeNull();
    expect(parseShiftAutoCloseTime('22-00')).toBeNull();
  });

  test('ноль часов — «без ограничения», а не «закрывать мгновенно»', () => {
    expect(shiftMaxDurationLabel(0)).toBe('Без ограничения');
    expect(shiftMaxDurationLabel(12)).toBe('12 часов подряд');
  });
});

describe('схема — по умолчанию выключено', () => {
  const schema = read('prisma/schema.prisma');

  test('время не задано (nullable), лимит длительности 0', () => {
    expect(schema).toMatch(/shiftAutoCloseTime String\?/);
    expect(schema).toMatch(/shiftMaxDurationHours Int @default\(0\)/);
  });

  test('режим по умолчанию — LAST_ACTIVITY', () => {
    expect(schema).toMatch(
      /shiftAutoCloseMode ShiftAutoCloseMode @default\(LAST_ACTIVITY\)/,
    );
  });

  test('в смене отдельная отметка «закрыла система»', () => {
    expect(schema).toMatch(/autoClosedAt DateTime\?/);
  });
});

describe('api — правило и его применение', () => {
  const rule = read('apps/api/src/modules/shifts/shift-auto-close.ts');
  const service = read('apps/api/src/modules/shifts/shift-auto-close.service.ts');

  test('берётся ближайший из двух порогов', () => {
    expect(rule).toMatch(/candidates\.reduce\(\(min, d\) => \(d < min \? d : min\)\)/);
  });

  test('конец по активности не может уехать за порог', () => {
    expect(rule).toMatch(/notBeforeStart > args\.deadline \? args\.deadline/);
  });

  test('закрытие идемпотентно: не перетирает уже закрытую смену', () => {
    expect(service).toMatch(/where: \{ id: args\.sessionId, endedAt: null \}/);
  });

  test('отрезки табеля закрываются тем же временем, что и смена', () => {
    expect(service).toMatch(
      /closeShiftSegments\(this\.prisma, args\.sessionId, args\.endedAt\)/,
    );
  });

  test('оклад пересчитывается по дню НАЧАЛА смены', () => {
    expect(service).toMatch(/syncDailySalary\(args\.employeeId, args\.startedAt\)/);
  });

  test('каждое автозакрытие попадает в аудит', () => {
    expect(service).toMatch(/event: 'SHIFT_AUTO_CLOSED'/);
  });

  test('скан троттлится и не чаще раза в минуту', () => {
    expect(service).toMatch(/SCAN_THROTTLE_MS = 60_000/);
  });
});

describe('api — кто дёргает проверку (планировщика в проекте нет)', () => {
  test('старт смены закрывает свою забытую — иначе SHIFT_ALREADY_ACTIVE', () => {
    const shifts = read('apps/api/src/modules/shifts/shifts.service.ts');
    expect(shifts).toMatch(/autoClose\.runIfDue\(dto\.employeeId\)/);
    const startIdx = shifts.indexOf('async start(');
    const callIdx = shifts.indexOf('autoClose.runIfDue(dto.employeeId)');
    const activeCheckIdx = shifts.indexOf('ShiftAlreadyActiveException()');
    expect(callIdx).toBeGreaterThan(startIdx);
    expect(callIdx).toBeLessThan(activeCheckIdx);
  });

  test('табель мастера и список активных смен', () => {
    const master = read(
      'apps/api/src/modules/master-employee-stats/master-employee-stats.service.ts',
    );
    expect((master.match(/autoClose\.runIfDue\(\)/g) ?? []).length).toBe(2);
  });

  test('тайм-трекер админки', () => {
    const tt = read('apps/api/src/modules/time-tracking/time-tracking.service.ts');
    expect(tt).toMatch(/autoClose\.runIfDue\(\)/);
  });
});

describe('web — настройка', () => {
  const section = read(
    'apps/web/app/admin/company-settings/shift-auto-close-section.tsx',
  );
  const page = read('apps/web/app/admin/company-settings/page.tsx');

  test('время, предельная длительность и режим — одной формой', () => {
    expect(section).toMatch(/name="shiftAutoCloseTime"/);
    expect(section).toMatch(/name="shiftMaxDurationHours"/);
    expect(section).toMatch(/name="shiftAutoCloseMode"/);
  });

  test('секция на вкладке «Вход и смены»', () => {
    expect(page).toMatch(/<ShiftAutoCloseSection settings=\{settings\} \/>/);
    expect(page).toMatch(/label="Вход и смены"/);
  });
});
