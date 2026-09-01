/**
 * Smoke-тест поверхности «незакрытая работа» (source-grep).
 *
 * Зеркальная половина `off-route-work-gate.smoke.test.ts`. Тот сторожит
 * случай «закрыли операцию, которой нет в маршруте»; этот — обратный и
 * до 23.08.2026 не покрытый ничем: операция в маршруте ЕСТЬ, а закрытия
 * по ней нет, потому что паспорт увели вперёд чужим сканом.
 *
 * Инцидент 17-18.08.2026, заказ 02-00013: 10 паспортов, 146 изделий,
 * 3 743,44 руб. сделки не начислено никому, и ни один экран этого не
 * показывал (`scripts/migrations/20260823_backfill_unclosed_rasposhiv_02-00013.sql`).
 *
 * Сторожим ровно то, что легко «упростить» при рефакторинге:
 *   - два правила отсева (SEWING + вне параллельной группы), без
 *     которых экран утонет в шуме и им перестанут пользоваться;
 *   - обе поверхности считают ОДНОЙ функцией (иначе мастер и
 *     администратор увидят разные картины);
 *   - перехват паспорта из чужих рук пишет аудит, иначе потерянную
 *     работу нельзя посчитать постфактум.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const DEBT = 'apps/api/src/modules/production-board/route-debt.ts';
const BOARD = 'apps/api/src/modules/production-board/production-board.service.ts';
const DIAGNOSTICS = 'apps/api/src/modules/diagnostics/diagnostics.service.ts';
const PASSPORTS = 'apps/api/src/modules/passports/passports.service.ts';
const SHIFTS = 'apps/api/src/modules/shifts/shifts.service.ts';
const WORK_PANEL = 'apps/web/app/work/seamstress-active-panel.tsx';
const MASTER_ACTIONS =
  'apps/api/src/modules/master-actions/master-actions.service.ts';

describe('поверхность «незакрытая работа»', () => {
  test('правило отсева: только SEWING и только вне параллельной группы', () => {
    const src = read(DEBT);
    // Шаг параллельной группы держит AND-гейт перед ОТК — дублировать
    // его находкой значит показывать мастеру нормальную работу.
    expect(src).toMatch(/if \(step\.parallelGroup !== null\) continue;/);
    // Остальные категории не пишут OPERATION_FINISHED вообще.
    expect(src).toMatch(/if \(!step\.isSewing\) continue;/);
    // Шаг ПОЗАДИ паспорта, а не любой незакрытый.
    expect(src).toMatch(/if \(step\.index >= p\.currentRouteStepIndex\) continue;/);
  });

  test('закрытие заместителем и допуском засчитывается', () => {
    const src = read(DEBT);
    expect(src).toMatch(/substitutesFor/);
    // Допуски подмешиваются к справочным правилам на стороне сервиса.
    expect(read(BOARD)).toMatch(/loadActivePermitSubstitutions/);
  });

  test('обе поверхности считают одной функцией', () => {
    expect(read(BOARD)).toMatch(/computeRouteDebts\(/);
    expect(read(DIAGNOSTICS)).toMatch(/computeRouteDebts\(/);
    expect(read(DIAGNOSTICS)).toMatch(/ORDER_WORK_LEFT_UNCLOSED/);
  });

  test('две причины различимы: взяли и бросили / проехали мимо', () => {
    const src = read(DEBT);
    expect(src).toMatch(/'ABANDONED'/);
    expect(src).toMatch(/'SKIPPED'/);
    // Причина входит в ключ группы — иначе два разных разбора
    // склеятся в одну строку.
    expect(src).toMatch(/\$\{reason\}/);
  });

  test('перехват паспорта чужим сканом пишет аудит и лог', () => {
    const src = read(PASSPORTS);
    expect(src).toMatch(/PASSPORT_TAKEN_FROM_EMPLOYEE/);
    expect(src).toMatch(/abandonedOperationId/);
    expect(src).toMatch(/event=passport\.scan\.taken_unclosed/);
  });

  // -------------------------------------------------------------------------
  // Гейт «нельзя уйти вперёд с незакрытого шага» (01.09.2026).
  //
  // 23.08.2026 этот случай решили ТОЛЬКО фиксировать — блокировать
  // побоялись, чтобы брошенный в конце смены паспорт не залипал до
  // мастера. Детектор сработал, но долг продолжил появляться (31.08,
  // заказ 02-00020: ОТК увела у распошивщицы пять паспортов подряд),
  // поэтому гейт закрыли, а «залипание» сняли двумя выходами. Эти три
  // теста сторожат гейт ВМЕСТЕ С выходами: убрать любой из них —
  // значит остановить цех.
  // -------------------------------------------------------------------------

  test('шаг, на котором паспорт стоит, проверяется на закрытие', () => {
    const src = read(PASSPORTS);
    expect(src).toMatch(/currentStepCandidate/);
    expect(src).toMatch(/currentStepIncomplete/);
    expect(src).toMatch(/PassportCurrentStepIncompleteException/);
  });

  test('сужение гейта = зеркало правила долга: только вперёд, SEWING, вне группы', () => {
    const src = read(PASSPORTS);
    // Только вперёд — иначе ломается доделка долга (`catchUpCandidate`)
    // и вторая операция той же параллельной группы.
    expect(src).toMatch(/targetRep > currentRep &&/);
    // Те же два отсева, что в `route-debt.ts`.
    expect(src).toMatch(
      /curStep\.parallelGroup == null &&\s*\n\s*curStep\.operation\.category === OperationCategory\.SEWING/,
    );
  });

  test('у обеих сторон есть выход из-под гейта', () => {
    // 1) Сам сотрудник закрывает свой долг, не двигая паспорт назад.
    expect(read(PASSPORTS)).toMatch(/closeUnclosedOperationByEmployee/);
    expect(read(SHIFTS)).toMatch(/getMyUnclosedPassports/);
    expect(read(WORK_PANEL)).toMatch(/UnclosedSection/);
    expect(read(WORK_PANEL)).toMatch(/closeUnclosedOperationAction/);
    // 2) Мастер продавливает паспорт вперёд — `set-route-step` через
    //    `evaluateRouteOrder` не ходит вовсе, и это намеренно.
    expect(read(MASTER_ACTIONS)).not.toMatch(/evaluateRouteOrder/);
  });
});
