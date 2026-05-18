/**
 * Smoke-тест scan-driven терминала ОТК (`/qc`): контракт рабочей
 * карточки и закреплённой снизу панели действий.
 *
 * Полноценного React-рендерера в vitest нет (см.
 * `seamstress-feedback.smoke.test.ts`), поэтому фиксируем контракт
 * текстовыми проверками исходников `QcTerminal` / `QcWorkCard`.
 *
 * История: до 2026-05 после «Проверка выполнена» большая карточка
 * сворачивалась в строку `QcCompletedRow`. По требованию заказчика
 * поведение изменено — карточка остаётся, а закреплённая снизу
 * панель меняет кнопки. `qc-completed-row.tsx` больше не используется.
 *
 * Инварианты (см. docs/screens.md §5, docs/flows.md §F5):
 *   1. `QcTerminal` рендерит `QcWorkCard` для ЛЮБОГО открытого
 *      паспорта (и до, и после complete), `QcCompletedRow` не
 *      используется; scan-карточка — только когда паспорта нет.
 *   2. Обработка `removedFromQc` и поллинг свёрнутого состояния
 *      сохранены (паспорт ушёл дальше → detail сбрасывается).
 *   3. `QcWorkCard`: поле кол-ва брака предзаполнено `qtyCut`;
 *      панель действий `qc-card__sticky-actions`; до complete —
 *      «Добавить брак» (submit формы брака) + «Проверка выполнена»,
 *      после — «Сканировать другой паспорт»; «Обновить карточку» —
 *      мелкая ссылка вне закреплённой панели.
 *   4. Shared-DTO объявляет `removedFromQc`, `QcService` его считает.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('QC terminal: рабочая карточка + закреплённая панель', () => {
  test('QcTerminal рендерит QcWorkCard для любого detail; QcCompletedRow убран', () => {
    const src = readSrc('apps/web/app/qc/qc-terminal.tsx');
    // Свёрнутая строка полностью удалена.
    expect(src).not.toMatch(/qc-completed-row/);
    expect(src).not.toMatch(/QcCompletedRow/);
    // Карточка — для ЛЮБОГО открытого паспорта (без !qcCompletedAt).
    expect(src).toMatch(/\{detail && \(\s*<QcWorkCard/);
    expect(src).not.toMatch(/detail && !detail\.qcCompletedAt && \(\s*<QcWorkCard/);
    // Scan-карточка — только когда паспорта нет.
    expect(src).toMatch(/\{!detail && \(/);
    // Фидбек последнего действия пробрасывается в карточку.
    expect(src).toMatch(/error=\{error\}/);
    expect(src).toMatch(/info=\{info\}/);
  });

  test('QcTerminal сохраняет обработку removedFromQc и поллинг', () => {
    const src = readSrc('apps/web/app/qc/qc-terminal.tsx');
    expect(src).toMatch(/res\.detail\.removedFromQc/);
    expect(src).toMatch(/Паспорт ушёл на следующую операцию/);
    expect(src).toMatch(/if \(res\.detail\.removedFromQc\) \{\s*setDetail\(null\)/);
    expect(src).toMatch(/QC_REMOVED_POLL_INTERVAL_MS/);
    expect(src).toMatch(/if \(!detail \|\| !detail\.qcCompletedAt\) return;/);
  });

  test('QcWorkCard: prefill qtyCut, sticky-панель, swap кнопок, refresh-ссылка', () => {
    const src = readSrc('apps/web/app/qc/qc-work-card.tsx');

    // 1. Поле кол-ва брака предзаполнено количеством кроя из паспорта.
    expect(src).toMatch(/defaultValue=\{detail\.qtyCut\}/);

    // 2. Закреплённая снизу панель действий.
    expect(src).toMatch(/qc-card__sticky-actions/);

    // 3. Кнопка «Добавить брак» сабмитит форму брака через form=.
    expect(src).toMatch(/id=\{DEFECT_FORM_ID\}/);
    expect(src).toMatch(/form=\{DEFECT_FORM_ID\}/);

    // 4. До complete — обе кнопки; после — скан вместо них.
    expect(src).toMatch(/Добавить брак/);
    expect(src).toMatch(/Проверка выполнена/);
    expect(src).toMatch(/Сканировать другой паспорт/);
    expect(src).toMatch(/completed \? \(/);
    expect(src).toMatch(/const showDefectForm = !completed && detail\.canRecordDefect;/);

    // 5. «Обновить карточку» — ссылка вне закреплённой панели:
    //    идёт ПО исходнику раньше, чем sticky-панель.
    expect(src).toMatch(/qc-card__refresh/);
    const refreshIdx = src.indexOf('Обновить карточку');
    const stickyIdx = src.indexOf('qc-card__sticky-actions');
    expect(refreshIdx).toBeGreaterThan(-1);
    expect(stickyIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeLessThan(stickyIdx);
  });

  test('Shared DTO объявляет removedFromQc, QcService его вычисляет', () => {
    const dto = readSrc('packages/shared/src/qc.ts');
    expect(dto).toMatch(/removedFromQc:\s*boolean/);

    const service = readSrc('apps/api/src/modules/qc/qc.service.ts');
    expect(service).toMatch(/removedFromQc/);
    expect(service).toMatch(/PassportEventType\.OPERATION_SCAN/);
    expect(service).toMatch(/PassportStatus\.PACKED/);
    expect(service).toMatch(/PassportStatus\.CANCELLED/);
  });
});
