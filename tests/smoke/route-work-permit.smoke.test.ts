/**
 * Smoke-тест наряда-допуска (`RouteWorkPermit`, source-grep).
 *
 * Допуск — легальный обход гейта «работа мимо маршрута». Без него
 * первая же нештатная ситуация (сломался станок, срочный перекрой, цех
 * перешёл на другую технологию посреди партии) при
 * `offRouteWorkPolicy = BLOCK` означает простой рабочего места, а
 * простой заканчивается требованием выключить гейт — и второй раз его
 * никто не включит.
 *
 * Главное, что фиксирует сторож: допуск читается ВО ВСЕХ ТРЁХ точках,
 * где читаются правила замены. Если пропустить хоть одну, допуск
 * становится бумажкой: швея дошьёт, а паспорт всё равно не закроет шаг
 * маршрута, и AND-гейт перед ОТК всё равно уронит партию — ровно
 * инцидент 28.07.2026, только неделей позже и с разрешением на руках.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('наряд-допуск мастера', () => {
  test('допуск читается в МАРШРУТНОМ гейте (issue/scan/complete)', () => {
    const src = read('apps/api/src/modules/passports/passports.service.ts');
    expect(src).toMatch(/loadActivePermitSubstitutions/);
    // Подмешивается и в резолв целевого шага, и в AND-гейт.
    expect(src).toMatch(/permitSubs/);
    expect(src).toMatch(/permitSubsForGate/);
    expect(src).toMatch(/\[\.\.\.substitutes, \.\.\.permitSubsForGate\]/);
  });

  test('допуск читается в гейте ОТК', () => {
    const src = read('apps/api/src/modules/qc/qc.service.ts');
    expect(src).toMatch(/loadActivePermitSubstitutions/);
    expect(src).toMatch(/\[\.\.\.substitutes, \.\.\.permitSubs\]/);
  });

  test('допуск читается в расчёте расхождений', () => {
    const src = read(
      'apps/api/src/modules/production-board/production-board.service.ts',
    );
    expect(src).toMatch(/loadActivePermitSubstitutions/);
    expect(src).toMatch(/\[\.\.\.substitutions, \.\.\.permitSubs\]/);
  });

  test('«какой шаг закрывает» обязателен и проверяется по снимку маршрута', () => {
    const schema = read('prisma/schema.prisma');
    // NOT NULL в схеме.
    expect(schema).toMatch(/satisfiesStepOperationId String\s*$/m);
    const svc = read(
      'apps/api/src/modules/master-actions/master-actions.service.ts',
    );
    // Закрываемый шаг обязан реально стоять в маршруте заказа.
    expect(svc).toMatch(/if \(!routeOps\.has\(dto\.satisfiesStepOperationId\)\)/);
    // А разрешаемой операции в маршруте быть НЕ должно — иначе допуск не нужен.
    expect(svc).toMatch(/if \(routeOps\.has\(dto\.operationId\)\)/);
    expect(svc).toMatch(/RouteWorkPermitOperationAlreadyInRouteException/);
  });

  test('допуск ограничен: срок, отзыв, лимит штук', () => {
    const helper = read('apps/api/src/modules/routes/route-work-permits.ts');
    expect(helper).toMatch(/revokedAt: null/);
    expect(helper).toMatch(/expiresAt: \{ gt: now \}/);
    // Лимит считается по фактически закрытым изделиям, иначе он декорация.
    expect(helper).toMatch(/qtyGood/);
    expect(helper).toMatch(/usedByPermit/);
  });

  test('выдача и отзыв пишут аудит и требуют причину', () => {
    const svc = read(
      'apps/api/src/modules/master-actions/master-actions.service.ts',
    );
    expect(svc).toMatch(/MASTER_ROUTE_WORK_PERMIT_ISSUED/);
    expect(svc).toMatch(/MASTER_ROUTE_WORK_PERMIT_REVOKED/);
    const shared = read('packages/shared/src/master-actions.ts');
    expect(shared).toMatch(/reason: z\.string\(\)\.min\(3\)/);
    // Срок по умолчанию — одна смена, не бессрочно.
    expect(shared).toMatch(/hours: z\.number\(\)\.int\(\)\.min\(1\)\.max\(72\)\.default\(12\)/);
  });

  test('ручки выдачи/отзыва — под RBAC мастера', () => {
    const ctrl = read(
      'apps/api/src/modules/master-actions/master-actions.controller.ts',
    );
    expect(ctrl).toMatch(/route-work-permits/);
    expect(ctrl).toMatch(/@Roles\(/);
    // Разблокировка цеха — право мастера, а не разработчика: до этого
    // её делали прямыми SQL-патчами по боевой базе.
    expect(ctrl).toMatch(/SHOPFLOOR_MASTER/);
  });

  test('UI: допуск выдаётся из строки «Расхождений», а не с отдельного экрана', () => {
    const view = read('apps/web/app/master/divergences-view.tsx');
    expect(view).toMatch(/PermitForm/);
    expect(view).toMatch(/Так и должно быть — выдать допуск/);
    // Действующие допуски видны там же: мастер должен видеть, что сам
    // разрешил, иначе завтра выдаст второй такой же.
    expect(view).toMatch(/PermitsSection/);
    expect(view).toMatch(/Отозвать/);
  });

  test('UI: «какой шаг закрывает» — обязательное поле формы', () => {
    const form = read('apps/web/app/master/permit-form.tsx');
    expect(form).toMatch(/Какой шаг маршрута закрывает эта работа/);
    // Кнопка неактивна, пока шаг не выбран и не указана причина.
    expect(form).toMatch(
      /satisfiesStepOperationId\.length > 0 &&\s*reason\.trim\(\)\.length >= 3/,
    );
    // Кандидаты — только швейные шаги маршрута этого заказа.
    expect(form).toMatch(/item\.routeSewingSteps\.map/);
  });
});
