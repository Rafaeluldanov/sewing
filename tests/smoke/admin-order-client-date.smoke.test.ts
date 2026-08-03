/**
 * Smoke-тесты для задачи «Доработать заказы и даты» (MVP 1.1).
 *
 * Проверяем source-level:
 *   - Prisma-схема содержит `model Client` и поля `clientId` / `dueDate`
 *     на `Order` (миграция отдельно).
 *   - Backend-модуль клиентов подключён в `AppModule`.
 *   - Сторадж клиентов закрыт через RBAC и Zod, аудит-лог пишется.
 *   - Admin-сайдбар содержит раздел «Клиенты».
 *   - `AdminDateField` существует и реализует `Calendar` + `showPicker()`
 *     (с `focus()`-fallback'ом).
 *   - Новая форма создания заказа `/admin/orders/new`:
 *       - использует `AdminDateField` для `orderDate` и `dueDate`;
 *       - после этапа «Номенклатура = Лекала» (Admin Order Form 2.3)
 *         состоит из трёх «строк»: «Заказ + hero-превью», «Изделие
 *         + Производство» и широкого блока «4. План по размерам».
 *         Срок сдачи теперь внутри карточки «Заказ»; единственная
 *         видимая номенклатура — `patternItemId` («Номенклатура /
 *         лекало»), legacy `productId` из UI удалён;
 *       - не имеет кнопки «Добавить строку» — рендерит весь справочник
 *         размеров через `AdminSizeGrid`;
 *       - умеет показывать маршрут заказа через `AdminRouteSteps`.
 *   - Карточка заказа `/admin/orders/[id]/page.tsx` показывает
 *     клиента, срок сдачи и помечает просроченные заказы.
 *   - Backend-action создания заказа читает `clientId` / `dueDate`
 *     из FormData.
 *   - Старый `/orders/new` оставлен на месте (см. блок «НЕ ДЕЛАТЬ»
 *     в задаче), но также переведён на `AdminDateField`/`dueDate`.
 *
 * Все проверки делаем через чтение исходников: integration-сьюты с
 * реальным API и БД лежат в `tests/integration/clients.test.ts` и
 * `tests/integration/orders-client-due-date.test.ts`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(p: string): string {
  return readFileSync(path.join(repoRoot, p), 'utf8');
}

function exists(p: string): boolean {
  return existsSync(path.join(repoRoot, p));
}

// ---------------------------------------------------------------------------
// 1. Prisma schema + migration
// ---------------------------------------------------------------------------

describe('Prisma — Client model + Order.clientId/dueDate', () => {
  const schema = read('prisma/schema.prisma');

  test('schema.prisma содержит model Client со всеми полями', () => {
    expect(schema).toMatch(/model Client \{/);
    expect(schema).toMatch(/name\s+String/);
    expect(schema).toMatch(/phone\s+String\?/);
    expect(schema).toMatch(/email\s+String\?/);
    expect(schema).toMatch(/comment\s+String\?/);
    expect(schema).toMatch(/isActive\s+Boolean\s+@default\(true\)/);
    expect(schema).toMatch(/orders\s+Order\[\]/);
    expect(schema).toMatch(/@@index\(\[isActive\]\)/);
    expect(schema).toMatch(/@@index\(\[name\]\)/);
  });

  test('Order содержит clientId/client с onDelete: SetNull и dueDate', () => {
    expect(schema).toMatch(/clientId\s+String\?/);
    expect(schema).toMatch(/client\s+Client\?\s+@relation\([^)]*onDelete:\s*SetNull/);
    expect(schema).toMatch(/dueDate\s+DateTime\?/);
  });

  test('миграция _clients_and_order_due_date присутствует и создаёт нужные таблицы/колонки', () => {
    const migrationsDir = path.join(repoRoot, 'prisma/migrations');
    const dirs = readdirSync(migrationsDir).filter((d) => {
      const full = path.join(migrationsDir, d);
      return statSync(full).isDirectory() && d.includes('clients_and_order_due_date');
    });
    expect(dirs.length).toBeGreaterThan(0);
    const sql = readFileSync(
      path.join(migrationsDir, dirs[0]!, 'migration.sql'),
      'utf8',
    );
    expect(sql).toMatch(/CREATE TABLE "Client"/);
    expect(sql).toMatch(/ADD COLUMN "clientId"/);
    expect(sql).toMatch(/Order_clientId_fkey/);
    expect(sql).toMatch(/SET NULL/);
  });
});

// ---------------------------------------------------------------------------
// 2. Backend (NestJS) — clients module
// ---------------------------------------------------------------------------

describe('Backend — модуль /clients', () => {
  test('ClientsModule, ClientsService и ClientsController существуют', () => {
    expect(exists('apps/api/src/modules/clients/clients.module.ts')).toBe(true);
    expect(exists('apps/api/src/modules/clients/clients.service.ts')).toBe(true);
    expect(exists('apps/api/src/modules/clients/clients.controller.ts')).toBe(true);
  });

  test('AppModule подключает ClientsModule', () => {
    const src = read('apps/api/src/app.module.ts');
    expect(src).toMatch(/ClientsModule/);
  });

  test('ClientsController оформлен с RBAC ADMIN/SHOP_MANAGER и Zod-валидацией', () => {
    const src = read('apps/api/src/modules/clients/clients.controller.ts');
    expect(src).toMatch(/@Controller\('clients'\)/);
    expect(src).toMatch(/@Roles\([^)]*'ADMIN'/);
    expect(src).toMatch(/SHOP_MANAGER/);
    expect(src).toMatch(/CreateClientSchema/);
    expect(src).toMatch(/UpdateClientSchema/);
    expect(src).toMatch(/ZodValidationPipe/);
    // CRUD endpoints
    expect(src).toMatch(/@Get\(\)/);
    expect(src).toMatch(/@Post\(\)/);
    expect(src).toMatch(/@Get\(':id'\)/);
    expect(src).toMatch(/@Patch\(':id'\)/);
  });

  test('ClientsService пишет аудит-лог CLIENT_CREATED / CLIENT_UPDATED', () => {
    const src = read('apps/api/src/modules/clients/clients.service.ts');
    expect(src).toMatch(/CLIENT_CREATED/);
    expect(src).toMatch(/CLIENT_UPDATED/);
    // List по умолчанию не возвращает архивных.
    expect(src).toMatch(/isActive/);
  });

  test('OrdersService поддерживает clientId/dueDate и валидирует клиента', () => {
    const src = read('apps/api/src/modules/orders/orders.service.ts');
    expect(src).toMatch(/clientId/);
    expect(src).toMatch(/dueDate/);
    // Валидация: клиент существует и активен.
    expect(src).toMatch(/assertClientUsable/);
  });
});

// ---------------------------------------------------------------------------
// 3. Shared DTO / Zod schemas
// ---------------------------------------------------------------------------

describe('Shared — DTO/Schemas для клиентов и срока заказа', () => {
  test('packages/shared/src/clients.ts экспортирует CreateClientSchema/UpdateClientSchema/ClientDto', () => {
    expect(exists('packages/shared/src/clients.ts')).toBe(true);
    const src = read('packages/shared/src/clients.ts');
    expect(src).toMatch(/CreateClientSchema/);
    expect(src).toMatch(/UpdateClientSchema/);
    expect(src).toMatch(/ClientDto/);
  });

  test('packages/shared/src/index.ts реэкспортирует clients.ts', () => {
    const src = read('packages/shared/src/index.ts');
    expect(src).toMatch(/from '\.\/clients'/);
  });

  test('CreateOrderSchema/UpdateOrderSchema принимают clientId и dueDate', () => {
    const src = read('packages/shared/src/orders.ts');
    expect(src).toMatch(/clientId/);
    expect(src).toMatch(/dueDate/);
  });
});

// ---------------------------------------------------------------------------
// 4. Web — clients-api + admin sidebar + actions
// ---------------------------------------------------------------------------

describe('Web — clients-api, sidebar, server actions', () => {
  test('apps/web/lib/clients-api.ts реализует CRUD-обёртки', () => {
    expect(exists('apps/web/lib/clients-api.ts')).toBe(true);
    const src = read('apps/web/lib/clients-api.ts');
    expect(src).toMatch(/listClients/);
    expect(src).toMatch(/getClient/);
    expect(src).toMatch(/createClient/);
    expect(src).toMatch(/updateClient/);
  });

  test('admin-sidebar содержит раздел «Клиенты» с href /admin/clients', () => {
    const src = read('apps/web/components/admin-sidebar.tsx');
    expect(src).toMatch(/Клиенты/);
    expect(src).toMatch(/\/admin\/clients/);
  });

  test('actions /orders читают clientId и dueDate из FormData', () => {
    const src = read('apps/web/app/orders/actions.ts');
    expect(src).toMatch(/form\.get\('clientId'\)/);
    expect(src).toMatch(/form\.get\('dueDate'\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. Admin /admin/clients/* pages
// ---------------------------------------------------------------------------

describe('Admin /admin/clients — страницы и формы', () => {
  const PAGES = [
    'apps/web/app/admin/clients/page.tsx',
    'apps/web/app/admin/clients/new/page.tsx',
    'apps/web/app/admin/clients/[id]/page.tsx',
  ];

  test.each(PAGES)('%s существует', (p) => {
    expect(exists(p)).toBe(true);
  });

  test('list-страница использует AdminPageShell + AdminTable + AdminCard + AdminPagination', () => {
    const src = read('apps/web/app/admin/clients/page.tsx');
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/AdminCard/);
    expect(src).toMatch(/AdminTable/);
    expect(src).toMatch(/AdminPagination/);
  });

  test('detail-страница содержит AdminTechInfo и AdminPageShell', () => {
    const src = read('apps/web/app/admin/clients/[id]/page.tsx');
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/AdminTechInfo/);
    expect(src).toMatch(/AdminCard/);
  });

  test('actions: createClientAction и updateClientAction существуют', () => {
    expect(exists('apps/web/app/admin/clients/actions.ts')).toBe(true);
    const src = read('apps/web/app/admin/clients/actions.ts');
    expect(src).toMatch(/createClientAction/);
    expect(src).toMatch(/updateClientAction/);
  });
});

// ---------------------------------------------------------------------------
// 6. AdminDateField design-system
// ---------------------------------------------------------------------------

describe('AdminDateField — design-system', () => {
  test('компонент существует и реэкспортируется через components/admin', () => {
    expect(exists('apps/web/components/admin/admin-date-field.tsx')).toBe(true);
    const indexSrc = read('apps/web/components/admin/index.ts');
    expect(indexSrc).toMatch(/AdminDateField/);
  });

  test('AdminDateField использует Calendar из lucide-react и showPicker() с focus() fallback', () => {
    const src = read('apps/web/components/admin/admin-date-field.tsx');
    expect(src).toMatch(/from 'lucide-react'/);
    expect(src).toMatch(/Calendar/);
    expect(src).toMatch(/type="date"/);
    expect(src).toMatch(/showPicker/);
    expect(src).toMatch(/focus\(\)/);
  });

  test('CSS-классы admin-date-field*** определены в globals.css', () => {
    const css = read('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-date-field\b/);
    expect(css).toMatch(/\.admin-date-field__input\b/);
    expect(css).toMatch(/\.admin-date-field__button\b/);
  });
});

// ---------------------------------------------------------------------------
// 7. /admin/orders/new — Order Create Form 2.0
// ---------------------------------------------------------------------------

describe('/admin/orders/new — Admin Order Form 2.1 + AdminDateField', () => {
  const formSrc = read(
    'apps/web/app/admin/orders/new/order-create-wizard.tsx',
  );

  test('шаг «Клиент» использует AdminDateField для срока сдачи', () => {
    const src = read('apps/web/app/admin/orders/new/order-create-wizard.tsx');
    expect(src).toMatch(/AdminDateField/);
    // `orderDate` мастер не спрашивает — подставляет «сегодня» из
    // серверного пропса `today` (TZ Москвы), поэтому поля в UI нет.
    expect(src).toMatch(/orderDate: today/);
    expect(src).toMatch(/name="dueDate"/);
  });

  test('шаг «Клиент» собирает управленческие поля заказа', () => {
    const src = read('apps/web/app/admin/orders/new/order-create-wizard.tsx');
    // Клиент обязателен — это первый вопрос мастера.
    expect(src).toMatch(/setClientId/);
    expect(src).toMatch(/Выберите клиента/);
    expect(src).toMatch(/setCompanyDivisionId/);
    expect(src).toMatch(/setCustomerUnitPrice/);
    expect(src).toMatch(/setComment/);
    // Редкие настройки свёрнуты, чтобы не выталкивать выбор изделия.
    expect(src).toMatch(/Ещё настройки/);
  });

  test('маршрут заказа рендерится через AdminRouteSteps (preview)', () => {
    expect(formSrc).toMatch(/AdminRouteSteps/);
  });

  test('размеры рендерятся компактным SizePlanSelector, без add/remove rows', () => {
    // Polish-итерация «План по размерам — модалка»: видимая сетка
    // `AdminSizeGrid` ушла в read-only превью карточки заказа,
    // /admin/orders/new использует `SizePlanSelector` (см.
    // `admin-order-layout.smoke.test.ts`). FormData-имя `qty[<sizeId>]`
    // теперь приходит из hidden inputs формы. Здесь достаточно
    // убедиться, что нет старой таблицы / Trash2 / кнопки
    // «Добавить строку» — детальные смоки в layout-тесте.
    expect(formSrc).toMatch(/SizePlanSelector/);
    expect(formSrc).not.toMatch(/AdminSizeGrid/);
    expect(formSrc).not.toMatch(/Добавить строку/);
    expect(formSrc).not.toMatch(/Trash2/);
    expect(formSrc).not.toMatch(/admin-table/);
  });

  test('page.tsx подгружает clients и routeTemplates для формы', () => {
    const pageSrc = read('apps/web/app/admin/orders/new/page.tsx');
    expect(pageSrc).toMatch(/listClients/);
    expect(pageSrc).toMatch(/listRouteTemplates/);
  });
});

// ---------------------------------------------------------------------------
// 8. /admin/orders/[id] — карточка заказа
// ---------------------------------------------------------------------------

describe('/admin/orders/[id] — клиент, срок и маршрут в карточке', () => {
  const src = read('apps/web/app/admin/orders/[id]/page.tsx');

  test('карточка показывает клиента, срок сдачи в шапке через OrderManagementHeader', () => {
    // Order management redesign: клиент и срок сдачи теперь живут
    // в `OrderManagementHeader` — компактном summary-блоке, видимом
    // на всех вкладках. Inline-edit «Основное» больше не часть
    // управленческой карточки (это admin/orders/[id]/edit).
    expect(src).toMatch(/OrderManagementHeader/);
    const headerSrc = read(
      'apps/web/components/orders/view/order-management-header.tsx',
    );
    // В шапке есть поля «Клиент», «Дата заказа» и «Срок сдачи»
    // (последнее раньше называлось «Срок»; даты подняты в шапку из
    // удалённой вкладки «План»).
    expect(headerSrc).toMatch(/label="Клиент"/);
    expect(headerSrc).toMatch(/label="Дата заказа"/);
    expect(headerSrc).toMatch(/label="Срок сдачи"/);
    // «Просрочен» — это `deadline.status === 'OVERDUE'`, бейдж
    // приходит из backend через `deadline.label / deadline.tone`.
    expect(headerSrc).toMatch(/deadline\b/);
  });

  test('маршрут заказа рендерится через AdminRouteSteps в OrderProductionTab', () => {
    // Маршрут живёт во вкладке «Производство» (вкладка «План»
    // удалена). На самой странице импорт больше не нужен.
    const productionSrc = read(
      'apps/web/components/orders/view/tabs/order-production-tab.tsx',
    );
    expect(productionSrc).toMatch(/AdminRouteSteps/);
  });

  test('используется AdminPageShell + OrderWorkspaceLayout', () => {
    expect(src).toMatch(/AdminPageShell/);
    expect(src).toMatch(/OrderWorkspaceLayout/);
  });
});

// ---------------------------------------------------------------------------
// 9. Legacy /orders/new + filters use AdminDateField
// ---------------------------------------------------------------------------

describe('Legacy /orders/new и admin date filters', () => {
  test('/orders/new НЕ удалён', () => {
    expect(exists('apps/web/app/orders/new/page.tsx')).toBe(true);
    expect(exists('apps/web/app/orders/new/new-order-form.tsx')).toBe(true);
  });

  test('/admin/production-cost фильтры периода переведены на AdminDateField', () => {
    const src = read('apps/web/app/admin/production-cost/page.tsx');
    expect(src).toMatch(/AdminDateField/);
    expect(src).toMatch(/name="dateFrom"/);
    expect(src).toMatch(/name="dateTo"/);
  });

  test('/orders/[id]/edit использует AdminDateField и поддерживает dueDate/clientId', () => {
    const src = read('apps/web/app/orders/[id]/edit/edit-order-form.tsx');
    expect(src).toMatch(/AdminDateField/);
    expect(src).toMatch(/name="orderDate"/);
    expect(src).toMatch(/name="dueDate"/);
    expect(src).toMatch(/name="clientId"/);
  });

  test('новый паспорт /orders/[id]/passports/new использует AdminDateField', () => {
    const src = read(
      'apps/web/app/orders/[id]/passports/new/new-passport-form.tsx',
    );
    expect(src).toMatch(/AdminDateField/);
    expect(src).toMatch(/name="cutDate"/);
  });
});
