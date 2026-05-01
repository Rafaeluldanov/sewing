/**
 * Smoke-тесты этапа «Нанесение на заказе покупателя».
 *
 * Покрытие — source-level (как и остальные smoke в этой папке):
 *   1. Prisma schema содержит модель `OrderApplication` + индексы
 *      + back-relation `applications` на `Order`;
 *   2. Миграция `20260517100000_add_order_applications` существует и
 *      имеет CREATE TABLE + FK на `Order`;
 *   3. `@sewing/shared/order-applications` экспортирует константы
 *      и Zod-схемы;
 *   4. Backend модуль `order-applications` зарегистрирован в `AppModule`
 *      и предоставляет GET/PUT-эндпоинты;
 *   5. `OrderDetailDto` расширен полем `applications`;
 *   6. Frontend API client `order-applications-api.ts` существует и
 *      использует `apiFetch`;
 *   7. UI карточки заказа содержит блок «Нанесение» с поддержкой
 *      stage «На крое» / «На готовом изделии»;
 *   8. `CutReadinessService` обрабатывает заказные нанесения
 *      (CUT_PARTS / FINISHED_ITEM);
 *   9. `WorkshopNeedsService` создаёт `WorkshopNeed` с
 *      `sourceType = ORDER_APPLICATION` и `materialRole = APPLICATION`;
 *  10. Tech-card UI больше не предлагает APPLICATION/PACKAGING как
 *      «новые» материал-роли (старые legacy строки остаются).
 *
 * Маршрут (`ProductionRoute` / `RouteTemplate` / `OrderRouteStep`)
 * не изменился — отдельный негативный assertion ниже.
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
// 1. Prisma schema: модель OrderApplication + back-relation Order.applications
// ---------------------------------------------------------------------------

describe('Prisma schema: OrderApplication', () => {
  const schema = read('prisma/schema.prisma');

  test('содержит модель OrderApplication', () => {
    expect(schema).toMatch(/model OrderApplication \{/);
  });

  test('имеет ожидаемые поля и FK на Order', () => {
    expect(schema).toMatch(/orderId\s+String/);
    expect(schema).toMatch(/order\s+Order\s+@relation\(fields:\s*\[orderId\][^)]*onDelete:\s*Cascade\)/);
    expect(schema).toMatch(/type\s+String\s*$/m);
    expect(schema).toMatch(/stage\s+String\s+@default\("CUT_PARTS"\)/);
    expect(schema).toMatch(/quantity\s+Decimal\?\s+@db\.Decimal\(14,\s*4\)/);
    expect(schema).toMatch(/unit\s+String\s+@default\("шт"\)/);
    expect(schema).toMatch(/status\s+String\s+@default\("PLANNED"\)/);
  });

  test('имеет индексы по orderId / type / stage / status', () => {
    // Индексы расположены внутри блока модели; проверяем
    // присутствие всех четырёх @@index.
    const blockMatch = schema.match(/model OrderApplication \{[\s\S]*?\n\}/);
    expect(blockMatch).not.toBeNull();
    const block = blockMatch![0];
    expect(block).toMatch(/@@index\(\[orderId\]\)/);
    expect(block).toMatch(/@@index\(\[type\]\)/);
    expect(block).toMatch(/@@index\(\[stage\]\)/);
    expect(block).toMatch(/@@index\(\[status\]\)/);
  });

  test('Order имеет back-relation applications OrderApplication[]', () => {
    expect(schema).toMatch(/applications\s+OrderApplication\[\]/);
  });

  test('Prisma enum для типа/stage/статуса НЕ создаётся', () => {
    // ТЗ §1: «Не использовать Prisma enum». Поля строкой.
    expect(schema).not.toMatch(/enum OrderApplicationType\b/);
    expect(schema).not.toMatch(/enum OrderApplicationStage\b/);
    expect(schema).not.toMatch(/enum OrderApplicationStatus\b/);
  });
});

// ---------------------------------------------------------------------------
// 2. Migration
// ---------------------------------------------------------------------------

describe('Migration 20260517100000_add_order_applications', () => {
  const dir = 'prisma/migrations/20260517100000_add_order_applications';

  test('директория и файл миграции существуют', () => {
    expect(exists(dir)).toBe(true);
    expect(exists(`${dir}/migration.sql`)).toBe(true);
  });

  test('создаёт таблицу OrderApplication + FK на Order', () => {
    const sql = read(`${dir}/migration.sql`);
    expect(sql).toMatch(/CREATE TABLE\s+"OrderApplication"/);
    expect(sql).toMatch(/CREATE INDEX\s+"OrderApplication_orderId_idx"/);
    expect(sql).toMatch(/CREATE INDEX\s+"OrderApplication_type_idx"/);
    expect(sql).toMatch(/CREATE INDEX\s+"OrderApplication_stage_idx"/);
    expect(sql).toMatch(/CREATE INDEX\s+"OrderApplication_status_idx"/);
    expect(sql).toMatch(
      /ALTER TABLE\s+"OrderApplication"[\s\S]*?FOREIGN KEY\s+\("orderId"\)[\s\S]*?REFERENCES\s+"Order"/,
    );
    expect(sql).toMatch(/ON DELETE CASCADE/);
  });

  test('миграция additive: не трогает другие таблицы', () => {
    const sql = read(`${dir}/migration.sql`);
    // ALTER TABLE применяется только к OrderApplication (для FK).
    const alters = sql.match(/ALTER TABLE\s+"([^"]+)"/g) ?? [];
    for (const a of alters) {
      expect(a).toMatch(/"OrderApplication"/);
    }
    // Никаких DROP TABLE / DROP COLUMN.
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Shared package: order-applications.ts
// ---------------------------------------------------------------------------

describe('@sewing/shared/order-applications', () => {
  const SHARED = 'packages/shared/src/order-applications.ts';

  test('файл существует и экспортирует константы', () => {
    expect(exists(SHARED)).toBe(true);
    const src = read(SHARED);
    expect(src).toMatch(/export const ORDER_APPLICATION_TYPES\b/);
    expect(src).toMatch(/export const ORDER_APPLICATION_TYPE_LABELS\b/);
    expect(src).toMatch(/export const ORDER_APPLICATION_STAGES\b/);
    expect(src).toMatch(/export const ORDER_APPLICATION_STAGE_LABELS\b/);
    expect(src).toMatch(/export const ORDER_APPLICATION_STATUSES\b/);
    // Этапы CUT_PARTS / FINISHED_ITEM.
    expect(src).toMatch(/'CUT_PARTS'/);
    expect(src).toMatch(/'FINISHED_ITEM'/);
    // 6 типов нанесения.
    expect(src).toMatch(/'SCREEN_PRINT'/);
    expect(src).toMatch(/'DTF'/);
    expect(src).toMatch(/'EMBROIDERY'/);
    expect(src).toMatch(/'HEAT_TRANSFER'/);
    expect(src).toMatch(/'SUBLIMATION'/);
    expect(src).toMatch(/'OTHER'/);
  });

  test('экспортирует Zod-схемы', () => {
    const src = read(SHARED);
    expect(src).toMatch(/export const OrderApplicationInputSchema\b/);
    expect(src).toMatch(/export const ReplaceOrderApplicationsSchema\b/);
    // OrderApplicationDto — interface.
    expect(src).toMatch(/export interface OrderApplicationDto\b/);
  });

  test('реэкспортирован из barrel index.ts', () => {
    const idx = read('packages/shared/src/index.ts');
    expect(idx).toMatch(/export \* from '\.\/order-applications'/);
  });

  test('package.json exports содержит ./order-applications', () => {
    const pkg = read('packages/shared/package.json');
    expect(pkg).toMatch(
      /"\.\/order-applications":\s*"\.\/src\/order-applications\.ts"/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Backend: модуль и эндпоинты GET/PUT /orders/:id/applications
// ---------------------------------------------------------------------------

describe('Backend module order-applications', () => {
  const MOD = 'apps/api/src/modules/order-applications/order-applications.module.ts';
  const SVC = 'apps/api/src/modules/order-applications/order-applications.service.ts';
  const CTRL = 'apps/api/src/modules/order-applications/order-applications.controller.ts';

  test('файлы модуля существуют', () => {
    expect(exists(MOD)).toBe(true);
    expect(exists(SVC)).toBe(true);
    expect(exists(CTRL)).toBe(true);
  });

  test('Controller @Controller(\'orders\') c GET и PUT /:id/applications', () => {
    const src = read(CTRL);
    expect(src).toMatch(/@Controller\(['"]orders['"]\)/);
    expect(src).toMatch(/@Get\(['"]:id\/applications['"]\)/);
    expect(src).toMatch(/@Put\(['"]:id\/applications['"]\)/);
    // RBAC: ADMIN и SHOP_MANAGER.
    expect(src).toMatch(/@Roles\(['"]ADMIN['"],\s*['"]SHOP_MANAGER['"]\)/);
  });

  test('Service делает full-replace в транзакции и пишет аудит', () => {
    const src = read(SVC);
    expect(src).toMatch(/replaceForOrder/);
    expect(src).toMatch(/this\.prisma\.\$transaction/);
    expect(src).toMatch(/orderApplication\.deleteMany/);
    expect(src).toMatch(/orderApplication\.createMany/);
    expect(src).toMatch(/ORDER_APPLICATIONS_REPLACED/);
    // ORDER_APPLICATION_ORDER_LOCKED при не-DRAFT.
    expect(src).toMatch(/OrderApplicationOrderLockedException/);
  });

  test('Module зарегистрирован в AppModule', () => {
    const app = read('apps/api/src/app.module.ts');
    expect(app).toMatch(/OrderApplicationsModule/);
    expect(app).toMatch(
      /from\s+['"][^'"]*\/order-applications\/order-applications\.module/,
    );
  });

  test('exception OrderApplicationOrderLockedException определён', () => {
    const errs = read('apps/api/src/common/errors.ts');
    expect(errs).toMatch(/class OrderApplicationOrderLockedException\b/);
    expect(errs).toMatch(/code:\s*['"]ORDER_APPLICATION_ORDER_LOCKED['"]/);
  });
});

// ---------------------------------------------------------------------------
// 5. OrderDetailDto расширен полем applications
// ---------------------------------------------------------------------------

describe('OrderDetailDto: applications', () => {
  test('shared/orders.ts расширен полем applications', () => {
    const src = read('packages/shared/src/orders.ts');
    expect(src).toMatch(/applications\?:\s*OrderApplicationDto\[\]/);
    // Импорт типа OrderApplicationDto.
    expect(src).toMatch(
      /from '\.\/order-applications'/,
    );
  });

  test('orders.service.ts маппит applications в getOne', () => {
    const src = read('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/applications:\s*\{\s*orderBy:\s*\{\s*createdAt:\s*'asc'\s*\}/);
    expect(src).toMatch(/applicationRowToDto/);
  });
});

// ---------------------------------------------------------------------------
// 6. Frontend API client
// ---------------------------------------------------------------------------

describe('Frontend lib/order-applications-api.ts', () => {
  const API = 'apps/web/lib/order-applications-api.ts';

  test('файл существует и экспортирует методы', () => {
    expect(exists(API)).toBe(true);
    const src = read(API);
    expect(src).toMatch(/export function getOrderApplications\b/);
    expect(src).toMatch(/export function replaceOrderApplications\b/);
    expect(src).toMatch(/apiFetch</);
    expect(src).toMatch(/method:\s*'PUT'/);
  });
});

// ---------------------------------------------------------------------------
// 7. UI карточки заказа: блок «Нанесение»
// ---------------------------------------------------------------------------

describe('/admin/orders/[id] — блок «Нанесение»', () => {
  const PAGE = 'apps/web/app/admin/orders/[id]/page.tsx';
  const CARD = 'apps/web/components/orders/order-applications-card.tsx';
  const FORM = 'apps/web/components/orders/order-applications-form.tsx';
  const EDITOR =
    'apps/web/components/orders/order-applications-editor.tsx';
  const ACTIONS = 'apps/web/app/admin/orders/[id]/applications-actions.ts';

  test('OrderApplicationsCard / Form / Editor / actions присутствуют', () => {
    expect(exists(CARD)).toBe(true);
    expect(exists(FORM)).toBe(true);
    expect(exists(EDITOR)).toBe(true);
    expect(exists(ACTIONS)).toBe(true);
  });

  test('страница карточки заказа НЕ рендерит OrderApplicationsCard напрямую', () => {
    // Order management redesign: блок «Нанесение» больше не живёт на
    // самой управленческой странице — её содержимое уехало в форму
    // редактирования (`/admin/orders/[id]/edit`) и в legacy-карточку
    // `/orders/[id]`. На management-вкладках OrderApplicationsCard
    // сознательно не появляется, чтобы не плодить «вкладку Обзор».
    const src = read(PAGE);
    expect(src).not.toMatch(/<OrderApplicationsCard\b/);
  });

  test('OrderApplicationsCard содержит подзаголовок «Нанесение»', () => {
    const src = read(CARD);
    expect(src).toMatch(/>\s*Нанесение/);
  });

  test('OrderApplicationsEditor поддерживает stage «На крое» / «На готовом изделии»', () => {
    const editorSrc = read(EDITOR);
    expect(editorSrc).toMatch(/ORDER_APPLICATION_STAGE_LABELS/);
    expect(editorSrc).toMatch(/Когда выполняется/);
    // Лейблы из shared-словаря: 'На крое' / 'На готовом изделии'.
    const sharedSrc = read('packages/shared/src/order-applications.ts');
    expect(sharedSrc).toMatch(/CUT_PARTS:\s*['"]На крое['"]/);
    expect(sharedSrc).toMatch(/FINISHED_ITEM:\s*['"]На готовом изделии['"]/);
    // Editor умеет добавлять / удалять строки.
    expect(editorSrc).toMatch(/Добавить нанесение/);
  });

  test('OrderApplicationsForm использует <form action={formAction}> + bind(orderId) + Editor', () => {
    const formSrc = read(FORM);
    // Используем стандартный пользовательский путь Next.js 14 для
    // server actions с FormData (см. material-areas-form.tsx как
    // эталон). Раньше форма делала `startTransition` + ручной
    // `new FormData(currentTarget)`, что приводило к молчаливой
    // потере submit на клиенте.
    expect(formSrc).toMatch(/useFormState\b/);
    expect(formSrc).toMatch(/saveOrderApplicationsAction\.bind\(\s*null\s*,\s*orderId\s*\)/);
    expect(formSrc).toMatch(/<form\s+action=\{formAction\}/);
    expect(formSrc).toMatch(/<OrderApplicationsEditor\b/);
    expect(formSrc).toMatch(/Сохранить нанесение/);
    // Старый хрупкий путь через startTransition больше не используется
    // (только как pattern в JSDoc, реальный импорт useTransition отсутствует).
    expect(formSrc).not.toMatch(/import\s*\{[^}]*useTransition/);
    expect(formSrc).not.toMatch(/new FormData\(e\.currentTarget\)/);
  });

  test('actions использует applicationsJson + replaceOrderApplications + revalidatePath', () => {
    const src = read(ACTIONS);
    // Контракт сабмита: hidden input `applicationsJson` (см.
    // OrderApplicationsEditor). Server action парсит JSON и валидирует
    // через ReplaceOrderApplicationsSchema. Это надёжнее, чем ручной
    // парсинг `applications[i].field`-полей FormData.
    expect(src).toMatch(/applicationsJson/);
    expect(src).toMatch(/replaceOrderApplications/);
    expect(src).toMatch(/ReplaceOrderApplicationsSchema/);
    // Сигнатура совместима с useFormState + bind(null, orderId).
    expect(src).toMatch(
      /export async function saveOrderApplicationsAction\(\s*orderId:\s*string,\s*_prev:\s*OrderApplicationsFormState,\s*form:\s*FormData/,
    );
    // Revalidate для server-component RSC карточки заказа.
    expect(src).toMatch(/revalidatePath\(`\/admin\/orders\/\$\{orderId\}`\)/);
  });
});

// ---------------------------------------------------------------------------
// 7b. Создание заказа с нанесением (`/admin/orders/new`)
// ---------------------------------------------------------------------------

describe('/admin/orders/new — блок «Нанесение» и atomic-create', () => {
  const FORM = 'apps/web/app/admin/orders/new/admin-create-order-form.tsx';
  const ACTIONS = 'apps/web/app/orders/actions.ts';
  const SHARED_ORDERS = 'packages/shared/src/orders.ts';
  const ORDERS_SVC = 'apps/api/src/modules/orders/orders.service.ts';
  const EDITOR =
    'apps/web/components/orders/order-applications-editor.tsx';

  test('admin-create-order-form подключает OrderApplicationsEditor', () => {
    const src = read(FORM);
    expect(src).toMatch(/OrderApplicationsEditor/);
    expect(src).toMatch(
      /from '@\/components\/orders\/order-applications-editor'/,
    );
    // Блок «Нанесение» должен быть видимым в форме создания заказа.
    expect(src).toMatch(/admin-order-card--applications/);
    expect(src).toMatch(/>Нанесение</);
  });

  test('OrderApplicationsEditor пишет hidden input applicationsJson', () => {
    const src = read(EDITOR);
    expect(src).toMatch(/type="hidden"/);
    expect(src).toMatch(/applicationsJson/);
    // Editor умеет работать без initial и без обёртки <form> —
    // именно так его подключает create-form.
    expect(src).toMatch(/initial\?:\s*ApplicationRow\[\]/);
  });

  test('buildCreateDto читает applicationsJson и кладёт в DTO.applications', () => {
    const src = read(ACTIONS);
    expect(src).toMatch(/parseApplicationsJson/);
    expect(src).toMatch(/applicationsJson/);
    expect(src).toMatch(/OrderApplicationInputSchema/);
    // `applications` лежит в DTO как свойство; конкретный порядок
    // полей не фиксируем, чтобы соседние новые поля (например,
    // `customerUnitPrice` из этапа «Цена продажи за единицу»)
    // не ломали этот smoke-тест.
    expect(src).toMatch(/^\s*applications,?\s*$/m);
  });

  test('CreateOrderSchema принимает optional applications через OrderApplicationInputSchema', () => {
    const src = read(SHARED_ORDERS);
    expect(src).toMatch(
      /applications:\s*z\.array\(OrderApplicationInputSchema\)\.optional\(\)/,
    );
  });

  test('OrdersService.create создаёт OrderApplication[] в той же транзакции', () => {
    const src = read(ORDERS_SVC);
    // Nested-write `applications: { create: ... }` внутри tx.order.create
    // (атомарная операция вместе с самим заказом).
    expect(src).toMatch(/applications:\s*\n?[\s\S]{0,200}?\?\s*\{\s*create:/);
    // Дефолты на бэке: unit "шт", status "PLANNED" — те же, что у
    // OrderApplicationsService.replaceForOrder.
    expect(src).toMatch(/app\.unit\s*\?\?\s*'шт'/);
    expect(src).toMatch(/app\.status\s*\?\?\s*'PLANNED'/);
    // Quantity заворачиваем в Prisma.Decimal.
    expect(src).toMatch(/new Prisma\.Decimal\(app\.quantity\)/);
  });
});

// ---------------------------------------------------------------------------
// 8. Cut-readiness: stage CUT_PARTS / FINISHED_ITEM
// ---------------------------------------------------------------------------

describe('CutReadinessService — учитывает OrderApplication', () => {
  const SVC = 'apps/api/src/modules/cut-readiness/cut-readiness.service.ts';

  test('загружает order.applications и обрабатывает оба stage-а', () => {
    const src = read(SVC);
    expect(src).toMatch(/applications:\s*\{\s*select:/);
    // CUT_PARTS-ветка: BLOCKER при незаполненных параметрах,
    // WARNING при заполненных.
    expect(src).toMatch(/Нанесение на крое не заполнено/);
    expect(src).toMatch(/после кроя детали нужно отправить на нанесение/);
    // FINISHED_ITEM-ветка: INFO «крой не блокируется».
    expect(src).toMatch(/Нанесение на готовом изделии/);
    expect(src).toMatch(/крой не блокируется/i);
    // CANCELLED игнорируется.
    expect(src).toMatch(/status === ['"]CANCELLED['"]/);
  });

  test('shared/cut-readiness.ts содержит applications в sections (опционально)', () => {
    const src = read('packages/shared/src/cut-readiness.ts');
    expect(src).toMatch(/applications\?:\s*CutReadinessCheckDto\[\]/);
  });
});

// ---------------------------------------------------------------------------
// 9. WorkshopNeedsService — создаёт ORDER_APPLICATION needs
// ---------------------------------------------------------------------------

describe('WorkshopNeedsService — учитывает OrderApplication', () => {
  const SVC = 'apps/api/src/modules/workshop-needs/workshop-needs.service.ts';

  test('грузит order.applications и создаёт WorkshopNeed', () => {
    const src = read(SVC);
    expect(src).toMatch(/applications:\s*\{\s*orderBy:\s*\{\s*createdAt:\s*'asc'\s*\}/);
    expect(src).toMatch(/computeApplication\(/);
    expect(src).toMatch(/sourceType:\s*['"]ORDER_APPLICATION['"]/);
    expect(src).toMatch(/materialRole:\s*['"]APPLICATION['"]/);
    // CANCELLED строки пропускаем.
    expect(src).toMatch(/app\.status === ['"]CANCELLED['"]/);
  });
});

// ---------------------------------------------------------------------------
// 10. Tech-card UI больше не предлагает APPLICATION/PACKAGING как новые роли
// ---------------------------------------------------------------------------

describe('Tech-card form: APPLICATION недоступен как новая роль; PACKAGING — «Фурнитура»', () => {
  const FORM = 'apps/web/app/admin/tech-cards/tech-card-form.tsx';

  test('форма берёт роли из PATTERN_CATEGORY_PARAMETER_GROUPS (через TECH_CARD_MATERIAL_ROLE_KEYS)', () => {
    const src = read(FORM);
    // Этап «Доработка UI и контракта техкарты» (см. ТЗ §1):
    // источник ролей теперь — `PATTERN_CATEGORY_PARAMETER_GROUPS`
    // (включает PACKAGING, исключает APPLICATION). UI-метка для
    // PACKAGING — «Фурнитура» (через `getTechCardMaterialRoleLabel`).
    expect(src).toMatch(/TECH_CARD_MATERIAL_ROLE_KEYS/);
    expect(src).toMatch(/getTechCardMaterialRoleLabel\(/);
    // Legacy-fallback: если пришла строка с APPLICATION (или иной
    // unknown roleKey), показываем её как «(legacy)».
    expect(src).toMatch(/isKnownTechCardMaterialRoleKey/);
    expect(src).toMatch(/\(legacy\)/);
  });
});

// ---------------------------------------------------------------------------
// 11. Маршрут НЕ изменён
// ---------------------------------------------------------------------------

describe('Маршрут (ProductionRoute) не изменён', () => {
  test('OrderApplication не упоминается в RouteTemplate / OrderRouteStep', () => {
    const schema = read('prisma/schema.prisma');
    const blocks = ['model RouteTemplate', 'model RouteTemplateStep', 'model OrderRouteStep'];
    for (const head of blocks) {
      const start = schema.indexOf(head);
      expect(start).toBeGreaterThan(-1);
      const end = schema.indexOf('\n}', start);
      const block = schema.slice(start, end);
      expect(block).not.toMatch(/OrderApplication/);
      expect(block).not.toMatch(/applicationId/i);
    }
  });

  test('routes service / controller не упоминают OrderApplication', () => {
    const svc = read('apps/api/src/modules/routes/routes.service.ts');
    expect(svc).not.toMatch(/OrderApplication/);
    expect(svc).not.toMatch(/orderApplication/);
  });
});
