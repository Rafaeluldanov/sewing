/**
 * Smoke-тест: scan-driven терминал ОТК (`/qc`) показывает start-shift
 * UI, а не «голую» кнопку «Сканировать паспорт», когда у сотрудника
 * нет активной смены.
 *
 * Полноценного React-рендерера у нас в vitest нет (см.
 * `seamstress-feedback.smoke.test.ts`), поэтому идём текстовыми
 * проверками исходников — фиксируем контракт между `QcPage` и
 * `QcTerminal`, чтобы регрессия «у ОТК пропала кнопка Начать смену»
 * больше не повторилась.
 *
 * Покрываем три инварианта (см. `docs/screens.md §5.1`,
 * `docs/flows.md §F5`):
 *   1. Страница `/qc` подтягивает `getShiftMeta` + `getCurrentShift`
 *      и прокидывает их в `QcTerminal` (как `/packing/page.tsx`).
 *   2. `QcTerminal` использует тот же reuse-компонент
 *      `SeamstressShiftStart`, что и швея/упаковщик, когда смены нет
 *      — никакого собственного start-shift UI у `/qc` нет.
 *   3. `QcTerminal` выбирает scan-flow только при активной смене на
 *      операции категории `QC` — иначе показывает start-shift форму
 *      или банер «Смена не на ОТК».
 *
 * Также фиксируем, что меню действий (`SeamstressActionsMenu`) —
 * единая точка logout/«Завершить смену» на `/qc` — не дублируется
 * прежней inline-формой `qc-logout`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('QC start-shift gating (/qc)', () => {
  test('QcPage подтягивает shift meta + current и передаёт их в QcTerminal', () => {
    const src = readSrc('apps/web/app/qc/page.tsx');
    expect(src).toMatch(/from '@\/lib\/shifts-api'/);
    expect(src).toMatch(/getShiftMeta\(\)/);
    expect(src).toMatch(/getCurrentShift\(\)/);
    // initialShift / activeOperationCategory передаются именно как
    // отдельные пропсы — иначе `QcTerminal` не сможет принять решение
    // на клиенте без лишнего round-trip.
    expect(src).toMatch(/initialShift=\{currentShift\}/);
    expect(src).toMatch(/activeOperationCategory=\{activeOperationCategory\}/);
    // fail-soft на ApiRequestError: сбой /shifts/current не должен
    // ломать весь экран — терминал просто покажет start-shift форму.
    expect(src).toMatch(/ApiRequestError/);
  });

  test('QcTerminal реюзает SeamstressShiftStart, не создаёт собственный start-shift UI', () => {
    const src = readSrc('apps/web/app/qc/qc-terminal.tsx');
    expect(src).toMatch(
      /from '@\/app\/work\/seamstress-shift-start'/,
    );
    expect(src).toMatch(/<SeamstressShiftStart\s+meta=\{meta\}\s+employee=\{employee\}/);
    // SeamstressActionsMenu — единая точка «Завершить смену» / «Выйти»,
    // как у швеи и упаковщика. Прежняя inline-форма qc-logout должна
    // быть убрана, иначе на экране две точки выхода.
    expect(src).toMatch(/from '@\/app\/work\/seamstress-actions-menu'/);
    expect(src).toMatch(/<SeamstressActionsMenu\s+shiftActive=\{isShiftActive\}/);
    expect(src).not.toMatch(/qc-logout/);
  });

  test('QcTerminal выбирает scan-flow только при активной QC-смене', () => {
    const src = readSrc('apps/web/app/qc/qc-terminal.tsx');
    // Категория сравнивается явно с 'QC'.
    expect(src).toMatch(
      /onQcShift\s*=\s*isShiftActive\s*&&\s*activeOperationCategory\s*===\s*'QC'/,
    );
    // Три ветки: !isShiftActive → SeamstressShiftStart, иначе
    // !onQcShift → WrongOperationCard, иначе → QcScanTerminal.
    expect(src).toMatch(/!isShiftActive\s*\?\s*\(\s*<SeamstressShiftStart/);
    expect(src).toMatch(/!onQcShift\s*\?\s*\(\s*<WrongOperationCard/);
    expect(src).toMatch(/<QcScanTerminal\s+defectTypes=\{defectTypes\}/);
  });

  test('Smoke: lookupQcPassportAction всё ещё ходит через scan-passport — backend остаётся источником истины shift-gate', () => {
    // Frontend-gate помогает UX, но не подменяет backend: даже если
    // SSR увидел активную смену, к моменту POST она могла истечь.
    // `lookupQcPassportAction` обязан звать общий `scanPassport`,
    // чтобы backend проверил `SHIFT_SESSION_REQUIRED`.
    const src = readSrc('apps/web/app/qc/actions.ts');
    expect(src).toMatch(/from '@\/lib\/shifts-api'/);
    expect(src).toMatch(/scanPassport\(lookup\.id\)/);
  });
});
