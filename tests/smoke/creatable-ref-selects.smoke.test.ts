/**
 * Smoke-тесты контура «＋ Добавить…» в select-ах справочников
 * (ref-create): создание справочной записи в модалке без ухода со
 * страницы, с автоматическим появлением и выбором нового элемента.
 *
 * Полноценного React-рендера в проекте нет (vitest + Node, без jsdom),
 * поэтому фиксируем структуру на уровне исходников: sentinel-механика
 * базового компонента, контракт inline-actions (без redirect), каркас
 * AdminModal, выборочные точки встройки и регрессы (GET-фильтры и
 * grouped-equipment-select контуром не тронуты).
 *
 * Эталон паттерна — `apps/web/app/admin/orders/new/inline-product-actions.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('ref-create — базовый CreatableSelect', () => {
  test('sentinel «__create__» перехватывается ДО обновления state и открывает модалку', () => {
    const src = readSrc(
      'apps/web/components/admin/ref-create/creatable-select.tsx',
    );
    expect(src).toMatch(/CREATE_SENTINEL = '__create__'/);
    expect(src).toMatch(/next === CREATE_SENTINEL/);
    expect(src).toMatch(/setModalOpen\(true\)/);
    // Оба режима: controlled (value) и uncontrolled (defaultValue).
    expect(src).toMatch(/const controlled = value !== undefined/);
    expect(src).toMatch(/defaultValue \?\? ''/);
    // Merge создания: дедуп по value + автовыбор + host-хук.
    expect(src).toMatch(/existingValues/);
    expect(src).toMatch(/onValueChange\?\.\(nextValue\)/);
  });

  test('registry: у каждого вида — модалка через next/dynamic (ssr:false) и toOptions', () => {
    const src = readSrc('apps/web/components/admin/ref-create/registry.tsx');
    expect(src).toMatch(/dynamic\(/);
    expect(src).toMatch(/ssr: false/);
    // Роли выбираются по КОДУ, не по id.
    expect(src).toMatch(/value: dto\.code/);
    // Ячейки создаются пачкой — toOptions возвращает массив.
    expect(src).toMatch(/dto\.cells\.map/);
  });

  test('inline-actions: только async-экспорты, safeParse, БЕЗ redirect/revalidate', () => {
    const src = readSrc('apps/web/components/admin/ref-create/actions.ts');
    expect(src).toMatch(/^'use server';/);
    expect(src).toMatch(/safeParse/);
    expect(src).not.toMatch(/redirect\(/);
    expect(src).not.toMatch(/revalidatePath\(/);
    expect(src).not.toMatch(/revalidateTag\(/);
    // Правило 'use server': никаких не-async рантайм-экспортов
    // (см. memory feedback_use_server_only_async_exports).
    expect(src).not.toMatch(/export const /);
    expect(src).not.toMatch(/export function /);
  });

  test('AdminModal: портал, канонические классы и ESC в capture-фазе', () => {
    const src = readSrc('apps/web/components/admin/admin-modal.tsx');
    expect(src).toMatch(/ModalPortal/);
    expect(src).toMatch(/admin-size-plan-modal__backdrop/);
    // Capture + stopPropagation: ESC не должен закрывать родительскую
    // модалку (вложенные сценарии: заявка на оплату, bulk-print).
    expect(src).toMatch(/addEventListener\('keydown', onKey, true\)/);
    expect(src).toMatch(/stopPropagation/);
  });
});

describe('ref-create — точки встройки (выборочно)', () => {
  test('карточка заказа: клиент и подразделение креатабельны', () => {
    const src = readSrc('apps/web/components/orders/order-basics-form.tsx');
    expect(src).toMatch(/entity="client"/);
    expect(src).toMatch(/entity="companyDivision"/);
  });

  test('казначейство: счёт и статья ДДС креатабельны в форме ручной проводки', () => {
    const src = readSrc('apps/web/app/admin/treasury/new-entry-form.tsx');
    expect(src).toMatch(/entity="cashAccount"/);
    expect(src).toMatch(/entity="cashFlowItem"/);
  });

  test('заявка на оплату (вложенная модалка): поставщик с поднятым z-index и merge реквизитов', () => {
    const src = readSrc(
      'apps/web/app/admin/purchase-orders/[id]/payment-request-form-modal.tsx',
    );
    expect(src).toMatch(/entity="supplier"/);
    expect(src).toMatch(/modalZIndex=\{1100\}/);
    expect(src).toMatch(/onSupplierCreated/);
  });

  test('перемещение остатков: ячейки создаются в контексте выбранного склада', () => {
    const src = readSrc(
      'apps/web/components/warehouses/stock/stock-transfer-dialog.tsx',
    );
    expect(src).toMatch(/entity="warehouseCell"/);
    expect(src).toMatch(/lockWarehouse: true/);
  });

  test('оборудование: GroupedOperationSelect в creatable-режиме', () => {
    const create = readSrc('apps/web/app/admin/equipment/create-form.tsx');
    const edit = readSrc('apps/web/app/admin/equipment/[id]/edit-form.tsx');
    for (const src of [create, edit]) {
      expect(src).toMatch(/creatable/);
      expect(src).toMatch(/onCreatedOperation/);
    }
  });

  test('формы заказов: маршрут креатабелен (техкарта удалена — этап 4 «техкарты → номенклатура»)', () => {
    const legacyNew = readSrc('apps/web/app/orders/new/new-order-form.tsx');
    expect(legacyNew).toMatch(/entity="routeTemplate"/);
    expect(legacyNew).not.toMatch(/entity="techCard"/);
    const adminEdit = readSrc(
      'apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx',
    );
    expect(adminEdit).toMatch(/entity="routeTemplate"/);
    expect(adminEdit).not.toMatch(/CreateTechCardWindow/);
  });

  test('payroll: сотрудник креатабелен в документах начисления и выплатах', () => {
    const accrual = readSrc(
      'apps/web/app/admin/payroll/accrual-documents/new/create-form.tsx',
    );
    const payout = readSrc(
      'apps/web/app/admin/payroll/payouts/new/create-form.tsx',
    );
    expect(accrual).toMatch(/entity="employee"/);
    expect(payout).toMatch(/entity="employee"/);
  });
});

describe('ref-create — маршрут: inline-режим формы шаблона', () => {
  test('RouteTemplateForm поддерживает inline + onCreated, action без redirect', () => {
    const form = readSrc('apps/web/app/admin/routes/route-template-form.tsx');
    expect(form).toMatch(/inline/);
    expect(form).toMatch(/onCreated/);
    const actions = readSrc('apps/web/app/admin/routes/actions.ts');
    expect(actions).toMatch(/createRouteTemplateInlineAction/);
    // inline-вариант возвращает DTO, а не редиректит.
    const inlineBody = actions.slice(
      actions.indexOf('createRouteTemplateInlineAction'),
      actions.indexOf('loadRouteFormOperationsAction'),
    );
    expect(inlineBody).not.toMatch(/redirect\(/);
    expect(inlineBody).toMatch(/template: created/);
  });
});

describe('ref-create — тип брака (единственный с backend-работой)', () => {
  test('контроллер: POST /defect-types с методным RBAC (QC + мастер + менеджер)', () => {
    const src = readSrc(
      'apps/api/src/modules/qc/defect-types.controller.ts',
    );
    expect(src).toMatch(/@Post\(\)/);
    expect(src).toMatch(/@Roles\('QC', 'SHOPFLOOR_MASTER', 'SHOP_MANAGER'\)/);
    expect(src).toMatch(/ZodValidationPipe\(CreateDefectTypeSchema\)/);
  });

  test('сервис: авто-code DT-N, sortOrder = max + 10, конфликт кода → DEFECT_TYPE_CODE_TAKEN', () => {
    const src = readSrc('apps/api/src/modules/qc/qc.service.ts');
    expect(src).toMatch(/createDefectType/);
    expect(src).toMatch(/DT-\$\{n\}/);
    expect(src).toMatch(/\+ 10/);
    expect(src).toMatch(/DefectTypeCodeTakenException/);
  });

  test('web action ревалидирует тег defect-types (список кэшируется на 300с)', () => {
    const src = readSrc('apps/web/components/qc/defect-type-actions.ts');
    expect(src).toMatch(/revalidateTag\('defect-types'\)/);
  });

  test('все три цеховые точки используют DefectTypeCreatableSelect', () => {
    for (const p of [
      'apps/web/app/qc/passports/[id]/defect-form.tsx',
      'apps/web/app/qc/qc-work-card.tsx',
      'apps/web/app/master/passport-actions-sheet.tsx',
    ]) {
      expect(readSrc(p)).toMatch(/DefectTypeCreatableSelect/);
    }
  });

  test('docs/api.md фиксирует POST /api/defect-types', () => {
    const src = readSrc('docs/api.md');
    expect(src).toMatch(/POST\s+\| `\/api\/defect-types`/);
  });
});

describe('ref-create — регрессы', () => {
  test('grouped-equipment-select контуром не тронут (нет sentinel)', () => {
    const src = readSrc(
      'apps/web/components/admin/grouped-equipment-select.tsx',
    );
    expect(src).not.toMatch(/CREATE_SENTINEL/);
    expect(src).not.toMatch(/creatable/);
  });

  test('GET-фильтры списков НЕ получили CreatableSelect (создание из фильтра — бессмыслица)', () => {
    for (const p of [
      'apps/web/app/admin/orders/page.tsx',
      'apps/web/app/admin/purchase-orders/page.tsx',
      'apps/web/app/admin/purchase-receipts/page.tsx',
    ]) {
      expect(readSrc(p)).not.toMatch(/CreatableSelect/);
    }
  });

  test('цеховой терминал /work/shift-start не получил «＋ Добавить…»', () => {
    const src = readSrc('apps/web/app/work/shift-start-form.tsx');
    expect(src).not.toMatch(/CreatableSelect/);
    expect(src).not.toMatch(/CREATE_SENTINEL/);
  });
});
