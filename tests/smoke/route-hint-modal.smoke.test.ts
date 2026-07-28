/**
 * Smoke-тест Soft-route hint в модалке `PassportConfirmModal` на /work
 * (STEP 8 ТЗ MVP, см. также `docs/screens.md` и `docs/api.md §17`).
 *
 * Полноценного React-рендерера у нас нет (vitest идёт в Node, без
 * jsdom + RTL), поэтому идём тем же путём, что и
 * `seamstress-feedback.smoke.test.ts`: проверяем поведение текстовыми
 * утверждениями по исходникам.
 *
 * Покрываем:
 *   1. Модалка `PassportConfirmModal` импортирует тип `PassportRouteHintDto`
 *      и условно рендерит блок маршрута только когда `routeHint` есть
 *      (если `null` — блок не рендерится).
 *   2. В блоке есть «Сейчас» / «Далее» и ДВА РАЗНЫХ по громкости
 *      предупреждения — по `routeMismatchKind` (см. п. 5).
 *   3. Server action `lookupPassportAction` прокидывает `routeHint` из
 *      backend `PassportDetailDto` в `PassportLookupResult.passport`.
 *   4. `state.ts` объявляет поле `routeHint: PassportRouteHintDto | null`
 *      в `PassportLookupResult.passport` (контракт прокидывания через
 *      server action).
 *   5. Два уровня громкости предупреждения (28.07.2026). Раньше здесь
 *      был один жёлтый баннер по `routeMismatchWithActiveShift`, и он
 *      горел почти на каждой штатной передаче паспорта, потому что
 *      «ожидаемой» считалась только что ЗАКРЫТАЯ операция. К нему
 *      привыкли — и реальное отклонение 01.07 (окантовка вместо
 *      киперки) не отличили от фона; партию нашли 28.07, когда встал
 *      ОТК. Сторож фиксирует, что `OFF_ROUTE` (операции нет в маршруте
 *      вообще) и `WRONG_STEP` (не тот шаг по очереди) рендерятся
 *      РАЗНЫМИ классами и что `PARALLEL`/`SUBSTITUTE` не рендерятся
 *      вовсе — иначе громкий уровень снова утонет в тихом.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

describe('soft-route hint в /work (PassportConfirmModal)', () => {
  test('passport-confirm-modal.tsx условно рендерит блок маршрута только при routeHint', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/web/app/work/passport-confirm-modal.tsx'),
      'utf8',
    );
    expect(src).toMatch(/PassportRouteHintDto/);
    // Условный рендер — блок появляется только если routeHint !== null.
    expect(src).toMatch(/passport\.routeHint &&/);
    expect(src).toMatch(/PassportRouteHintBlock/);
  });

  test('PassportRouteHintBlock содержит «Сейчас», «Далее» и warning-параграф', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/web/app/work/passport-confirm-modal.tsx'),
      'utf8',
    );
    // Метки «Сейчас» / «Далее» — общий визуальный язык с current-work-card.
    expect(src).toMatch(/>Сейчас</);
    expect(src).toMatch(/>Далее</);
    // Предупреждение рендерится по `routeMismatchKind`, в стиле
    // «info-only» — без disable-кнопок и без 409.
    expect(src).toMatch(/routeMismatchKind/);
    expect(src).toMatch(/active-passport__route-warn/);
    // «последний шаг маршрута» — спокойный fallback, когда nextStep = null.
    expect(src).toMatch(/последний шаг/);
  });

  test('два уровня громкости: OFF_ROUTE ≠ WRONG_STEP, PARALLEL/SUBSTITUTE молчат', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/web/app/work/passport-confirm-modal.tsx'),
      'utf8',
    );
    // Оба уровня существуют и рендерятся ПО-РАЗНОМУ.
    expect(src).toMatch(/routeMismatchKind === 'WRONG_STEP'/);
    expect(src).toMatch(/routeMismatchKind === 'OFF_ROUTE'/);
    expect(src).toMatch(/active-passport__route-alert/);
    // Громкий уровень — role="alert", тихий — role="status".
    expect(src).toMatch(/active-passport__route-alert" role="alert"/);
    // Норма молчит: по параллельной группе и легальной замене баннера
    // быть не должно, иначе громкий уровень снова утонет в потоке.
    expect(src).not.toMatch(/routeMismatchKind === 'PARALLEL'/);
    expect(src).not.toMatch(/routeMismatchKind === 'SUBSTITUTE'/);
  });

  test('current-work-card.tsx разводит те же два уровня', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/web/app/work/current-work-card.tsx'),
      'utf8',
    );
    // Карточка активного кроя не имеет routeHint, но обязана говорить на
    // том же языке: «нет в маршруте вообще» ≠ «не тот шаг».
    expect(src).toMatch(/shiftOperationOffRoute/);
    expect(src).toMatch(/routeOperationIds/);
    expect(src).toMatch(/active-passport__route-alert/);
  });

  test('warning не блокирует кнопки (нет disable={routeMismatch...})', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/web/app/work/passport-confirm-modal.tsx'),
      'utf8',
    );
    // Сами кнопки disabled только по `pending`. Никаких mismatch-блокировок.
    const acceptBtnIdx = src.indexOf('btn btn-primary btn-lg btn-block');
    expect(acceptBtnIdx).toBeGreaterThan(0);
    const acceptDisabled = src.slice(acceptBtnIdx, acceptBtnIdx + 220);
    expect(acceptDisabled).toMatch(/disabled=\{pending\}/);
    expect(acceptDisabled).not.toMatch(/routeMismatch/);
  });

  test('actions.ts: lookupPassportAction прокидывает routeHint в PassportLookupResult', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/web/app/work/actions.ts'),
      'utf8',
    );
    expect(src).toMatch(/routeHint:\s*p\.routeHint\s*\?\?\s*null/);
  });

  test('state.ts: PassportLookupResult.passport содержит routeHint', () => {
    const src = readFileSync(
      path.join(repoRoot, 'apps/web/app/work/state.ts'),
      'utf8',
    );
    expect(src).toMatch(/PassportRouteHintDto/);
    expect(src).toMatch(/routeHint:\s*PassportRouteHintDto\s*\|\s*null/);
  });
});
