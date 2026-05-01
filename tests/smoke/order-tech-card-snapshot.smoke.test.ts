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
    // Этап «Указать в заказе» (см. ТЗ §4): к MaterialsSnapshotCard
    // добавились пропы `orderId` и `canManage` под inline-форму
    // сохранения цвета (`MaterialColorForm`). Регэксп допускает
    // любой порядок и переносы между атрибутами.
    expect(src).toMatch(/<MaterialsSnapshotCard\b/);
    expect(src).toMatch(
      /<MaterialsSnapshotCard[\s\S]*?items=\{order\.materialRequirements\}/,
    );
    // MVP-3 (ADR-0022 §«Manual execution status»): к компоненту
    // добавились два пропа `orderId` и `canManage` под action-кнопки
    // «Отметить как заказано / получено». Items по-прежнему — snapshot
    // потребностей. Регэксп специально допускает любой порядок и
    // переносы строк между атрибутами.
    expect(src).toMatch(/<OutsourceSnapshotCard\b/);
    expect(src).toMatch(
      /<OutsourceSnapshotCard[\s\S]*?items=\{order\.outsourceRequirements\}/,
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

  test('блоки read-only: нет inline-кнопок/форм/handler-ов и не используют live TechCardTemplate', () => {
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
      // В самих card-компонентах inline-edit запрещён; формы вынесены в
      // отдельные клиентские компоненты (`MaterialColorForm`,
      // `OutsourceStatusActions`). HTML-теги <button/<input/<form
      // здесь не должны встречаться, но имена React-компонентов с
      // PascalCase допустимы (например, `<MaterialColorForm ... />`,
      // `<OutsourceStatusActions ... />`).
      expect(block).not.toMatch(/<button\b/);
      expect(block).not.toMatch(/<input\b/);
      expect(block).not.toMatch(/<form\b/);
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

// ---------------------------------------------------------------------------
// Этап «Указать в заказе» (см. ТЗ §4): UI карточки заказа /orders/[id]
// показывает inline-форму сохранения цвета для строк с
// requiresColorSelection.
// ---------------------------------------------------------------------------

describe('order detail page — «Указать в заказе»', () => {
  test('страница импортирует MaterialColorForm и getTechCardMaterialRoleLabel', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/import \{ MaterialColorForm \}/);
    expect(src).toMatch(/getTechCardMaterialRoleLabel/);
  });

  test('MaterialsSnapshotCard рендерит MaterialColorForm для requiresColorSelection', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/requiresColorSelection/);
    expect(src).toMatch(/<MaterialColorForm/);
  });

  test('legacy material-color-form.tsx — только re-export reusable компонента (нет дублирующей формы)', () => {
    // Реальный код формы лежит в
    // apps/web/components/orders/materials/material-color-form.tsx
    // (его использует и новая вкладка «План»). Legacy-файл — тонкий
    // wrapper, чтобы существующий route-level импорт продолжал
    // работать.
    const wrapper = readSrc(
      'apps/web/app/orders/[id]/material-color-form.tsx',
    );
    expect(wrapper).toMatch(
      /export\s*\{\s*MaterialColorForm\s*\}\s*from\s*'@\/components\/orders\/materials\/material-color-form'/,
    );
    expect(wrapper).not.toMatch(/export\s+function\s+MaterialColorForm\b/);
    expect(wrapper).not.toMatch(/<form\b/);
    expect(wrapper).not.toMatch(/useFormState\b/);
  });

  test('reusable форма показывает подсказку «Цвет нужно указать в заказе» (legacy-вёрстка не сломана)', () => {
    const reusable = readSrc(
      'apps/web/components/orders/materials/material-color-form.tsx',
    );
    expect(reusable).toMatch(/Цвет нужно указать в заказе/);
  });

  test('action updateOrderMaterialRequirementColorAction экспортируется', () => {
    const src = readSrc('apps/web/app/orders/actions.ts');
    expect(src).toMatch(/updateOrderMaterialRequirementColorAction/);
  });

  test('library обёртка updateOrderMaterialRequirementColor экспортируется', () => {
    const src = readSrc('apps/web/lib/orders-api.ts');
    expect(src).toMatch(/updateOrderMaterialRequirementColor/);
    expect(src).toMatch(
      /\/material-requirements\/\$\{encodeURIComponent\(/,
    );
  });

  test('backend controller имеет PATCH .../material-requirements/:requirementId/color', () => {
    const src = readSrc(
      'apps/api/src/modules/orders/orders.controller.ts',
    );
    expect(src).toMatch(
      /@Patch\(':id\/material-requirements\/:requirementId\/color'\)/,
    );
    expect(src).toMatch(/UpdateOrderMaterialRequirementColorSchema/);
  });
});

// ---------------------------------------------------------------------------
// Этап «Указать в заказе» (см. ТЗ §2): snapshot материалов теперь
// создаётся уже в `OrdersService.create()`/`update()`/`startCalculation()`,
// чтобы поле «Цвет» было доступно до запуска производства.
// ---------------------------------------------------------------------------

describe('orders.service — early material snapshot', () => {
  test('OrdersService содержит helper rebuildMaterialRequirementsSnapshot', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/private async rebuildMaterialRequirementsSnapshot/);
  });

  test('create()/update()/startCalculation() вызывают rebuildMaterialRequirementsSnapshot', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    // Должно быть ≥3 вызовов helper-а: create / update / startCalculation.
    const matches = src.match(/this\.rebuildMaterialRequirementsSnapshot/g);
    expect((matches?.length ?? 0) >= 3).toBe(true);
  });

  test('helper выставляет requiresColorSelection по colorRule = ORDER_SELECTED_COLOR', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(
      /isOrderSelected\s*=\s*l\.colorRule\s*===\s*'ORDER_SELECTED_COLOR'/,
    );
    expect(src).toMatch(/requiresColorSelection:\s*isOrderSelected/);
  });

  test('helper preserve-ит selectedColorText между snapshot-ами', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/prevBySourceId\.set\(/);
    expect(src).toMatch(/composeMaterialMatchKey\(/);
  });
});

describe('order detail UI — color form gate by status', () => {
  test('MaterialsSnapshotCard принимает orderStatus и гейтит редактирование', () => {
    const src = readSrc('apps/web/app/orders/[id]/page.tsx');
    expect(src).toMatch(/orderStatus:\s*OrderDetailDto\['status'\]/);
    expect(src).toMatch(/isColorEditable/);
    // Edit-режим только до запуска производства (см. ТЗ §7).
    expect(src).toMatch(/'CALCULATION_DONE'/);
    expect(src).toMatch(/'CALCULATION'/);
    expect(src).toMatch(/'DRAFT'/);
  });
});
