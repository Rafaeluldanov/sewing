/**
 * Source-level smoke-тесты модуля «Готовность к крою» (Cut Readiness,
 * Этап 8А, см. `apps/api/src/modules/cut-readiness/*`,
 * `apps/web/components/orders/cut-readiness-card.tsx`,
 * `docs/recon-soft-integration.md §«Этап 8А»`).
 *
 * Проверяем «модуль не отвалился из AppModule / контроллер на нужном
 * пути / RBAC расширен на CUTTER+CUTTER_ASSISTANT / shared DTO
 * экспортирован / UI-блок подключён в карточке заказа». Без поднятия
 * БД и Nest-приложения.
 *
 * ВНИМАНИЕ: этап 8А сознательно read-only. Этот файл также фиксирует
 * инвариант «модуль ничего не пишет в БД» — мы проверяем, что
 * сервис не использует `prisma.*.create/.update/.delete` (см.
 * `service does not write` ниже).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('Cut readiness (Этап 8А) — smoke', () => {
  test('AppModule подключает CutReadinessModule', () => {
    const src = readSrc('apps/api/src/app.module.ts');
    expect(src).toMatch(/CutReadinessModule/);
    expect(src).toMatch(/cut-readiness\/cut-readiness\.module/);
  });

  test('Контроллер повешен на /api/orders/:orderId/cut-readiness и расширен RBAC', () => {
    const ctrl = readSrc(
      'apps/api/src/modules/cut-readiness/cut-readiness.controller.ts',
    );
    expect(ctrl).toMatch(/@Controller\(['"]orders['"]\)/);
    expect(ctrl).toMatch(/:orderId\/cut-readiness/);
    // RBAC явно расширен на кройщиков для read-only сводки.
    expect(ctrl).toMatch(
      /@Roles\(['"]ADMIN['"],\s*['"]SHOP_MANAGER['"],\s*['"]CUTTER['"],\s*['"]CUTTER_ASSISTANT['"]\)/,
    );
    // Только GET — никаких write-эндпоинтов на этом этапе.
    expect(ctrl).toMatch(/@Get\(/);
    expect(ctrl).not.toMatch(/@Post\(|@Patch\(|@Put\(|@Delete\(/);
  });

  test('Модуль регистрирует только controller + service, без новых providers', () => {
    const mod = readSrc(
      'apps/api/src/modules/cut-readiness/cut-readiness.module.ts',
    );
    expect(mod).toMatch(/controllers:\s*\[CutReadinessController\]/);
    expect(mod).toMatch(/providers:\s*\[CutReadinessService\]/);
  });

  test('Service is read-only: no create/update/delete calls', () => {
    const svc = readSrc(
      'apps/api/src/modules/cut-readiness/cut-readiness.service.ts',
    );
    // Жёсткая граница: сервис не должен писать в БД.
    expect(svc).not.toMatch(/prisma\.[a-zA-Z]+\.create/);
    expect(svc).not.toMatch(/prisma\.[a-zA-Z]+\.update/);
    expect(svc).not.toMatch(/prisma\.[a-zA-Z]+\.delete/);
    expect(svc).not.toMatch(/prisma\.\$transaction/);
    // Чтение — да: order.findUnique + workshopNeed.findMany +
    // orderMaterialArrivalOverride.findMany (этап «Ручная отметка
    // поступления материала»).
    expect(svc).toMatch(/prisma\.order\.findUnique/);
    expect(svc).toMatch(/prisma\.workshopNeed\.findMany/);
    expect(svc).toMatch(/prisma\.orderMaterialArrivalOverride\.findMany/);
  });

  test('Service classifies critical roles and uses POSTED-only receipt lines', () => {
    const svc = readSrc(
      'apps/api/src/modules/cut-readiness/cut-readiness.service.ts',
    );
    expect(svc).toMatch(/CUT_BLOCKING_MATERIAL_ROLES/);
    expect(svc).toMatch(/isCutBlockingMaterialRole/);
    // Учитываем только POSTED строки приёмки.
    expect(svc).toMatch(/status\s*!==\s*['"]POSTED['"]/);
  });

  test('Shared контракт экспортирует статусы / роли / DTO', () => {
    const shared = readSrc('packages/shared/src/cut-readiness.ts');
    expect(shared).toMatch(/CUT_READINESS_STATUSES/);
    expect(shared).toMatch(/CUT_READINESS_CHECK_STATUSES/);
    expect(shared).toMatch(/CUT_BLOCKING_MATERIAL_ROLES/);
    expect(shared).toMatch(/CutReadinessDto/);
    expect(shared).toMatch(/CutReadinessCheckDto/);
    expect(shared).toMatch(/CutMaterialReadinessDto/);
    expect(shared).toMatch(/CutMaterialReadinessCellDto/);
    // Список критичных ролей фиксирован на MVP.
    expect(shared).toMatch(/'MAIN_FABRIC'/);
    expect(shared).toMatch(/'RIB'/);
    expect(shared).toMatch(/'LINING'/);

    const barrel = readSrc('packages/shared/src/index.ts');
    expect(barrel).toMatch(/cut-readiness/);

    const pkg = JSON.parse(readSrc('packages/shared/package.json')) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports['./cut-readiness']).toBe('./src/cut-readiness.ts');
  });

  test('Frontend API client', () => {
    const api = readSrc('apps/web/lib/cut-readiness-api.ts');
    expect(api).toMatch(/getOrderCutReadiness/);
    expect(api).toMatch(/\/orders\//);
    expect(api).toMatch(/cut-readiness/);
  });

  test('CutReadiness API consumed by карточкой заказа через OrderNeedsTab', () => {
    // Order management redesign: материалы и готовность к крою живут
    // во вкладке «Потребности» (`OrderNeedsTab`), которая
    // переиспользует `OrderMaterialsUnifiedTable` +
    // `ManualMaterialArrivalActions`. Сам компонент
    // `cut-readiness-card.tsx` оставлен как переиспользуемый блок.
    const page = readSrc('apps/web/app/admin/orders/[id]/page.tsx');
    expect(page).toMatch(/<OrderNeedsTab\b/);
    expect(page).not.toMatch(/<CutReadinessCard\b/);

    const needsTab = readSrc(
      'apps/web/components/orders/view/tabs/order-needs-tab.tsx',
    );
    expect(needsTab).toMatch(/<OrderMaterialsUnifiedTable\b/);
    expect(needsTab).toMatch(/<ManualMaterialArrivalActions\b/);

    const unified = readSrc(
      'apps/web/components/orders/materials/order-materials-unified-table.tsx',
    );
    expect(unified).toMatch(/getOrderCutReadiness/);

    const manual = readSrc(
      'apps/web/components/orders/materials/manual-material-arrival-actions.tsx',
    );
    expect(manual).toMatch(/getOrderCutReadiness/);
  });

  test('CutReadinessCard component остаётся доступен и читает API (не удалён)', () => {
    const card = readSrc(
      'apps/web/components/orders/cut-readiness-card.tsx',
    );
    expect(card).toMatch(/getOrderCutReadiness/);
    expect(card).toMatch(/CUT_READINESS_STATUS_LABELS/);
    expect(card).toMatch(/Блокеры/);
    expect(card).toMatch(/Материалы/);
    expect(card).toMatch(/Предупреждения/);
    // Таблица материалов внутри самого компонента содержит колонку
    // с ячейками (компонент сохранён в репозитории как готовый
    // блок, который можно переиспользовать в других местах).
    expect(card).toMatch(/MaterialsTable/);
    expect(card).toMatch(/cellCode/);
  });

  test('Этап 8А не добавляет миграций и не трогает Prisma', () => {
    // Не должно быть никакой свежей миграции с упоминанием cut readiness
    // (этап 8А — computed, без новых таблиц).
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).not.toMatch(/model CutReadiness/);
    expect(schema).not.toMatch(/model CutJob/);
  });
});
