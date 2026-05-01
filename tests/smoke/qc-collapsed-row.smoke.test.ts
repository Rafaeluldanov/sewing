/**
 * Smoke-тест scan-driven терминала ОТК (`/qc`) после нажатия
 * «Проверка выполнена».
 *
 * Полноценного React-рендерера у нас в vitest нет (см.
 * `seamstress-feedback.smoke.test.ts`), поэтому идём тем же путём:
 * текстовые проверки исходников фиксируют контракт между
 * `QcTerminal`, `QcWorkCard` и новым `QcCompletedRow`.
 *
 * Покрываем три инварианта (см. `docs/screens.md §5.1`,
 * `docs/flows.md §F5`):
 *   1. После complete (`qcCompletedAt != null`) рендерится свернутая
 *      строка `QcCompletedRow`, а не большая `QcWorkCard`.
 *   2. Свернутая строка содержит минимально достаточный набор:
 *      номер паспорта, размер, количество (`qtyGood`) и бейдж
 *      «Проверено ОТК». Никаких «брак»/«проверка выполнена» там нет.
 *   3. Когда backend отдаёт `removedFromQc=true`, терминал убирает
 *      detail из state — то есть свернутая строка исчезает.
 *
 * Также проверяем, что `removedFromQc` объявлен в shared-DTO и
 * обрабатывается в `QcService` (источник истины).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('QC terminal post-complete UX (collapsed row)', () => {
  test('QcTerminal рендерит QcWorkCard ТОЛЬКО до complete, и QcCompletedRow ПОСЛЕ', () => {
    const src = readSrc('apps/web/app/qc/qc-terminal.tsx');
    expect(src).toMatch(/from '\.\/qc-completed-row'/);
    // Большая карточка — только пока ОТК ещё не подтвердил.
    expect(src).toMatch(
      /\{detail && !detail\.qcCompletedAt && \(\s*<QcWorkCard/,
    );
    // Свернутая строка — после подтверждения.
    expect(src).toMatch(
      /\{detail && detail\.qcCompletedAt && <QcCompletedRow detail=\{detail\} \/>\}/,
    );
  });

  test('QcTerminal убирает detail, когда backend отдаёт removedFromQc=true', () => {
    const src = readSrc('apps/web/app/qc/qc-terminal.tsx');
    // Защита в lookup: переоткрыть тот же ушедший паспорт — нельзя.
    expect(src).toMatch(/res\.detail\.removedFromQc/);
    expect(src).toMatch(/Паспорт ушёл на следующую операцию/);
    // Refresh-ветка: если паспорт ушёл дальше — сбрасываем detail.
    expect(src).toMatch(/if \(res\.detail\.removedFromQc\) \{\s*setDetail\(null\)/);
    // Поллинг для свернутой строки: только пока есть `qcCompletedAt`.
    expect(src).toMatch(/QC_REMOVED_POLL_INTERVAL_MS/);
    expect(src).toMatch(/if \(!detail \|\| !detail\.qcCompletedAt\) return;/);
  });

  test('QcCompletedRow содержит номер/размер/количество/бейдж и не содержит кнопок действий', () => {
    const src = readSrc('apps/web/app/qc/qc-completed-row.tsx');
    expect(src).toMatch(/detail\.passportNumber/);
    expect(src).toMatch(/detail\.sizeCode/);
    expect(src).toMatch(/detail\.qtyGood/);
    expect(src).toMatch(/Проверено ОТК/);
    // Никаких action-кнопок «брак»/«проверка выполнена» в
    // свернутой строке быть не должно — это чистый view.
    expect(src).not.toMatch(/<button/);
    expect(src).not.toMatch(/onClick/);
    expect(src).not.toMatch(/onSubmit/);
  });

  test('Shared DTO объявляет removedFromQc, QcService его вычисляет', () => {
    const dto = readSrc('packages/shared/src/qc.ts');
    expect(dto).toMatch(/removedFromQc:\s*boolean/);

    const service = readSrc('apps/api/src/modules/qc/qc.service.ts');
    expect(service).toMatch(/removedFromQc/);
    // Источник истины — события: либо терминальный статус, либо
    // OPERATION_SCAN после qcCompletedAt.
    expect(service).toMatch(/PassportEventType\.OPERATION_SCAN/);
    expect(service).toMatch(/PassportStatus\.PACKED/);
    expect(service).toMatch(/PassportStatus\.CANCELLED/);
  });
});
