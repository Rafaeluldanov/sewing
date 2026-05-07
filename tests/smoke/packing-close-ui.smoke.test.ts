/**
 * Smoke-тест UX scan-driven терминала упаковки (`/packing`) после
 * закрытия / сворачивания коробки. Контракт зафиксирован в
 * `docs/packing-close-ui-recon.md` (RECON 2026-05-07).
 *
 * Полноценного React-рендерера в vitest у нас нет — идём тем же путём,
 * что `qc-collapsed-row.smoke.test.ts`: текстовые ассерты на исходники.
 *
 * Проверяемые инварианты (см. recon §6, §7):
 *   1. UI содержит action «Закрыть коробку (N шт.)» и зовёт
 *      `closeBoxTerminalAction`.
 *   2. После успешного close терминал НЕ обнуляет `setBox(null)` —
 *      сохраняет CLOSED-DTO в state и рендерит закрытую карточку
 *      с бейджем «Закрыта», info-сообщением «Коробка X закрыта…»
 *      и кнопкой «Создать новую коробку», плюс ссылка на
 *      `/packing/boxes/:id` (управленческая карточка).
 *   3. Кнопка «Свернуть карточку» (client-only) запоминает id
 *      свёрнутой коробки в `collapsedBoxId` и НЕ удаляет его из
 *      `localStorage`. На пустом stage появляется баннер
 *      «Коробка ... свёрнута» с кнопкой «Вернуться к коробке».
 *   4. Helper `closeBox` в `lib/packing-api.ts` ходит на
 *      `POST /packing/boxes/:id/close`.
 *   5. `BOX_STATUS_LABELS` действительно содержит «Закрыта».
 *   6. Управленческая карточка `/packing/boxes/[id]` после close
 *      по-прежнему показывает баннер «Коробка закрыта…» и status-бейдж
 *      `done` — мы там UX не ломаем.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('packing terminal post-close UX', () => {
  test('terminal содержит action закрытия и зовёт closeBoxTerminalAction', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    expect(src).toMatch(/Закрыть коробку \(\$\{box\.totalQty\} шт\.\)/);
    expect(src).toMatch(/closeBoxTerminalAction\(boxId\)/);
    expect(src).toMatch(/onClick=\{handleClose\}/);
  });

  test('после успешного close: setBox(res.data) (НЕ null), info-сообщение, обнуление collapsed', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    // Сохраняем CLOSED-DTO в state — карточка не должна «исчезнуть».
    expect(src).toMatch(
      /setInfo\(\s*`Коробка \$\{res\.data\.number\} закрыта\. Начислено всем участникам\.`,?\s*\);\s*[\s\S]*?setBox\(res\.data\);/,
    );
    // Старого `setBox(null)` в этой ветке быть не должно.
    expect(src).not.toMatch(
      /closeBoxTerminalAction[\s\S]{0,400}?setBox\(null\)/,
    );
  });

  test('CLOSED-карточка: бейдж «Закрыта», link на /packing/boxes/:id, кнопка «Создать новую коробку»', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    expect(src).toMatch(/if \(box\.status === 'CLOSED'\) \{/);
    // Status-бейдж — переиспользуем уже существующий стиль `done`.
    expect(src).toMatch(/<span className="status-badge done">Закрыта<\/span>/);
    // Primary CTA — начать новую коробку.
    expect(src).toMatch(/Создать новую коробку/);
    expect(src).toMatch(/onClick=\{handleStartNewBox\}/);
    // Ссылка на детальную карточку (в т.ч. этикетка).
    expect(src).toMatch(/href=\{`\/packing\/boxes\/\$\{box\.id\}`\}/);
    expect(src).toMatch(/Открыть карточку коробки/);
  });

  test('«Свернуть карточку» запоминает id и не закрывает коробку в БД', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    // handleLeaveBox — клиентский, никаких *closeBox*-вызовов.
    expect(src).toMatch(/const handleLeaveBox = \(\) => \{/);
    expect(src).toMatch(/setCollapsedBoxId\(box\.id\);/);
    expect(src).toMatch(/setCollapsedBoxNumber\(box\.number\);/);
    // Никаких сетевых вызовов внутри handleLeaveBox.
    const start = src.indexOf('const handleLeaveBox =');
    const end = src.indexOf('const handleRestoreCollapsedBox =');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).not.toMatch(/closeBox|closeBoxTerminalAction/);
    // Info-сообщение объясняет, что коробка ещё открыта.
    expect(body).toMatch(/Карточка коробки .* свёрнута\. Коробка ещё открыта/);
  });

  test('localStorage сохраняет id и для OPEN-коробки, и для свёрнутой', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    // Эффект помнит и активную, и свёрнутую коробку.
    expect(src).toMatch(
      /const remembered =\s*box && box\.status === 'OPEN' \? box\.id : collapsedBoxId;/,
    );
    expect(src).toMatch(/\}, \[box, collapsedBoxId\]\);/);
    expect(src).toMatch(/ACTIVE_BOX_STORAGE_KEY/);
  });

  test('баннер свёрнутой коробки на пустом stage с кнопкой «Вернуться к коробке»', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    expect(src).toMatch(/\{collapsedBoxId && \(/);
    expect(src).toMatch(/Вернуться к коробке/);
    expect(src).toMatch(/onClick=\{handleRestoreCollapsedBox\}/);
    // Если backend сообщил CLOSED — переключаемся в success state, а не молчим.
    expect(src).toMatch(/if \(res\.data\.status === 'CLOSED'\) \{[\s\S]*?setBox\(res\.data\)/);
  });

  test('packing-api helper closeBox идёт в POST /packing/boxes/:id/close', () => {
    const src = readSrc('apps/web/lib/packing-api.ts');
    expect(src).toMatch(/export function closeBox\(id: string\)/);
    expect(src).toMatch(
      /`\/packing\/boxes\/\$\{encodeURIComponent\(id\)\}\/close`/,
    );
    expect(src).toMatch(/method: 'POST'/);
  });

  test('BOX_STATUS_LABELS содержит «Закрыта»', () => {
    const src = readSrc('apps/web/lib/packing-api.ts');
    expect(src).toMatch(/CLOSED:\s*'Закрыта'/);
    expect(src).toMatch(/OPEN:\s*'Открыта'/);
  });

  test('управленческая карточка /packing/boxes/[id] после close показывает закрытое состояние', () => {
    // UX там был корректный и до фикса — закрепляем, чтобы не сломать
    // в дальнейшем.
    const page = readSrc('apps/web/app/packing/boxes/[id]/page.tsx');
    expect(page).toMatch(/Коробка закрыта — изменения недоступны\./);
    expect(page).toMatch(/box\.status === 'CLOSED' \? 'done'/);
    const action = readSrc('apps/web/app/packing/actions.ts');
    expect(action).toMatch(/Коробка закрыта, начисления подтверждены/);
    expect(action).toMatch(/revalidatePath\('\/earnings'\)/);
  });
});
