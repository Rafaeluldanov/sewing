/**
 * Smoke-тест нового primary-input-а «Цвет позиции» во вкладке «План»
 * управленческой карточки заказа `/admin/orders/[id]?tab=plan` (этап
 * «Указать в заказе», см. ТЗ §4 + recon «UI gap, не backend gap»).
 *
 * Source-of-truth и ownership-правила (живут в JSDoc
 * `OrderPlanTab` / `MaterialColorForm`):
 *
 *   - `OrderMaterialRequirement.selectedColorText` остаётся
 *     единственным source of truth по «цвету позиции в заказе».
 *   - `WorkshopNeed` намеренно НЕ становится source of truth, он
 *     остаётся derived view + warning.
 *   - Primary-edit для `selectedColorText` живёт в новой вкладке
 *     «План» (`OrderPlanTab` → блок «Цвета по строкам техкарты»).
 *   - В вкладке «Потребности» (`OrderMaterialsUnifiedTable`)
 *     остаётся только warning + CTA-ссылка в План.
 *   - Reusable-форма лежит в
 *     `apps/web/components/orders/materials/material-color-form.tsx`,
 *     legacy `apps/web/app/orders/[id]/material-color-form.tsx`
 *     оставлен только как тонкий re-export wrapper.
 *
 * Этот тест должен **упасть**, если кто-то унесёт primary-edit в
 * Needs / WorkshopNeed / создаст параллельную копию формы.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

// ---------------------------------------------------------------------------
// 1. Reusable MaterialColorForm живёт в components/orders/materials
// ---------------------------------------------------------------------------

describe('MaterialColorForm — reusable форма для цвета строки заказа', () => {
  test('файл существует в новой view-структуре', () => {
    expect(
      exists('apps/web/components/orders/materials/material-color-form.tsx'),
    ).toBe(true);
  });

  const src = read(
    'apps/web/components/orders/materials/material-color-form.tsx',
  );

  test('client component, экспортирует именованный MaterialColorForm', () => {
    expect(src).toMatch(/^'use client';/);
    expect(src).toMatch(/export\s+function\s+MaterialColorForm\b/);
  });

  test('пишет через server-action updateOrderMaterialRequirementColorAction', () => {
    expect(src).toMatch(/updateOrderMaterialRequirementColorAction/);
    expect(src).toMatch(
      /from '@\/app\/orders\/actions'/,
    );
  });

  test('контракт пропов: orderId / requirementId / initialValue', () => {
    expect(src).toMatch(/orderId:\s*string/);
    expect(src).toMatch(/requirementId:\s*string/);
    expect(src).toMatch(/initialValue:\s*string \| null/);
  });

  test('форма поддерживает pending-state и показывает ошибку action-а', () => {
    expect(src).toMatch(/useFormStatus/);
    expect(src).toMatch(/state\.error/);
    expect(src).toMatch(/Сохраняем…/);
  });

  test('у инпута стабильный id `mreq-${requirementId}-color` для anchor-ссылки', () => {
    expect(src).toMatch(/mreq-\$\{requirementId\}-color/);
  });
});

// ---------------------------------------------------------------------------
// 2. Legacy /orders/[id]/material-color-form.tsx — re-export wrapper
// ---------------------------------------------------------------------------

describe('legacy material-color-form.tsx — только re-export', () => {
  const src = read('apps/web/app/orders/[id]/material-color-form.tsx');

  test('реэкспортирует MaterialColorForm из общего компонента', () => {
    expect(src).toMatch(
      /export\s*\{\s*MaterialColorForm\s*\}\s*from\s*'@\/components\/orders\/materials\/material-color-form'/,
    );
  });

  test('не держит свою реализацию формы', () => {
    expect(src).not.toMatch(/export\s+function\s+MaterialColorForm\b/);
    expect(src).not.toMatch(/useFormState\b/);
    expect(src).not.toMatch(/useFormStatus\b/);
    expect(src).not.toMatch(/<form\b/);
  });
});

// ---------------------------------------------------------------------------
// 3. OrderPlanTab имеет блок «Цвета по строкам техкарты»
// ---------------------------------------------------------------------------

describe('OrderPlanTab — primary input для selectedColorText', () => {
  const src = read(
    'apps/web/components/orders/view/tabs/order-plan-tab.tsx',
  );

  test('импортирует reusable MaterialColorForm из components/orders/materials', () => {
    expect(src).toMatch(/import\s*\{\s*MaterialColorForm\s*\}/);
    expect(src).toMatch(
      /from '@\/components\/orders\/materials\/material-color-form'/,
    );
  });

  test('заголовок блока — «Цвета по строкам техкарты»', () => {
    expect(src).toMatch(/Цвета по строкам техкарты/);
  });

  test('фильтрует order.materialRequirements по requiresColorSelection === true', () => {
    expect(src).toMatch(/order\.materialRequirements\.filter/);
    expect(src).toMatch(/requiresColorSelection\s*===\s*true/);
  });

  test('источник правды — requirement.id / selectedColorText (не workshopNeed)', () => {
    expect(src).toMatch(/selectedColorText/);
    // initialValue поднимается из selectedColorText, не из
    // workshopNeed.* — иначе мы бы случайно сделали WorkshopNeed
    // source of truth. JSDoc может упоминать имя как пояснение, но
    // в коде значение/импорт WorkshopNeed-DTO быть не должно.
    expect(src).toMatch(/initialValue=\{m\.selectedColorText/);
    expect(src).not.toMatch(/from '@sewing\/shared\/workshop-needs'/);
    expect(src).not.toMatch(/WorkshopNeedListItemDto/);
    expect(src).not.toMatch(/getOrderWorkshopNeeds\b/);
  });

  test('блок имеет anchor id="order-material-colors"', () => {
    expect(src).toMatch(/id="order-material-colors"/);
  });

  test('строки имеют per-requirement id `mreq-${id}-color` (deep-link)', () => {
    expect(src).toMatch(/id=\{`mreq-\$\{m\.id\}-color`\}/);
  });

  test('Status badge: «Цвет указан» / «Нужно указать цвет»', () => {
    expect(src).toMatch(/Цвет указан/);
    expect(src).toMatch(/Нужно указать цвет/);
  });

  test('empty-state: «Для этой техкарты нет цветов, выбираемых в заказе»', () => {
    expect(src).toMatch(/Для этой техкарты нет цветов, выбираемых в заказе/);
  });

  test('editable-гейт — DRAFT / CALCULATION / CALCULATION_DONE', () => {
    expect(src).toMatch(/'DRAFT'/);
    expect(src).toMatch(/'CALCULATION'/);
    expect(src).toMatch(/'CALCULATION_DONE'/);
  });
});

// ---------------------------------------------------------------------------
// 4. Server-action updateOrderMaterialRequirementColorAction не менялся
// ---------------------------------------------------------------------------

describe('server-action contract preserved', () => {
  const src = read('apps/web/app/orders/actions.ts');

  test('updateOrderMaterialRequirementColorAction экспортируется', () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+updateOrderMaterialRequirementColorAction/,
    );
  });

  test('action ревалидирует и /orders/:id, и /admin/orders/:id', () => {
    expect(src).toMatch(/revalidatePath\(`\/orders\/\$\{orderId\}`\)/);
    expect(src).toMatch(/revalidatePath\(`\/admin\/orders\/\$\{orderId\}`\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. UI-gap, не backend-gap: backend / Prisma / DTO не менялись
// ---------------------------------------------------------------------------

describe('UI-gap fix — backend / Prisma / DTO не менялись', () => {
  test('Prisma schema всё ещё содержит requiresColorSelection / selectedColorText', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).toMatch(/requiresColorSelection/);
    expect(schema).toMatch(/selectedColorText/);
  });

  test('OrderMaterialRequirementDto имеет requiresColorSelection и selectedColorText', () => {
    const dto = read('packages/shared/src/orders.ts');
    expect(dto).toMatch(/requiresColorSelection\?:\s*boolean/);
    expect(dto).toMatch(/selectedColorText\?:\s*string \| null/);
  });

  test('PATCH .../material-requirements/:id/color остался без изменений', () => {
    const ctrl = read(
      'apps/api/src/modules/orders/orders.controller.ts',
    );
    expect(ctrl).toMatch(
      /@Patch\(':id\/material-requirements\/:requirementId\/color'\)/,
    );
  });
});
