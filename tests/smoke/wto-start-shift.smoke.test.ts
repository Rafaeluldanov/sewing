/**
 * Smoke-тест: scan-driven терминал ВТО (`/wto`) показывает start-shift
 * UI, а не «голую» кнопку «Сканировать паспорт», когда у сотрудника
 * нет активной смены.
 *
 * Полный аналог `qc-start-shift.smoke.test.ts` — фиксируем контракт
 * между `WtoPage` и `WtoTerminal`, чтобы регрессия «у ВТО пропала
 * кнопка Начать смену» больше не повторилась (раньше /wto сразу
 * рендерил scan-терминал, и любое сканирование упиралось в backend
 * `SHIFT_SESSION_REQUIRED`, см. `docs/flows.md §F6`).
 *
 * Покрываем три инварианта (см. `docs/screens.md §5a.1`,
 * `docs/flows.md §F6`):
 *   1. Страница `/wto` подтягивает `getShiftMeta` + `getCurrentShift`
 *      и прокидывает их в `WtoTerminal` (как `/qc/page.tsx` и
 *      `/packing/page.tsx`).
 *   2. `WtoTerminal` использует тот же reuse-компонент
 *      `SeamstressShiftStart`, что и швея/ОТК/упаковщик, когда смены
 *      нет — никакого собственного start-shift UI у `/wto` нет.
 *   3. `WtoTerminal` выбирает scan-flow только при активной смене на
 *      операции категории `IRONING` — иначе показывает start-shift
 *      форму или банер «Смена не на ВТО».
 *
 * Также фиксируем, что меню действий (`SeamstressActionsMenu`) —
 * единая точка logout/«Завершить смену» на `/wto` — не дублируется
 * прежней inline-формой `qc-logout` (она же раньше использовалась
 * в `wto-terminal.tsx`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('WTO start-shift gating (/wto)', () => {
  test('WtoPage подтягивает shift meta + current и передаёт их в WtoTerminal', () => {
    const src = readSrc('apps/web/app/wto/page.tsx');
    expect(src).toMatch(/from '@\/lib\/shifts-api'/);
    expect(src).toMatch(/getShiftMeta\(\)/);
    expect(src).toMatch(/getCurrentShift\(\)/);
    // initialShift / activeOperationCategory передаются именно как
    // отдельные пропсы — иначе `WtoTerminal` не сможет принять решение
    // на клиенте без лишнего round-trip.
    expect(src).toMatch(/initialShift=\{currentShift\}/);
    expect(src).toMatch(/activeOperationCategory=\{activeOperationCategory\}/);
    // fail-soft на ApiRequestError: сбой /shifts/current не должен
    // ломать весь экран — терминал просто покажет start-shift форму.
    expect(src).toMatch(/ApiRequestError/);
  });

  test('WtoTerminal реюзает SeamstressShiftStart, не создаёт собственный start-shift UI', () => {
    const src = readSrc('apps/web/app/wto/wto-terminal.tsx');
    expect(src).toMatch(
      /from '@\/app\/work\/seamstress-shift-start'/,
    );
    expect(src).toMatch(/<SeamstressShiftStart\s+meta=\{meta\}\s+employee=\{employee\}/);
    // SeamstressActionsMenu — единая точка «Завершить смену» / «Выйти»,
    // как у швеи/ОТК/упаковщика. Прежняя inline-форма qc-logout
    // должна быть убрана, иначе на экране две точки выхода.
    expect(src).toMatch(/from '@\/app\/work\/seamstress-actions-menu'/);
    expect(src).toMatch(/<SeamstressActionsMenu\s+shiftActive=\{isShiftActive\}/);
    expect(src).not.toMatch(/qc-logout/);
    expect(src).not.toMatch(/logoutAction/);
  });

  test('WtoTerminal выбирает scan-flow только при активной IRONING-смене', () => {
    const src = readSrc('apps/web/app/wto/wto-terminal.tsx');
    // Категория сравнивается явно с 'IRONING'.
    expect(src).toMatch(
      /onWtoShift\s*=\s*isShiftActive\s*&&\s*activeOperationCategory\s*===\s*'IRONING'/,
    );
    // Три ветки: !isShiftActive → SeamstressShiftStart, иначе
    // !onWtoShift → WrongOperationCard, иначе → WtoScanTerminal.
    expect(src).toMatch(/!isShiftActive\s*\?\s*\(\s*<SeamstressShiftStart/);
    expect(src).toMatch(/!onWtoShift\s*\?\s*\(\s*<WrongOperationCard/);
    expect(src).toMatch(/<WtoScanTerminal\s*\/>/);
  });

  test('Smoke: acceptOnWtoAction всё ещё ходит через scan-passport — backend остаётся источником истины shift-gate', () => {
    // Frontend-gate помогает UX, но не подменяет backend: даже если
    // SSR увидел активную смену, к моменту POST она могла истечь.
    // `acceptOnWtoAction` обязан звать общий `scanPassport`, чтобы
    // backend проверил `SHIFT_SESSION_REQUIRED` и QC-gate
    // (`PASSPORT_NOT_QC_PASSED`).
    const src = readSrc('apps/web/app/wto/actions.ts');
    expect(src).toMatch(/from '@\/lib\/shifts-api'/);
    expect(src).toMatch(/scanPassport\(lookup\.id\)/);
  });
});
