/**
 * Smoke-тест видимости всех **открытых** коробок (`closedAt = null`)
 * в скан-driven терминале упаковки `/packing` для роли PACKING.
 * Контракт зафиксирован в `docs/packing-open-boxes-recon.md` (RECON
 * 2026-05-08).
 *
 * Проверяемые инварианты (см. recon §5, §7):
 *   1. Backend list-эндпоинт умеет фильтровать по `status: 'OPEN'`
 *      (это уже было, но смоук фиксирует, что мы продолжаем на это
 *      рассчитывать).
 *   2. Server page для PACKING делает `listBoxes({ status: 'OPEN', ... })`
 *      и передаёт `initialOpenBoxes` в `<PackingTerminal>`.
 *   3. `PackingTerminal` пробрасывает `initialOpenBoxes` в
 *      `PackingMainTerminal`, тот хранит их в state `openBoxes`.
 *   4. `actions.ts` экспортирует `listOpenBoxesAction`, который
 *      зовёт `listBoxes({ status: 'OPEN', page: 1, pageSize: 100 })`.
 *   5. Терминал рендерит список открытых коробок через `.map(...)`,
 *      а не `boxes[0]` / `slice(0, 1)` / `at(0)` — фиксируем
 *      отсутствие single-pick паттернов в контексте open-boxes.
 *   6. На пустом stage есть заголовок «Открытые коробки» и кнопка
 *      «Продолжить упаковку» — упаковщик может сделать любую активной.
 *   7. После `create`/`close`/`collapse`/`restore` терминал зовёт
 *      `refreshOpenBoxes()`, чтобы список не отставал.
 *   8. Список не показывается, если открытых коробок нет (`length === 0`).
 *   9. `closeBox` helper по-прежнему ходит на
 *      `POST /packing/boxes/:id/close` (не сломали предыдущий контракт).
 *  10. Поток addPassport (`scanPassportToBoxAction`) не удалён.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('packing terminal — list of all open boxes', () => {
  test('PackingService.list уважает фильтр status=OPEN (closedAt=null)', () => {
    const svc = readSrc('apps/api/src/modules/packing/packing.service.ts');
    expect(svc).toMatch(/if \(query\.status === 'OPEN'\) where\.closedAt = null;/);
    expect(svc).toMatch(
      /if \(query\.status === 'CLOSED'\) where\.closedAt = \{ not: null \};/,
    );
  });

  test('server page передаёт initialOpenBoxes в <PackingTerminal> для роли PACKING', () => {
    const page = readSrc('apps/web/app/packing/page.tsx');
    expect(page).toMatch(/me\.user\.role === 'PACKING'/);
    expect(page).toMatch(
      /listBoxes\(\{\s*status:\s*'OPEN',\s*page:\s*1,\s*pageSize:\s*100,?\s*\}\)/,
    );
    expect(page).toMatch(/initialOpenBoxes\s*=\s*page\.items;?/);
    expect(page).toMatch(/initialOpenBoxes=\{initialOpenBoxes\}/);
  });

  test('listOpenBoxesAction экспортирован и фильтрует open-only', () => {
    const actions = readSrc('apps/web/app/packing/actions.ts');
    expect(actions).toMatch(/export async function listOpenBoxesAction\(/);
    expect(actions).toMatch(
      /listBoxes\(\{\s*status:\s*'OPEN',\s*page:\s*1,\s*pageSize:\s*100,?\s*\}\)/,
    );
    // Returns BoxListItemDto[] wrapped in PackingTerminalResult.
    expect(actions).toMatch(/PackingTerminalResult<BoxListItemDto\[\]>/);
  });

  test('terminal принимает initialOpenBoxes и хранит state openBoxes', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    expect(src).toMatch(/initialOpenBoxes:\s*BoxListItemDto\[\]/);
    expect(src).toMatch(
      /useState<BoxListItemDto\[\]>\(initialOpenBoxes\)/,
    );
    expect(src).toMatch(/listOpenBoxesAction/);
  });

  test('open-list рендерится через .map(...), без single-pick boxes\\[0\\]/at(0)/slice(0, 1)', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    // map-render присутствует.
    expect(src).toMatch(/openBoxes\.map\(\(b\) =>/);
    // Single-pick паттернов не должно быть для open-list.
    expect(src).not.toMatch(/openBoxes\[0\]/);
    expect(src).not.toMatch(/openBoxes\.at\(0\)/);
    expect(src).not.toMatch(/openBoxes\.slice\(0,\s*1\)/);
    // Грубо: нигде не зашиваем pageSize=1 и limit=1 для PACKING-листа.
    expect(src).not.toMatch(/pageSize:\s*1\b/);
    expect(src).not.toMatch(/limit:\s*1\b/);
  });

  test('UI содержит заголовок «Открытые коробки», кнопки «Продолжить упаковку» и ссылки «Карточка»', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    expect(src).toMatch(/Открытые коробки \(\{openBoxes\.length\}\)/);
    expect(src).toMatch(/Продолжить упаковку/);
    expect(src).toMatch(/href=\{`\/packing\/boxes\/\$\{b\.id\}`\}/);
    // Бейдж «Открыта» виден у каждого пункта open-list.
    expect(src).toMatch(/status-badge in_production[\s\S]{0,160}Открыта/);
  });

  test('refreshOpenBoxes вызывается после create/close/collapse/restore/start-new', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    // Хелпер существует и зовёт listOpenBoxesAction.
    expect(src).toMatch(
      /const refreshOpenBoxes = \(\) => \{[\s\S]*?listOpenBoxesAction\(\)/,
    );
    // Создание — успех ветка освежает.
    expect(src).toMatch(
      /createBoxTerminalAction[\s\S]{0,800}refreshOpenBoxes\(\);/,
    );
    // Закрытие — успех ветка освежает.
    expect(src).toMatch(
      /closeBoxTerminalAction[\s\S]{0,800}refreshOpenBoxes\(\);/,
    );
    // Сворачивание (handleLeaveBox) — освежает.
    expect(src).toMatch(
      /const handleLeaveBox =[\s\S]{0,800}refreshOpenBoxes\(\);/,
    );
    // Возврат на пустой stage из closed-success — освежает.
    expect(src).toMatch(
      /const handleStartNewBox =[\s\S]{0,500}refreshOpenBoxes\(\);/,
    );
    // Восстановление свёрнутой — успех ветка освежает.
    expect(src).toMatch(
      /handleRestoreCollapsedBox[\s\S]{0,1500}refreshOpenBoxes\(\);/,
    );
  });

  test('пустой open-list рендерит null (не «висячий» заголовок)', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    expect(src).toMatch(
      /if \(openBoxes\.length === 0\) \{\s*return null;\s*\}/,
    );
  });

  test('closeBox helper по-прежнему POST /packing/boxes/:id/close', () => {
    const src = readSrc('apps/web/lib/packing-api.ts');
    expect(src).toMatch(/export function closeBox\(id: string\)/);
    expect(src).toMatch(
      /`\/packing\/boxes\/\$\{encodeURIComponent\(id\)\}\/close`/,
    );
    expect(src).toMatch(/method: 'POST'/);
  });

  test('addPassport flow и его server action не удалены', () => {
    const actions = readSrc('apps/web/app/packing/actions.ts');
    expect(actions).toMatch(/export async function scanPassportToBoxAction\(/);
    const helper = readSrc('apps/web/lib/packing-api.ts');
    expect(helper).toMatch(/export function addPassportToBox\(/);
    expect(helper).toMatch(
      /`\/packing\/boxes\/\$\{encodeURIComponent\(id\)\}\/add-passport`/,
    );
  });

  test('никакого legacy/raw server-side exception текста не пробрасывается на UI', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    expect(src).not.toMatch(/UnhandledRouteException/);
    expect(src).not.toMatch(/InternalServerErrorException/);
  });
});
