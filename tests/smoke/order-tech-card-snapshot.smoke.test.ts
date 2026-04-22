/**
 * Smoke-тест snapshot техкарты в карточке заказа (`/orders/[id]`),
 * формы создания заказа и admin-навигации (MVP техкарт, ADR-0022).
 *
 * Полноценного React-рендерера в vitest у нас нет (см.
 * `order-route-snapshot.smoke.test.ts`), поэтому идём текстовыми
 * проверками исходников — фиксируем контракт между UI и
 * `OrderDetailDto` (`docs/screens.md §7.3`, `docs/api.md §«tech-cards»`).
 *
 * Покрываем:
 *   1. Карточка заказа рендерит блоки «Материалы» и «Внешние
 *      потребности» из snapshot заказа (`materialRequirements` /
 *      `outsourceRequirements`), а не из live-шаблона.
 *   2. Empty-state строки присутствуют для обоих блоков.
 *   3. Read-only: нет edit-контролов, форм и кнопок в этих блоках.
 *   4. Форма создания заказа `/orders/new` содержит селект «Техкарта».
 *   5. Глобальная admin-навигация содержит ссылку `/admin/tech-cards`.
 *   6. Shared DTO объявляет `materialRequirements` /
 *      `outsourceRequirements` в `OrderDetailDto` и реэкспортирует
 *      DTO потребностей.
 *   7. `@sewing/shared/tech-cards` экспортирует
 *      `TechCardTemplateSummaryDto` и `TechCardTemplateDetailDto`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('order detail page — tech card snapshot blocks', () => {
  test('страница импортирует snapshot DTO и подключает оба блока', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/OrderMaterialRequirementDto/);
    expect(src).toMatch(/OrderOutsourceRequirementDto/);
    expect(src).toMatch(/from '@sewing\/shared\/orders'/);
    expect(src).toMatch(
      /<MaterialsSnapshotCard items=\{order\.materialRequirements\} \/>/,
    );
    expect(src).toMatch(
      /<OutsourceSnapshotCard items=\{order\.outsourceRequirements\} \/>/,
    );
  });

  test('заголовки блоков — «Материалы» и «Внешние потребности»', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/>Материалы</);
    expect(src).toMatch(/Внешние потребности/);
  });

  test('empty-state строки присутствуют для обоих блоков', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/Материалы для заказа не зафиксированы/);
    expect(src).toMatch(/Внешние потребности для заказа не зафиксированы/);
  });

  test('блоки read-only: нет кнопок/форм/handler-ов и не используют live TechCardTemplate', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    for (const fnName of [
      'function MaterialsSnapshotCard',
      'function OutsourceSnapshotCard',
    ]) {
      const idx = src.indexOf(fnName);
      expect(idx, `expected to find ${fnName}`).toBeGreaterThan(0);
      const end = src.indexOf('\n}\n', idx);
      expect(end).toBeGreaterThan(idx);
      const block = src.slice(idx, end);
      expect(block).not.toMatch(/<button/);
      expect(block).not.toMatch(/<input/);
      expect(block).not.toMatch(/<form/);
      expect(block).not.toMatch(/onClick/);
      expect(block).not.toMatch(/onSubmit/);
      expect(block).not.toMatch(/onChange/);
      expect(block).not.toMatch(/draggable/);
      // Источник истины — snapshot заказа, не live шаблон техкарты.
      expect(block).not.toMatch(/TechCardTemplate/);
      expect(block).not.toMatch(/materialLines/);
      expect(block).not.toMatch(/outsourceLines/);
    }
  });
});

describe('order new form — tech card select', () => {
  test('NewOrderForm содержит select techCardId с empty-option', () => {
    const src = readSrc('apps/web/app/orders/new/new-order-form.tsx');
    expect(src).toMatch(/name="techCardId"/);
    expect(src).toMatch(/Техкарта/);
    expect(src).toMatch(/без техкарты/);
  });

  test('Edit form тоже содержит select techCardId', () => {
    const src = readSrc('apps/web/app/orders/[id]/edit/edit-order-form.tsx');
    expect(src).toMatch(/name="techCardId"/);
  });
});

describe('admin nav — tech cards link', () => {
  test('layout содержит ссылку /admin/tech-cards', () => {
    const src = readSrc('apps/web/app/layout.tsx');
    expect(src).toMatch(/href="\/admin\/tech-cards"/);
    expect(src).toMatch(/Техкарты/);
  });
});

describe('shared DTO contracts', () => {
  test('OrderDetailDto содержит techCardId, materialRequirements, outsourceRequirements', () => {
    const dto = readSrc('packages/shared/src/orders.ts');
    expect(dto).toMatch(/techCardId:\s*string \| null/);
    expect(dto).toMatch(/materialRequirements:\s*OrderMaterialRequirementDto\[\]/);
    expect(dto).toMatch(
      /outsourceRequirements:\s*OrderOutsourceRequirementDto\[\]/,
    );
  });

  test('@sewing/shared/tech-cards экспортирует Summary/Detail DTO', () => {
    const dto = readSrc('packages/shared/src/tech-cards.ts');
    expect(dto).toMatch(/export interface TechCardTemplateSummaryDto/);
    expect(dto).toMatch(/export interface TechCardTemplateDetailDto/);
    expect(dto).toMatch(/export const CreateTechCardSchema/);
    expect(dto).toMatch(/export const UpdateTechCardSchema/);
  });

  test('packages/shared/package.json экспортирует ./tech-cards', () => {
    const pkg = JSON.parse(readSrc('packages/shared/package.json'));
    expect(pkg.exports['./tech-cards']).toBeDefined();
  });
});
