/**
 * Source-level smoke-тесты модуля «Потребность цеха» (Этап 4А, см.
 * `apps/api/src/modules/workshop-needs/*`,
 * `apps/web/app/admin/workshop-needs/*`,
 * `docs/recon-soft-integration.md §«Этап 4А»`).
 *
 * Зачем нужны smoke-тесты: они быстро ловят регрессии «модуль
 * случайно отвалился из навигации / API-route ушёл в 404 / бэкенд
 * собирается без `WorkshopNeedsModule`», без поднятия БД.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('Workshop needs (Этап 4А) — smoke', () => {
  test('AppModule подключает WorkshopNeedsModule', () => {
    const src = readSrc('apps/api/src/app.module.ts');
    expect(src).toMatch(/WorkshopNeedsModule/);
    expect(src).toMatch(/workshop-needs\/workshop-needs.module/);
  });

  test('Backend контроллеры повешены под нужные пути', () => {
    const main = readSrc(
      'apps/api/src/modules/workshop-needs/workshop-needs.controller.ts',
    );
    expect(main).toMatch(/@Controller\(['"]workshop-needs['"]\)/);
    // RBAC: ровно ADMIN + SHOP_MANAGER, без новых ролей.
    expect(main).toMatch(/@Roles\(['"]ADMIN['"],\s*['"]SHOP_MANAGER['"]\)/);

    const orderCtrl = readSrc(
      'apps/api/src/modules/workshop-needs/workshop-needs.order-controller.ts',
    );
    expect(orderCtrl).toMatch(/@Controller\(['"]orders['"]\)/);
    expect(orderCtrl).toMatch(/workshop-needs\/calculate/);
    expect(orderCtrl).toMatch(/@Roles\(['"]ADMIN['"],\s*['"]SHOP_MANAGER['"]\)/);
  });

  test('Sidebar показывает пункт «Потребность цеха» только за фичефлагом', () => {
    const src = readSrc('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(/NEXT_PUBLIC_FEATURE_WORKSHOP_NEEDS/);
    expect(src).toMatch(/FEATURE_WORKSHOP_NEEDS_ENABLED/);
    expect(src).toMatch(/Потребность цеха/);
    expect(src).toMatch(/\/admin\/workshop-needs/);
  });

  test('Карточка заказа показывает данные потребности через OrderNeedsTab → unified-таблицу', () => {
    // Order management redesign: отдельной карточки
    // `WorkshopNeedsCard` на странице нет — данные собираются в
    // `OrderMaterialsUnifiedTable`, который рендерится через
    // `OrderNeedsTab` (вкладка «Потребности»). Сам компонент
    // `WorkshopNeedsCard` остался в репозитории.
    const page = readSrc('apps/web/app/admin/orders/[id]/page.tsx');
    expect(page).toMatch(/<OrderNeedsTab\b/);
    expect(page).not.toMatch(/<WorkshopNeedsCard\b/);

    const needsTab = readSrc(
      'apps/web/components/orders/view/tabs/order-needs-tab.tsx',
    );
    expect(needsTab).toMatch(/<OrderMaterialsUnifiedTable\b/);

    const unified = readSrc(
      'apps/web/components/orders/materials/order-materials-unified-table.tsx',
    );
    expect(unified).toMatch(/getOrderWorkshopNeeds/);
  });

  test('WorkshopNeedsCard читает потребности и предлагает «Просчитать»', () => {
    const card = readSrc(
      'apps/web/components/orders/workshop-needs-card.tsx',
    );
    expect(card).toMatch(/getOrderWorkshopNeeds/);
    expect(card).toMatch(/CalculateWorkshopNeedsForm/);
    // Сводка под description содержит «Чистая» и «К закупке».
    expect(card).toMatch(/Чистая/);
    expect(card).toMatch(/К закупке/);
  });

  test('API-клиент покрывает все пять методов', () => {
    const api = readSrc('apps/web/lib/workshop-needs-api.ts');
    expect(api).toMatch(/listWorkshopNeeds/);
    expect(api).toMatch(/getWorkshopNeed/);
    expect(api).toMatch(/updateWorkshopNeed/);
    expect(api).toMatch(/cancelWorkshopNeed/);
    expect(api).toMatch(/calculateOrderWorkshopNeeds/);
    expect(api).toMatch(/getOrderWorkshopNeeds/);
  });

  test('Shared контракт экспортирует статусы / методы расчёта / DTO', () => {
    const shared = readSrc('packages/shared/src/workshop-needs.ts');
    expect(shared).toMatch(/WORKSHOP_NEED_STATUSES/);
    expect(shared).toMatch(/WORKSHOP_NEED_STATUS_LABELS/);
    expect(shared).toMatch(/WORKSHOP_NEED_CALCULATION_METHODS/);
    expect(shared).toMatch(/WORKSHOP_NEED_CALCULATION_METHOD_LABELS/);
    expect(shared).toMatch(/UpdateWorkshopNeedSchema/);
    expect(shared).toMatch(/CalculateWorkshopNeedsSchema/);
    expect(shared).toMatch(/ListWorkshopNeedsQuerySchema/);
    expect(shared).toMatch(/WorkshopNeedDto/);
    expect(shared).toMatch(/CalculateWorkshopNeedsResultDto/);

    const barrel = readSrc('packages/shared/src/index.ts');
    expect(barrel).toMatch(/workshop-needs/);

    const pkg = JSON.parse(readSrc('packages/shared/package.json')) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports['./workshop-needs']).toBe('./src/workshop-needs.ts');
  });

  test('Errors объявляют четыре исключения с правильными кодами', () => {
    const src = readSrc('apps/api/src/common/errors.ts');
    expect(src).toMatch(/WorkshopNeedNotFoundException/);
    expect(src).toMatch(/WORKSHOP_NEED_NOT_FOUND/);
    expect(src).toMatch(/WorkshopNeedsAlreadyReviewedException/);
    expect(src).toMatch(/WORKSHOP_NEEDS_ALREADY_REVIEWED/);
    expect(src).toMatch(/WorkshopNeedCalculationSourceException/);
    expect(src).toMatch(/WORKSHOP_NEED_SOURCE_REQUIRED/);
    expect(src).toMatch(/WorkshopNeedOrderItemsRequiredException/);
    expect(src).toMatch(/WORKSHOP_NEED_ORDER_ITEMS_REQUIRED/);
  });

  test('AuditService содержит entityType WORKSHOP_NEED', () => {
    const src = readSrc('apps/api/src/modules/audit/audit.service.ts');
    expect(src).toMatch(/['"]WORKSHOP_NEED['"]/);
    expect(src).toMatch(/WORKSHOP_NEEDS_CALCULATED/);
    expect(src).toMatch(/WORKSHOP_NEED_UPDATED/);
    expect(src).toMatch(/WORKSHOP_NEED_CANCELLED/);
  });

  test('Prisma schema объявляет модель WorkshopNeed и back-relation', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(/model WorkshopNeed\s*\{/);
    // Order ← WorkshopNeed back-relation.
    expect(src).toMatch(/workshopNeeds\s+WorkshopNeed\[\]/);
    // status и calculationMethod должны быть TEXT (String) — без enum.
    expect(src).toMatch(/calculationMethod\s+String\s+@default\("QTY_PER_UNIT"\)/);
    expect(src).toMatch(/status\s+String\s+@default\("CALCULATED"\)/);
  });

  test('Migration создаёт таблицу WorkshopNeed с FK на Order', () => {
    const src = readSrc(
      'prisma/migrations/20260509100000_add_workshop_needs/migration.sql',
    );
    expect(src).toMatch(/CREATE TABLE "WorkshopNeed"/);
    expect(src).toMatch(
      /CONSTRAINT "WorkshopNeed_orderId_fkey"\s+FOREIGN KEY \("orderId"\) REFERENCES "Order"\("id"\)/,
    );
    expect(src).toMatch(/CREATE INDEX "WorkshopNeed_orderId_idx"/);
    expect(src).toMatch(/CREATE INDEX "WorkshopNeed_status_idx"/);
    expect(src).toMatch(/CREATE INDEX "WorkshopNeed_materialRole_idx"/);
    expect(src).toMatch(/CREATE INDEX "WorkshopNeed_calculationMethod_idx"/);
  });

  test('.env.example документирует NEXT_PUBLIC_FEATURE_WORKSHOP_NEEDS', () => {
    const src = readSrc('.env.example');
    expect(src).toMatch(/NEXT_PUBLIC_FEATURE_WORKSHOP_NEEDS/);
  });
});
