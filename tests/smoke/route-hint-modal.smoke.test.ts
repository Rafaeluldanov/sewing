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
 *   2. В блоке есть «Сейчас» / «Далее» и warning-параграф для случая
 *      `routeMismatchWithActiveShift = true`.
 *   3. Server action `lookupPassportAction` прокидывает `routeHint` из
 *      backend `PassportDetailDto` в `PassportLookupResult.passport`.
 *   4. `state.ts` объявляет поле `routeHint: PassportRouteHintDto | null`
 *      в `PassportLookupResult.passport` (контракт прокидывания через
 *      server action).
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
    // Warning рендерится по флагу routeMismatchWithActiveShift,
    // в стиле «info-only» — без disable-кнопок и без 409.
    expect(src).toMatch(/routeMismatchWithActiveShift/);
    expect(src).toMatch(/active-passport__route-warn/);
    // «последний шаг маршрута» — спокойный fallback, когда nextStep = null.
    expect(src).toMatch(/последний шаг/);
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
