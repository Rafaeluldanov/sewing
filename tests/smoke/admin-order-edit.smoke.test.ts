/**
 * Smoke-тесты для редактирования заказа в Admin UI 2.7
 * (`/admin/orders/[id]/edit`).
 *
 * Полноценного React-рендерера в vitest у нас нет — фиксируем
 * контракт UI ↔ backend ↔ shared текстовыми проверками исходников.
 * Покрытие:
 *
 *   1. Страница `/admin/orders/[id]/edit/page.tsx` существует и
 *      подключена к admin-shell, с кнопкой «К карточке заказа».
 *   2. Форма `admin-edit-order-form.tsx` использует AdminCard /
 *      AdminDateField / AdminSizeGrid / AdminRouteSteps и содержит
 *      «Статус заказа» + все ключевые FormData-поля.
 *   3. Server action `updateAdminOrderAction` существует, читает
 *      все ожидаемые поля и редиректит на `/admin/orders/[id]`.
 *   4. Карточка заказа `/admin/orders/[id]` содержит ссылку
 *      «Редактировать» на `/admin/orders/${order.id}/edit`.
 *   5. Старая страница `/orders/[id]/edit` НЕ удалена — на неё
 *      полагается легаси-flow.
 *   6. `apps/web/lib/orders-api.ts` экспортирует `updateOrder`.
 *   7. `UpdateOrderSchema` в shared содержит status / clientId /
 *      dueDate, а `OrdersController` вешает `@Patch(':id')`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}
function existsRel(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

describe('admin/orders/[id]/edit — страница и форма редактирования', () => {
  const pagePath = 'apps/web/app/admin/orders/[id]/edit/page.tsx';
  const formPath =
    'apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx';
  const actionsPath = 'apps/web/app/admin/orders/[id]/edit/actions.ts';

  test('страница существует и подключена к admin-shell', () => {
    expect(existsRel(pagePath)).toBe(true);
    const src = readSrc(pagePath);
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/AdminCard/);
    expect(src).toMatch(/from 'lucide-react'/);
    // Order-workspace unification: section title — обобщённое
    // «Заказы» (одинаково на /admin/orders/new и /admin/orders/[id]);
    // конкретный лейбл «Редактирование заказа» лежит в subtitle.
    // Полный заголовок («Заказ N — редактирование») и back-link
    // «К карточке» теперь рендерятся в `OrderHeroCard` внутри формы.
    expect(src).toMatch(/title="Заказы"/);
    expect(src).toMatch(/Редактирование заказа/);
    // RBAC: страницу видят только ADMIN/SHOP_MANAGER, иначе редирект
    // на карточку заказа.
    expect(src).toMatch(/role !== 'ADMIN'/);
    expect(src).toMatch(/role !== 'SHOP_MANAGER'/);
  });

  test('OrderHeroCard в edit-форме показывает «Заказ N — редактирование» и back-link «К карточке»', () => {
    const src = readSrc(formPath);
    expect(src).toMatch(/OrderHeroCard/);
    expect(src).toMatch(/OrderDetailTabs/);
    expect(src).toMatch(/OrderWorkspaceLayout/);
    expect(src).toMatch(/mode="edit"/);
    // Back-link на карточку заказа перенесён в hero actions.
    expect(src).toMatch(/К карточке/);
    expect(src).toMatch(/Заказ \$\{order\.number\} — редактирование/);
  });

  test('форма использует ключевые admin-компоненты и содержит статус', () => {
    expect(existsRel(formPath)).toBe(true);
    const src = readSrc(formPath);

    expect(src).toMatch(/AdminCard/);
    expect(src).toMatch(/AdminDateField/);
    expect(src).toMatch(/AdminSizeGrid/);
    expect(src).toMatch(/AdminRouteSteps/);

    // Поле статуса теперь в hero «Основное» — лейбл «Статус» (без
    // «заказа»), потому что hero уже сам про заказ.
    expect(src).toMatch(/>Статус</);
    expect(src).toMatch(/name="status"/);
    expect(src).toMatch(/admin-form\b/);
    expect(src).toMatch(/admin-order-form\b/);
    expect(src).toMatch(/admin-form-grid/);
    expect(src).toMatch(/admin-field/);
    expect(src).toMatch(/admin-order-form__actions/);
    expect(src).toMatch(/admin-btn--primary/);
    expect(src).toMatch(/admin-btn--ghost/);

    expect(src).toMatch(/formatOrderStatus/);
    expect(src).toMatch(/from '@\/lib\/admin-labels'/);

    expect(src).not.toMatch(/<Icon\s+name=/);
    expect(src).not.toMatch(/DetailPageHeader/);
  });

  test('форма содержит ключевые FormData-поля и сетку размеров', () => {
    const src = readSrc(formPath);
    expect(src).toMatch(/name="status"/);
    expect(src).toMatch(/name="orderDate"/);
    expect(src).toMatch(/name="dueDate"/);
    expect(src).toMatch(/name="clientId"/);
    // Этап «Номенклатура = Лекала»: вместо `productId` — `patternItemId`.
    expect(src).toMatch(/name="patternItemId"/);
    expect(src).not.toMatch(/name="productId"/);
    // PHASE 1 «CompanyDivision как master-справочник»: новый
    // приоритетный select. Legacy `name="division"` остался как
    // hidden-input для backend-fallback.
    expect(src).toMatch(/name="companyDivisionId"/);
    expect(src).toMatch(/name="division"/);
    expect(src).toMatch(/name="color"/);
    expect(src).toMatch(/name="comment"/);
    expect(src).toMatch(/name="techCardId"/);
    expect(src).toMatch(/name="routeTemplateId"/);
    // План по размерам собирает `qty[<sizeId>]` через AdminSizeGrid;
    // здесь достаточно убедиться, что сам грид подключён в форму
    // (контракт ключа `qty[…]` живёт в `actions.ts`, см. ниже).
    expect(src).toMatch(/AdminSizeGrid/);
  });

  test('форма содержит карточки «Изделие / Производство / План» в Product tab', () => {
    const src = readSrc(formPath);
    // Order workspace v2: «Заказ» и «Сроки» переехали в hero
    // (управленческие поля). В Product tab остались карточки про
    // продукт/производство/размеры.
    expect(src).not.toMatch(/admin-order-card--order/);
    expect(src).not.toMatch(/admin-order-card--dates/);
    expect(src).toMatch(/admin-order-card--product/);
    expect(src).toMatch(/admin-order-card--production/);
    expect(src).toMatch(/admin-order-card--sizes/);
    expect(src).toMatch(/Изделие/);
    expect(src).toMatch(/Производство/);
    expect(src).toMatch(/План по размерам/);
    expect(src).toMatch(/>Номенклатура \/ лекало</);
  });

  test('updateAdminOrderAction читает все ожидаемые поля и редиректит', () => {
    expect(existsRel(actionsPath)).toBe(true);
    const src = readSrc(actionsPath);
    expect(src).toMatch(/'use server'/);
    expect(src).toMatch(/export async function updateAdminOrderAction/);
    expect(src).toMatch(/UpdateOrderSchema/);
    expect(src).toMatch(/updateOrder\(/);

    // Ключи, которые action обязан прочитать из FormData.
    // Этап «Номенклатура = Лекала»: вместо `productId` — `patternItemId`;
    // backend сам подставит legacy Product в OrderItem.productId.
    for (const key of [
      'orderDate',
      'patternItemId',
      'color',
      'comment',
      'routeTemplateId',
      'techCardId',
      'clientId',
      'dueDate',
      'division',
      // PHASE 1 «CompanyDivision как master-справочник»: action
      // обязан читать новый ключ FormData.
      'companyDivisionId',
      'status',
    ]) {
      expect(src).toMatch(new RegExp(`['"]${key}['"]`));
    }

    // qty[<sizeId>] контракт: regex `^qty\[(.+)]$` — смотрим именно
    // на «\[», что и означает экранирование квадратной скобки.
    expect(src).toMatch(/qty\\\[/);
    // После успеха action редиректит в карточку и инвалидирует кэш.
    expect(src).toMatch(/redirect\(`\/admin\/orders\/\$\{orderId\}`\)/);
    expect(src).toMatch(/revalidatePath\(`\/admin\/orders\/\$\{orderId\}`\)/);
  });
});

describe('admin/orders/[id] — карточка заказа содержит «Редактировать»', () => {
  test('management header содержит ссылку /admin/orders/${order.id}/edit и «К списку»', () => {
    // Order management redesign: ссылки управления переехали из
    // /admin/orders/[id]/page.tsx в `OrderManagementHeader`.
    const headerSrc = readSrc(
      'apps/web/components/orders/view/order-management-header.tsx',
    );
    expect(headerSrc).toMatch(/Редактировать/);
    expect(headerSrc).toMatch(/\/admin\/orders\/\$\{order\.id\}\/edit/);
    expect(headerSrc).toMatch(/К списку/);
    // Кнопка-ссылка «Старая карточка» намеренно убрана —
    // управленческая карточка одна.
    const pageSrc = readSrc('apps/web/app/admin/orders/[id]/page.tsx');
    expect(pageSrc).not.toMatch(/Старая карточка/);
  });
});

describe('legacy /orders/[id]/edit — НЕ удалён', () => {
  test('страница и форма легаси-редактирования на месте', () => {
    expect(existsRel('apps/web/app/orders/[id]/edit/page.tsx')).toBe(true);
    expect(existsRel('apps/web/app/orders/[id]/edit/edit-order-form.tsx')).toBe(
      true,
    );
  });
});

describe('orders-api / shared / controller — контракт PATCH /orders/:id', () => {
  test('orders-api.ts экспортирует updateOrder', () => {
    const src = readSrc('apps/web/lib/orders-api.ts');
    expect(src).toMatch(/export function updateOrder/);
    expect(src).toMatch(/method:\s*'PATCH'/);
  });

  test('UpdateOrderSchema в shared содержит status / clientId / dueDate', () => {
    const src = readSrc('packages/shared/src/orders.ts');
    expect(src).toMatch(/UpdateOrderSchema\s*=\s*z\.object/);
    expect(src).toMatch(/status:\s*OrderStatusSchema\.optional/);
    expect(src).toMatch(/clientId:\s*z\.string\(\)\.min\(1\)\.nullable\(\)\.optional/);
    expect(src).toMatch(/dueDate:\s*DateStringSchema\.nullable\(\)\.optional/);
  });

  test('OrdersController вешает @Patch(":id") c UpdateOrderSchema и actor', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.controller.ts');
    expect(src).toMatch(/@Patch\(\s*['"]:id['"]\s*\)/);
    expect(src).toMatch(/UpdateOrderSchema/);
    // actorEmployeeId должен пробрасываться в сервис — нужно для
    // ORDER_UPDATED audit (см. integration `orders-edit-admin.test.ts`).
    expect(src).toMatch(/orders\.update\(\s*id,\s*dto,\s*user\.employeeId\s*\)/);
  });
});
