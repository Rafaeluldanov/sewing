/**
 * Source-level smoke-тесты этапа «Ручная отметка поступления материала»
 * (см. `apps/api/src/modules/order-material-arrivals/*`,
 * `apps/api/src/modules/cut-readiness/cut-readiness.service.ts`,
 * `apps/web/components/orders/cut-readiness-card.tsx`,
 * `prisma/schema.prisma::OrderMaterialArrivalOverride`).
 *
 * Без поднятия БД и Nest-приложения. Покрытие соответствует ТЗ §10
 * «TESTS / Smoke»:
 *   1. Prisma model `OrderMaterialArrivalOverride` существует;
 *   2. Migration создаёт только новую таблицу (CREATE TABLE + FK +
 *      INDEX), без destructive-операций;
 *   3. Endpoints `POST /api/orders/:id/material-arrived` /
 *      `GET .../material-arrival-overrides` /
 *      `POST .../revoke` существуют и защищены RBAC;
 *   4. Сервис не создаёт `PurchaseReceipt` / `PurchaseReceiptLine` /
 *      `CellContent`, не двигает `WorkshopNeed.status` /
 *      `Order.status`;
 *   5. CutReadinessService читает ACTIVE-overrides;
 *   6. CutReadinessDto расширен полями `manuallyUnblocked` /
 *      `manualArrivedQty`;
 *   7. UI содержит кнопку «Материал поступил» и пояснение про
 *      «не создаёт складскую приёмку»;
 *   8. UI показывает badge «Материал поступил вручную»;
 *   9. Revoke-action существует в server-actions.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('order-material-arrivals (Ручная отметка поступления) — smoke', () => {
  // ---------------------------------------------------------------------------
  // 1. Prisma model + migration
  // ---------------------------------------------------------------------------

  test('Prisma model OrderMaterialArrivalOverride существует и имеет ожидаемые поля', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/model\s+OrderMaterialArrivalOverride\s+\{/);
    expect(schema).toMatch(/orderId\s+String\b/);
    expect(schema).toMatch(/workshopNeedId\s+String\?/);
    expect(schema).toMatch(/materialRole\s+String\?/);
    expect(schema).toMatch(/qty\s+Decimal\?/);
    expect(schema).toMatch(/status\s+String\s+@default\(['"]ACTIVE['"]\)/);
    expect(schema).toMatch(/comment\s+String\?/);
    expect(schema).toMatch(/createdById\s+String\?/);
    expect(schema).toMatch(/revokedAt\s+DateTime\?/);
    expect(schema).toMatch(/revokedById\s+String\?/);
    expect(schema).toMatch(/revokeReason\s+String\?/);
    expect(schema).toMatch(/@@index\(\[orderId\]\)/);
    expect(schema).toMatch(/@@index\(\[status\]\)/);
    expect(schema).toMatch(/@@index\(\[workshopNeedId\]\)/);
    expect(schema).toMatch(/@@index\(\[materialRole\]\)/);
  });

  test('Order / WorkshopNeed / Employee имеют back-relations', () => {
    const schema = readSrc('prisma/schema.prisma');
    // На стороне Order — список overrides.
    expect(schema).toMatch(
      /materialArrivalOverrides\s+OrderMaterialArrivalOverride\[\]/,
    );
    // На стороне Employee — две именованные relation-ы (created/revoked).
    expect(schema).toMatch(
      /materialArrivalOverridesCreated\s+OrderMaterialArrivalOverride\[\]\s+@relation\(['"]OrderMaterialArrivalOverrideCreatedBy['"]\)/,
    );
    expect(schema).toMatch(
      /materialArrivalOverridesRevoked\s+OrderMaterialArrivalOverride\[\]\s+@relation\(['"]OrderMaterialArrivalOverrideRevokedBy['"]\)/,
    );
  });

  test('Migration создаёт только новую таблицу, без destructive-операций', () => {
    const sql = readSrc(
      'prisma/migrations/20260526100000_add_order_material_arrival_overrides/migration.sql',
    );
    expect(sql).toMatch(/CREATE TABLE\s+"OrderMaterialArrivalOverride"/);
    // FK на 4 родителя.
    expect(sql).toMatch(
      /CONSTRAINT\s+"OrderMaterialArrivalOverride_orderId_fkey"[\s\S]*REFERENCES\s+"Order"/,
    );
    expect(sql).toMatch(
      /CONSTRAINT\s+"OrderMaterialArrivalOverride_workshopNeedId_fkey"[\s\S]*REFERENCES\s+"WorkshopNeed"/,
    );
    expect(sql).toMatch(
      /CONSTRAINT\s+"OrderMaterialArrivalOverride_createdById_fkey"[\s\S]*REFERENCES\s+"Employee"/,
    );
    expect(sql).toMatch(
      /CONSTRAINT\s+"OrderMaterialArrivalOverride_revokedById_fkey"[\s\S]*REFERENCES\s+"Employee"/,
    );
    // Без destructive операций.
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    // НЕ трогает PurchaseReceipt / PurchaseReceiptLine / CellContent
    // как таблицы (комментарии-пояснения в SQL допустимы — проверяем
    // только реальные DDL-операции).
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+"PurchaseReceipt"/);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+"PurchaseReceiptLine"/);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+"CellContent"/);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+"WorkshopNeed"/);
    expect(sql).not.toMatch(/CREATE\s+TABLE\s+"PurchaseReceipt"/);
    expect(sql).not.toMatch(/CREATE\s+TABLE\s+"CellContent"/);
  });

  // ---------------------------------------------------------------------------
  // 2. AppModule + module + controller + service
  // ---------------------------------------------------------------------------

  test('AppModule подключает OrderMaterialArrivalsModule', () => {
    const src = readSrc('apps/api/src/app.module.ts');
    expect(src).toMatch(/OrderMaterialArrivalsModule/);
    expect(src).toMatch(/order-material-arrivals\/order-material-arrivals\.module/);
  });

  test('Module регистрирует controller + service, экспортирует service', () => {
    const mod = readSrc(
      'apps/api/src/modules/order-material-arrivals/order-material-arrivals.module.ts',
    );
    expect(mod).toMatch(/controllers:\s*\[OrderMaterialArrivalsController\]/);
    expect(mod).toMatch(/providers:\s*\[OrderMaterialArrivalsService\]/);
    expect(mod).toMatch(/exports:\s*\[OrderMaterialArrivalsService\]/);
  });

  test('Controller повешен на /api/orders и реализует все три endpoint-а', () => {
    const ctrl = readSrc(
      'apps/api/src/modules/order-material-arrivals/order-material-arrivals.controller.ts',
    );
    expect(ctrl).toMatch(/@Controller\(['"]orders['"]\)/);
    // RBAC: ADMIN + SHOP_MANAGER + чтение для CUTTER / CUTTER_ASSISTANT.
    expect(ctrl).toMatch(/@Roles\(/);
    expect(ctrl).toMatch(/['"]ADMIN['"]/);
    expect(ctrl).toMatch(/['"]SHOP_MANAGER['"]/);
    expect(ctrl).toMatch(/['"]CUTTER['"]/);
    expect(ctrl).toMatch(/['"]CUTTER_ASSISTANT['"]/);
    // Endpoints.
    expect(ctrl).toMatch(/:orderId\/material-arrival-overrides/);
    expect(ctrl).toMatch(/:orderId\/material-arrived/);
    expect(ctrl).toMatch(
      /:orderId\/material-arrival-overrides\/:overrideId\/revoke/,
    );
  });

  test('Service не создаёт PurchaseReceipt / PurchaseReceiptLine / CellContent', () => {
    const svc = readSrc(
      'apps/api/src/modules/order-material-arrivals/order-material-arrivals.service.ts',
    );
    // Граница MVP: НЕ создаём складские документы и НЕ трогаем
    // ячейки.
    expect(svc).not.toMatch(/purchaseReceipt\.create/);
    expect(svc).not.toMatch(/purchaseReceiptLine\.create/);
    expect(svc).not.toMatch(/cellContent/);
    // НЕ меняем WorkshopNeed.status.
    expect(svc).not.toMatch(/workshopNeed\.update/);
    // НЕ меняем Order.status.
    expect(svc).not.toMatch(/order\.update/);
    // Сами overrides — да, и аудит обязателен.
    expect(svc).toMatch(/orderMaterialArrivalOverride\.create/);
    expect(svc).toMatch(/ORDER_MATERIAL_ARRIVAL_OVERRIDE_CREATED/);
    expect(svc).toMatch(/ORDER_MATERIAL_ARRIVAL_OVERRIDE_REVOKED/);
  });

  // ---------------------------------------------------------------------------
  // 3. Audit
  // ---------------------------------------------------------------------------

  test('AuditEntityType расширен ORDER_MATERIAL_ARRIVAL_OVERRIDE', () => {
    const src = readSrc('apps/api/src/modules/audit/audit.service.ts');
    expect(src).toMatch(/['"]ORDER_MATERIAL_ARRIVAL_OVERRIDE['"]/);
  });

  // ---------------------------------------------------------------------------
  // 4. Shared DTO / schemas
  // ---------------------------------------------------------------------------

  test('Shared контракт: статусы / DTO / схемы', () => {
    const sharedSrc = readSrc(
      'packages/shared/src/order-material-arrivals.ts',
    );
    expect(sharedSrc).toMatch(/ORDER_MATERIAL_ARRIVAL_OVERRIDE_STATUSES/);
    expect(sharedSrc).toMatch(/'ACTIVE'/);
    expect(sharedSrc).toMatch(/'REVOKED'/);
    expect(sharedSrc).toMatch(/CreateOrderMaterialArrivalOverrideSchema/);
    expect(sharedSrc).toMatch(/RevokeOrderMaterialArrivalOverrideSchema/);
    expect(sharedSrc).toMatch(/OrderMaterialArrivalOverrideDto/);
    // comment min(2) и reason min(2).
    expect(sharedSrc).toMatch(/comment:\s*z\s*\.\s*string\(\)[\s\S]*?\.min\(\s*2/);
    expect(sharedSrc).toMatch(/reason:\s*z\s*\.\s*string\(\)[\s\S]*?\.min\(\s*2/);

    const indexSrc = readSrc('packages/shared/src/index.ts');
    expect(indexSrc).toMatch(/order-material-arrivals/);

    const pkg = JSON.parse(
      readSrc('packages/shared/package.json'),
    ) as { exports: Record<string, string> };
    expect(pkg.exports['./order-material-arrivals']).toBe(
      './src/order-material-arrivals.ts',
    );
  });

  test('CutReadiness DTO расширен manualArrivedQty / manuallyUnblocked / manualArrivalOverrides', () => {
    const sharedSrc = readSrc('packages/shared/src/cut-readiness.ts');
    expect(sharedSrc).toMatch(/manualArrivedQty\?/);
    expect(sharedSrc).toMatch(/manuallyUnblocked\?/);
    expect(sharedSrc).toMatch(/manualArrivalOverrides\?/);
    expect(sharedSrc).toMatch(/CutMaterialArrivalOverrideRefDto/);
  });

  // ---------------------------------------------------------------------------
  // 5. CutReadinessService учитывает overrides
  // ---------------------------------------------------------------------------

  test('CutReadinessService читает orderMaterialArrivalOverride.findMany и строит manuallyUnblocked', () => {
    const svc = readSrc(
      'apps/api/src/modules/cut-readiness/cut-readiness.service.ts',
    );
    // Сервис читает overrides, но НЕ пишет (read-only).
    expect(svc).toMatch(/prisma\.orderMaterialArrivalOverride\.findMany/);
    expect(svc).not.toMatch(/orderMaterialArrivalOverride\.create/);
    expect(svc).not.toMatch(/orderMaterialArrivalOverride\.update/);
    expect(svc).not.toMatch(/orderMaterialArrivalOverride\.delete/);
    // Логика manuallyUnblocked по overrides.
    expect(svc).toMatch(/manuallyUnblocked/);
    expect(svc).toMatch(/manualArrivedQty/);
    expect(svc).toMatch(/effectivePlacedQty/);
  });

  // ---------------------------------------------------------------------------
  // 6. Frontend API client + server actions
  // ---------------------------------------------------------------------------

  test('Frontend API client экспортирует mark / list / revoke', () => {
    const api = readSrc('apps/web/lib/order-material-arrivals-api.ts');
    expect(api).toMatch(/markOrderMaterialArrived/);
    expect(api).toMatch(/listOrderMaterialArrivalOverrides/);
    expect(api).toMatch(/revokeOrderMaterialArrivalOverride/);
    // Endpoint-пути.
    expect(api).toMatch(/material-arrived/);
    expect(api).toMatch(/material-arrival-overrides/);
    expect(api).toMatch(/revoke/);
  });

  test('Server actions для mark / revoke существуют', () => {
    const actions = readSrc(
      'apps/web/app/admin/orders/[id]/material-arrivals-actions.ts',
    );
    expect(actions).toMatch(/markOrderMaterialArrivedAction/);
    expect(actions).toMatch(/revokeOrderMaterialArrivalOverrideAction/);
    // revalidatePath на карточку заказа после успеха.
    expect(actions).toMatch(/revalidatePath/);
    expect(actions).toMatch(/admin\/orders/);
  });

  // ---------------------------------------------------------------------------
  // 7. UI: кнопка + бейдж + revoke
  // ---------------------------------------------------------------------------

  test('UI: кнопка «Материал поступил» с пояснением «не создаёт складскую приёмку»', () => {
    const button = readSrc(
      'apps/web/components/orders/material-arrived-button.tsx',
    );
    expect(button).toMatch(/Материал поступил/);
    // Текст переносится по словам — проверяем подстроки независимо.
    expect(button).toMatch(/не создаёт складскую/);
    expect(button).toMatch(/приёмку/);
    // Комментарий обязателен на UI (и валидируется Zod-ом на сервере).
    expect(button).toMatch(/name="comment"/);
    expect(button).toMatch(/required/);
    expect(button).toMatch(/markOrderMaterialArrivedAction/);
  });

  test('UI: badge «Материал поступил вручную» в CutReadinessCard', () => {
    const card = readSrc(
      'apps/web/components/orders/cut-readiness-card.tsx',
    );
    expect(card).toMatch(/Материал поступил вручную/);
    expect(card).toMatch(/manuallyUnblocked/);
    // Подключение кнопки и компонента отмены.
    expect(card).toMatch(/MaterialArrivedButton/);
    expect(card).toMatch(/RevokeMaterialArrivalButton/);
    // Пояснение про складскую приёмку.
    expect(card).toMatch(/Складская приёмка не создана/);
  });

  test('UI: кнопка «Отменить отметку» зовёт revoke action', () => {
    const revoke = readSrc(
      'apps/web/components/orders/revoke-material-arrival-button.tsx',
    );
    expect(revoke).toMatch(/Отменить отметку/);
    expect(revoke).toMatch(/revokeOrderMaterialArrivalOverrideAction/);
    // Обязательная причина.
    expect(revoke).toMatch(/name="reason"/);
    expect(revoke).toMatch(/required/);
  });

  test('Карточка заказа подключает OrderNeedsTab + ManualMaterialArrivalActions', () => {
    // Order management redesign: материалы и ручная разблокировка
    // живут во вкладке «Потребности» (`OrderNeedsTab`) — рендерит
    // `OrderMaterialsUnifiedTable` + `ManualMaterialArrivalActions`.
    // Сам action и backend модуль `order-material-arrivals` не
    // менялись.
    const page = readSrc('apps/web/app/admin/orders/[id]/page.tsx');
    expect(page).toMatch(/<OrderNeedsTab\b/);

    const tab = readSrc(
      'apps/web/components/orders/view/tabs/order-needs-tab.tsx',
    );
    expect(tab).toMatch(/ManualMaterialArrivalActions/);
    expect(tab).toMatch(/orderStatus=\{order\.status\}/);

    const manual = readSrc(
      'apps/web/components/orders/materials/manual-material-arrival-actions.tsx',
    );
    expect(manual).toMatch(/MaterialArrivedButton/);
    expect(manual).toMatch(/RevokeMaterialArrivalButton/);
    expect(manual).toMatch(/не создаёт складскую/);
  });
});
