/**
 * Smoke-щит фичи «табель дня сотрудника» в кабинете мастера (12.08.2026).
 *
 * Полноценного React-рендера в проекте нет (vitest идёт в Node без
 * jsdom + RTL — см. `tests/smoke/frontend-rbac.smoke.test.ts`), поэтому
 * фиксируем инварианты по исходникам:
 *
 *   1. Отрезки смены (`ShiftSegment`) пишутся ВО ВСЕХ точках, где смена
 *      начинается, меняет операцию или заканчивается. Пропущенная точка
 *      = вечно открытый отрезок и враньё в «где был».
 *   2. Табель — отдельная ручка `GET /api/master/employee-stats/day`
 *      под теми же ролями, что вся вкладка.
 *   3. Сутки везде МОСКОВСКИЕ: и окно списка, и табель. UTC-окно
 *      уводило работу 00:00–03:00 МСК в предыдущий день.
 *   4. Табель — ШТОРКА поверх вкладки, а не маршрут: вкладки кабинета
 *      живут в `useState`, и переход на страницу с возвратом «назад»
 *      выкидывал бы мастера на «Доску».
 *   5. Список сотрудников — карточки, а не таблица: кабинет мастера
 *      это терминал шириной до 720px.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('табель дня — ведение отрезков смены', () => {
  test('ShiftsService пишет сегменты на start / switchOperation / stop', () => {
    const src = readSrc('apps/api/src/modules/shifts/shifts.service.ts');
    expect(src).toMatch(/from '\.\/shift-segments\.js'/);
    // Открытие: старт смены и вторая половина переключения операции.
    expect(src.match(/openShiftSegment\(/g)?.length ?? 0).toBeGreaterThanOrEqual(
      2,
    );
    // Закрытие: первая половина переключения операции и stop.
    expect(
      src.match(/closeShiftSegments\(/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });

  test('смена участка закрывает отрезок (не идёт через ShiftsService.stop)', () => {
    const src = readSrc('apps/api/src/modules/me/me.service.ts');
    expect(src).toMatch(/closeShiftSegments\(/);
  });

  test('техническая смена мастера тоже ведёт отрезок', () => {
    const src = readSrc(
      'apps/api/src/modules/master-actions/master-actions.service.ts',
    );
    expect(src).toMatch(/openShiftSegment\(/);
    expect(src).toMatch(/closeShiftSegments\(/);
  });

  test('инвариант «один открытый отрезок на смену» заведён в БД', () => {
    const src = readSrc('apps/api/src/prisma/prisma-client-manager.ts');
    expect(src).toMatch(/shift_segment_open_session_uniq/);
    expect(src).toMatch(/ON "ShiftSegment" \("shiftSessionId"\) WHERE "endedAt" IS NULL/);
  });

  test('модель ShiftSegment есть в схеме и связана со сменой каскадом', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/model ShiftSegment \{/);
    expect(schema).toMatch(
      /shiftSession ShiftSession @relation\(fields: \[shiftSessionId\], references: \[id\], onDelete: Cascade\)/,
    );
  });
});

describe('табель дня — API', () => {
  test('ручка day объявлена под ролями всей вкладки', () => {
    const src = readSrc(
      'apps/api/src/modules/master-employee-stats/master-employee-stats.controller.ts',
    );
    expect(src).toMatch(/@Roles\('SHOPFLOOR_MASTER', 'SHOP_MANAGER', 'ADMIN'\)/);
    expect(src).toMatch(/@Get\('day'\)/);
    expect(src).toMatch(/MasterEmployeeDayQuerySchema/);
  });

  test('сутки считаются по Москве, окно полуоткрытое', () => {
    const src = readSrc(
      'apps/api/src/modules/master-employee-stats/master-employee-stats.service.ts',
    );
    expect(src).toMatch(/moscowDayWindow/);
    // Именно `lt`, а не `lte`: иначе полночь попадала бы в оба дня.
    expect(src).toMatch(/lt: window\.to/);
    expect(src).not.toMatch(/lte: window\.to/);
  });

  test('тайм-трекер считает те же сутки, что и статистика', () => {
    // `TimeTrackingService` берёт брак из `masterStats.getStats/getDrill`,
    // а сеансы считает сам. Разные окна = разные цифры в двух вкладках,
    // которые обещают показывать одно и то же.
    const src = readSrc(
      'apps/api/src/modules/time-tracking/time-tracking.service.ts',
    );
    expect(src).toMatch(/moscowDayWindow/);
    expect(src).toMatch(/moscowDayKey/);
    expect(src).not.toMatch(/T00:00:00\.000Z/);
    expect(src).not.toMatch(/lte: win\.to/);
  });

  test('поразмерная норма времени в табель не идёт', () => {
    const src = readSrc(
      'apps/api/src/modules/master-employee-stats/master-employee-stats.service.ts',
    );
    // Только FIXED: BY_SIZE к дню не свести — размеры в дне перемешаны.
    expect(src).toMatch(/timeNormMode: 'FIXED'/);
  });
});

describe('табель дня — UI', () => {
  test('табель открывается шторкой, а не отдельным маршрутом', () => {
    const view = readSrc('apps/web/app/master/employee-stats-view.tsx');
    expect(view).toMatch(/<EmployeeDaySheet/);
    expect(view).not.toMatch(/router\.push\(['"`]\/master\/employees/);
  });

  test('в табель ведут оба входа: список и карточка открытой смены', () => {
    const view = readSrc('apps/web/app/master/employee-stats-view.tsx');
    expect(view.match(/openDay\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(view).toMatch(/onOpenDay/);
  });

  test('список сотрудников — карточки с мини-лентой, а не таблица', () => {
    const view = readSrc('apps/web/app/master/employee-stats-view.tsx');
    expect(view).toMatch(/mstat__card/);
    expect(view).toMatch(/mstat__mini/);
    expect(view).not.toMatch(/<table className="mstat__table">/);
  });

  test('лента дня вертикальная — высота строки задаётся длительностью', () => {
    const sheet = readSrc('apps/web/app/master/employee-day-sheet.tsx');
    expect(sheet).toMatch(/minHeight: ribbonHeight\(/);
  });

  test('время в UI форматируется по Москве', () => {
    const sheet = readSrc('apps/web/app/master/employee-day-sheet.tsx');
    expect(sheet).toMatch(/timeZone: 'Europe\/Moscow'/);
  });

  test('палитра участков объявлена в стилях кабинета', () => {
    const css = readSrc('apps/web/app/globals.css');
    for (const token of [
      '--u-sewing',
      '--u-ironing',
      '--u-qc',
      '--u-packing',
      '--u-cutting',
    ]) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.mday__lane/);
  });
});
