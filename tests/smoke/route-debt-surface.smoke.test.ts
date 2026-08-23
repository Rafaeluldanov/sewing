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
    // Не блокируем: иначе брошенный в конце смены паспорт залипнет до
    // мастера, а ОТК/ВТО не смогут его принять.
    expect(src).not.toMatch(/takenFromEmployeeId[\s\S]{0,200}throw new/);
  });
});
