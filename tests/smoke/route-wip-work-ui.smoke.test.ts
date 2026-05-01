/**
 * Smoke-тест UI /work для route-WIP паспортов.
 *
 * После backend-фикса (см. `PassportsService.issueToEmployee`,
 * `docs/domain.md §«Маршруты производства»`, `docs/flows.md §F3a`):
 * паспорт в маршрутном потоке (`currentRouteStepIndex !== null`)
 * принимается без обязательного возврата на ячейку. UI /work должен
 * подхватить это правило симметрично:
 *   - использовать тот же критерий route-WIP — `currentRouteStepIndex !== null`;
 *   - не подталкивать оператора к складской модели, когда речь идёт о
 *     маршрутном паспорте (нейтральные подсказки, спокойный subtext
 *     «ячейка не требуется», бейдж «Из маршрута»);
 *   - сохранить legacy cell-based UX для заказов без маршрута.
 *
 * Полноценного React-рендерера у нас нет (vitest идёт в Node, без
 * jsdom + RTL), поэтому идём тем же путём, что и
 * `route-hint-modal.smoke.test.ts` / `seamstress-feedback.smoke.test.ts`:
 * фиксируем поведение текстовыми проверками исходников.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('route-WIP UX в /work', () => {
  test('state.ts: PassportLookupResult.passport содержит currentRouteStepIndex и currentCellCode', () => {
    const src = read('apps/web/app/work/state.ts');
    // Контракт прокидывания route-WIP-сигнала через server action:
    // фронт получает индекс шага (route-WIP критерий) и текущую
    // ячейку, чтобы решить, какой copy показать в модалке.
    expect(src).toMatch(
      /currentRouteStepIndex:\s*number\s*\|\s*null/,
    );
    expect(src).toMatch(/currentCellCode:\s*string\s*\|\s*null/);
  });

  test('actions.ts: lookupPassportAction прокидывает currentRouteStepIndex и currentCellCode', () => {
    const src = read('apps/web/app/work/actions.ts');
    expect(src).toMatch(
      /currentRouteStepIndex:\s*p\.currentRouteStepIndex/,
    );
    // currentCell может быть null — берём `?.code ?? null`, чтобы
    // не зависеть от формы DTO дальше.
    expect(src).toMatch(/currentCellCode:\s*p\.currentCell\?\.code\s*\?\?\s*null/);
  });

  test('PassportConfirmModal: route-WIP бейдж и спокойный subtext без ячейки', () => {
    const src = read('apps/web/app/work/passport-confirm-modal.tsx');

    // Контракт: модалка принимает оба поля от server action.
    expect(src).toMatch(
      /currentRouteStepIndex:\s*number\s*\|\s*null/,
    );
    expect(src).toMatch(/currentCellCode:\s*string\s*\|\s*null/);

    // Критерий route-WIP единый со state/backend: `!== null`.
    expect(src).toMatch(
      /isRouteWip\s*=\s*passport\.currentRouteStepIndex\s*!==\s*null/,
    );

    // Бейдж «Из маршрута» рендерится только для route-WIP паспортов.
    expect(src).toMatch(/isRouteWip && \(/);
    expect(src).toMatch(/Из маршрута/);

    // Спокойный subtext про «ячейка не требуется» появляется только
    // когда нет ячейки И это маршрутный паспорт (route-WIP без буфера).
    // Не тревожный alert: role="status".
    expect(src).toMatch(
      /showRouteOnlyHint\s*=\s*isRouteWip\s*&&\s*!passport\.currentCellCode/,
    );
    expect(src).toMatch(/ячейка не требуется/);
    expect(src).toMatch(/role="status"/);

    // Кнопка «Принять» по-прежнему disabled только по `pending` —
    // никакой блокировки на route-WIP / отсутствие ячейки.
    const acceptIdx = src.indexOf('btn btn-primary btn-lg btn-block');
    expect(acceptIdx).toBeGreaterThan(0);
    const acceptBlock = src.slice(acceptIdx, acceptIdx + 220);
    expect(acceptBlock).toMatch(/disabled=\{pending\}/);
    expect(acceptBlock).not.toMatch(/isRouteWip/);
    expect(acceptBlock).not.toMatch(/currentCell/);
  });

  test('current-work-card: route-WIP бейдж в карточке активного кроя', () => {
    const src = read('apps/web/app/work/current-work-card.tsx');

    // Тот же UI-критерий, что в модалке и на сервере.
    expect(src).toMatch(
      /isRouteWip\s*=\s*p\.currentRouteStepIndex\s*!==\s*null/,
    );

    // Бейдж рендерится только для route-WIP, чтобы legacy паспорта
    // выглядели как раньше.
    expect(src).toMatch(/isRouteWip && \(/);
    expect(src).toMatch(/active-passport__route-badge/);
    expect(src).toMatch(/Из маршрута/);
  });

  test('current-work-card: empty-state и primary hint больше не требуют ячейку', () => {
    const card = read('apps/web/app/work/current-work-card.tsx');
    // Старая формулировка про «отсканируйте QR паспорта В ЯЧЕЙКЕ» путала
    // оператора в маршрутном flow — после soft-route MVP она убрана.
    expect(card).not.toMatch(/QR паспорта в ячейке/);

    const panel = read('apps/web/app/work/seamstress-active-panel.tsx');
    expect(panel).not.toMatch(/QR паспорта в ячейке/);
  });

  test('legacy DefaultActivePanel hint остаётся route-aware, ячейка остаётся возможной', () => {
    const src = read('apps/web/app/work/active-shift-panel.tsx');
    // Дефолтная двухтабовая панель (CUTTER / админ / менеджер) больше не
    // утверждает, что ячейка обязательна, но и не убирает её — ячейка
    // остаётся возможным буфером (legacy / опциональный буфер для
    // route-WIP). Hint должен явно описывать обе ветки.
    expect(src).toMatch(/если он лежит в ячейке/);
    expect(src).toMatch(/если идёт по маршруту/);
  });

  test('shelf-placement-panel остаётся для CUTTER_ASSISTANT (legacy buffer flow не ломаем)', () => {
    // Контракт: помощник раскройщика по-прежнему может класть крой в
    // ячейку как опциональный буфер. Никаких изменений UI здесь не
    // должно быть — shelf-placement остаётся доступным action-card.
    const panel = read('apps/web/app/work/active-shift-panel.tsx');
    expect(panel).toMatch(/Разместить на стеллаж/);
    expect(panel).toMatch(/ShelfPlacementPanel/);
  });
});
