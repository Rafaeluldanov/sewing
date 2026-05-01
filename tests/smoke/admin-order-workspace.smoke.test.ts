/**
 * Smoke-тесты «Order workspace v2» — рефакторинг карточки заказа в
 * рабочий блок «Основное» + распределение по вкладкам.
 *
 * Цель — зафиксировать, что `/admin/orders/new`, `/admin/orders/[id]`
 * и `/admin/orders/[id]/edit` используют единый `OrderWorkspaceLayout`
 * с одним и тем же `OrderHeroCard` и одинаковым набором
 * `OrderDetailTabs`. Hero — не «инфо-простыня», а рабочий блок:
 *   - редактируемые поля «Основное» (подразделение, срок, клиент,
 *     цена + валюта, комментарий);
 *   - короткие KPI;
 *   - workflow-actions (Перевести в расчёт, Запустить в производство,
 *     Пересчитать план и т.п.).
 *
 * Hero **сознательно не дублирует** содержимое вкладки «Продукция»
 * (превью лекала, артикул, размерная матрица, нанесения).
 *
 * Все проверки — source-level: React-рендера в vitest нет, но
 * имена компонентов / className / лейблы / порядок импортов —
 * это контракт, на котором мы держим консистентность layout-а
 * между тремя страницами.
 *
 * Backend / Prisma / DTO / server actions сюда не приходят: это
 * UI-only refactor.
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
// 1. Workspace components — все компоненты на месте
// ---------------------------------------------------------------------------

describe('OrderWorkspaceLayout / OrderHeroCard / OrderDetailTabs — components exist', () => {
  test('файлы компонентов существуют по ожидаемым путям', () => {
    expect(
      exists('apps/web/components/orders/order-workspace-layout.tsx'),
    ).toBe(true);
    expect(exists('apps/web/components/orders/order-hero-card.tsx')).toBe(
      true,
    );
    expect(exists('apps/web/components/orders/order-detail-tabs.tsx')).toBe(
      true,
    );
    expect(
      exists('apps/web/components/orders/order-detail-tabs-config.ts'),
    ).toBe(true);
    expect(exists('apps/web/components/orders/order-basics-form.tsx')).toBe(
      true,
    );
    expect(
      exists('apps/web/components/orders/order-recommendations-card.tsx'),
    ).toBe(true);
  });

  test('OrderWorkspaceLayout рендерит hero / tabs / body как единый блок', () => {
    const src = read('apps/web/components/orders/order-workspace-layout.tsx');
    expect(src).toMatch(/order-workspace\b/);
    expect(src).toMatch(/order-workspace__hero/);
    expect(src).toMatch(/order-workspace__tabs/);
    expect(src).toMatch(/order-workspace__body/);
    expect(src).toMatch(/data-mode=\{mode\}/);
    expect(src).toMatch(/OrderTabEmptyState/);
    expect(src).toMatch(/order-tab-empty-state/);
  });

  test('OrderHeroCard поддерживает три mode-а и редактируемое «Основное»', () => {
    const src = read('apps/web/components/orders/order-hero-card.tsx');
    expect(src).toMatch(/OrderHeroMode\s*=\s*'create'\s*\|\s*'view'\s*\|\s*'edit'/);
    // Корневой класс + mode-modifier.
    expect(src).toMatch(/order-hero-card\b/);
    expect(src).toMatch(/order-hero-card--\$\{mode\}/);
    // Hero-блок «Основное» — управленческие поля живут в basics-слоте.
    expect(src).toMatch(/order-hero-card__basic-form\b/);
    expect(src).toMatch(/order-hero-card__identity\b/);
    expect(src).toMatch(/order-hero-card__status\b/);
    expect(src).toMatch(/order-hero-card__kpis\b/);
    expect(src).toMatch(/order-hero-card__actions\b/);
    // Create-mode показывает заглушки «Новый заказ» / «Черновик».
    expect(src).toMatch(/'Новый заказ'/);
    expect(src).toMatch(/'Черновик'/);
    // Hero НЕ должен содержать превью / большое изображение лекала
    // (это переехало во вкладку «Продукция»).
    expect(src).not.toMatch(/order-hero-card__preview\b/);
    expect(src).not.toMatch(/order-hero-card__image\b/);
  });

  test('OrderHeroCard hero не содержит размерную матрицу или нанесения', () => {
    const src = read('apps/web/components/orders/order-hero-card.tsx');
    // ТЗ: Hero НЕ должен дублировать вкладку «Продукция».
    expect(src).not.toMatch(/AdminSizeGrid/);
    expect(src).not.toMatch(/OrderApplicationsEditor/);
    expect(src).not.toMatch(/OrderApplicationsCard/);
  });

  test('OrderDetailTabs использует ORDER_DETAIL_TABS как единственный источник правды', () => {
    const src = read('apps/web/components/orders/order-detail-tabs.tsx');
    expect(src).toMatch(
      /from '\.\/order-detail-tabs-config'/,
    );
    expect(src).toMatch(/ORDER_DETAIL_TABS\.map/);
    expect(src).toMatch(/order-detail-tabs\b/);
    expect(src).toMatch(/order-detail-tabs__link\b/);
    expect(src).toMatch(/order-detail-tabs__link--active/);
    expect(src).toMatch(/order-detail-tabs__link--disabled/);
    expect(src).toMatch(/aria-disabled/);
    expect(src).toMatch(/Доступно после создания заказа/);
    expect(src).toMatch(/aria-current=\{isActive \? 'page' : undefined\}/);
  });

  test('ORDER_DETAIL_TABS содержит ровно 6 вкладок в фиксированном порядке', () => {
    const src = read(
      'apps/web/components/orders/order-detail-tabs-config.ts',
    );
    const expected = [
      "id: 'product'",
      "id: 'materials'",
      "id: 'operations'",
      "id: 'logistics'",
      "id: 'summary'",
      "id: 'recommendations'",
    ];
    let prev = -1;
    for (const marker of expected) {
      const idx = src.indexOf(marker);
      expect(idx, `tab ${marker} not found`).toBeGreaterThan(-1);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
    expect(src).toMatch(/label: 'Продукция'/);
    expect(src).toMatch(/label: 'Материалы'/);
    expect(src).toMatch(/label: 'Операции'/);
    expect(src).toMatch(/label: 'Логистика'/);
    expect(src).toMatch(/label: 'Сводно по заказу'/);
    expect(src).toMatch(/label: 'Рекомендации по заказу'/);
    expect(src).toMatch(/export function parseOrderDetailTab/);
  });
});

// ---------------------------------------------------------------------------
// 2. /admin/orders/new — create mode unified layout
// ---------------------------------------------------------------------------

describe('/admin/orders/new — использует OrderWorkspaceLayout mode="create"', () => {
  const formSrc = read(
    'apps/web/app/admin/orders/new/admin-create-order-form.tsx',
  );

  test('форма импортирует и рендерит OrderWorkspaceLayout / OrderHeroCard / OrderDetailTabs', () => {
    expect(formSrc).toMatch(/OrderWorkspaceLayout/);
    expect(formSrc).toMatch(/OrderHeroCard/);
    expect(formSrc).toMatch(/OrderDetailTabs/);
    expect(formSrc).toMatch(
      /from '@\/components\/orders\/order-workspace-layout'/,
    );
    expect(formSrc).toMatch(
      /from '@\/components\/orders\/order-hero-card'/,
    );
    expect(formSrc).toMatch(
      /from '@\/components\/orders\/order-detail-tabs'/,
    );
    expect(formSrc).toMatch(
      /from '@\/components\/orders\/order-detail-tabs-config'/,
    );
  });

  test('hero «Основное» содержит все управленческие поля (division/dueDate/clientId/price/currency/comment)', () => {
    expect(formSrc).toMatch(/<OrderHeroCard\s*[\s\S]*?mode="create"/);
    // Поля «Основное» переехали в hero. Имена FormData-ключей сохранены.
    expect(formSrc).toMatch(/name="division"/);
    expect(formSrc).toMatch(/name="dueDate"/);
    expect(formSrc).toMatch(/name="clientId"/);
    expect(formSrc).toMatch(/name="customerUnitPrice"/);
    expect(formSrc).toMatch(/name="customerCurrency"/);
    expect(formSrc).toMatch(/name="comment"/);
    // Submit-кнопка «Создать заказ» (workflow action в hero).
    expect(formSrc).toMatch(/Создать заказ/);
  });

  test('tabs передаются через OrderDetailTabs с orderId={null} и активной "product"', () => {
    expect(formSrc).toMatch(/<OrderDetailTabs/);
    expect(formSrc).toMatch(/orderId=\{null\}/);
    expect(formSrc).toMatch(/activeTab="product"/);
    expect(formSrc).toMatch(/disabledTabs=\{disabledTabs\}/);
    expect(formSrc).toMatch(
      /ORDER_DETAIL_TABS\.filter\([\s\S]*?t\.id !== 'product'/,
    );
  });

  test('Product tab content содержит patternItemId / color / size matrix / route / techCard / applications', () => {
    expect(formSrc).toMatch(/order-product-tab/);
    expect(formSrc).toMatch(/name="patternItemId"/);
    expect(formSrc).toMatch(/name="color"/);
    expect(formSrc).toMatch(/name="techCardId"/);
    expect(formSrc).toMatch(/name="routeTemplateId"/);
    // Размерная матрица собирается через hidden inputs (контракт сохранён).
    expect(formSrc).toMatch(/name=\{`qty\[\$\{s\.id\}\]`\}/);
    // Нанесения — OrderApplicationsEditor.
    expect(formSrc).toMatch(/OrderApplicationsEditor/);
  });

  test('FormData-контракт createOrderAction не сломан', () => {
    expect(formSrc).toMatch(/createOrderAction/);
    expect(formSrc).toMatch(/name="orderDate"/);
    expect(formSrc).toMatch(/name="dueDate"/);
    expect(formSrc).toMatch(/name="clientId"/);
    expect(formSrc).toMatch(/name="division"/);
    expect(formSrc).toMatch(/name="patternItemId"/);
    expect(formSrc).toMatch(/name="techCardId"/);
    expect(formSrc).toMatch(/name="routeTemplateId"/);
    expect(formSrc).toMatch(/name="color"/);
    expect(formSrc).toMatch(/name="comment"/);
    expect(formSrc).toMatch(/name="customerUnitPrice"/);
    expect(formSrc).toMatch(/name="customerCurrency"/);
    expect(formSrc).toMatch(/name=\{`qty\[\$\{s\.id\}\]`\}/);
    expect(formSrc).toMatch(/value="admin"/);
  });

  test('всё внутри одного <form action={createOrderAction}>', () => {
    // Hero и Product tab лежат внутри одного `<form>` — иначе FormData
    // не соберёт оба набора полей. Проверяем, что в файле один <form>.
    const formMatches = formSrc.match(/<form\s+action=\{formAction\}/g) ?? [];
    expect(formMatches.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. /admin/orders/[id] — management view (compact header + action center +
// 7 фокусных вкладок, включая dedicated финансовую «Сводно по заказу»)
// ---------------------------------------------------------------------------

describe('/admin/orders/[id] — управленческая карточка (header + action center + 7 вкладок)', () => {
  const pageSrc = read('apps/web/app/admin/orders/[id]/page.tsx');

  test('страница импортирует OrderWorkspaceLayout / новые view-компоненты', () => {
    expect(pageSrc).toMatch(/OrderWorkspaceLayout/);
    expect(pageSrc).toMatch(
      /from '@\/components\/orders\/order-workspace-layout'/,
    );
    expect(pageSrc).toMatch(/OrderManagementHeader/);
    expect(pageSrc).toMatch(/OrderActionCenter/);
    expect(pageSrc).toMatch(/OrderViewTabs/);
    expect(pageSrc).toMatch(
      /from '@\/components\/orders\/view\/order-view-tabs-config'/,
    );
  });

  test('страница использует mode="view"', () => {
    expect(pageSrc).toMatch(/<OrderWorkspaceLayout\s*[\s\S]*?mode="view"/);
    // Старый OrderHeroCard / OrderBasicsForm в hero вкладки теперь
    // переехали в `OrderManagementHeader` — сюда они больше не
    // импортируются.
    expect(pageSrc).not.toMatch(/<OrderHeroCard\b/);
    expect(pageSrc).not.toMatch(/<OrderBasicsForm\b/);
  });

  test('страница парсит query param ?tab= через parseOrderViewTab', () => {
    expect(pageSrc).toMatch(/parseOrderViewTab/);
    expect(pageSrc).toMatch(/searchParams\?\.tab/);
    expect(pageSrc).toMatch(/activeTab=\{activeTab\}/);
    expect(pageSrc).toMatch(/orderId=\{order\.id\}/);
  });

  test('страница рендерит ровно 7 management-вкладок', () => {
    for (const tab of [
      'production',
      'passports',
      'plan',
      'operations',
      'costSummary',
      'needs',
      'history',
    ]) {
      expect(pageSrc).toMatch(new RegExp(`activeTab === '${tab}'`));
    }
    // Старых вкладок «product / materials / logistics / summary /
    // recommendations» как самостоятельных tab-веток на этой странице
    // больше нет — данные перенесены в шапку, action center или
    // собраны в новых вкладках. Это и есть «нет вкладки Обзор» и
    // «без дублирования таблиц/метрик» из ТЗ. «Операции» вернулись
    // как самостоятельная вкладка (см. отдельный describe ниже).
    // Финансовая вкладка теперь живёт под id `costSummary` — а не
    // под старым generic `summary`, который раньше создавал
    // путаницу.
    expect(pageSrc).not.toMatch(/activeTab === 'product'/);
    expect(pageSrc).not.toMatch(/activeTab === 'summary'/);
    expect(pageSrc).not.toMatch(/activeTab === 'logistics'/);
    expect(pageSrc).not.toMatch(/activeTab === 'recommendations'/);
    expect(pageSrc).not.toMatch(/activeTab === 'materials'/);
  });

  test('каждая вкладка делегируется в свой компонент `view/tabs/...`', () => {
    expect(pageSrc).toMatch(
      /activeTab === 'production'[\s\S]*?<OrderProductionTab\b/,
    );
    expect(pageSrc).toMatch(
      /activeTab === 'passports'[\s\S]*?<OrderPassportsTab\b/,
    );
    expect(pageSrc).toMatch(
      /activeTab === 'plan'[\s\S]*?<OrderPlanTab\b/,
    );
    expect(pageSrc).toMatch(
      /activeTab === 'operations'[\s\S]*?<OrderOperationsTab\b/,
    );
    expect(pageSrc).toMatch(
      /activeTab === 'costSummary'[\s\S]*?<OrderSummaryTab\b/,
    );
    expect(pageSrc).toMatch(
      /activeTab === 'needs'[\s\S]*?<OrderNeedsTab\b/,
    );
    expect(pageSrc).toMatch(
      /activeTab === 'history'[\s\S]*?<OrderHistoryTab\b/,
    );
    expect(pageSrc).toMatch(
      /from '@\/components\/orders\/view\/tabs\/order-production-tab'/,
    );
    expect(pageSrc).toMatch(
      /from '@\/components\/orders\/view\/tabs\/order-passports-tab'/,
    );
    expect(pageSrc).toMatch(
      /from '@\/components\/orders\/view\/tabs\/order-plan-tab'/,
    );
    // Операции — профильный компонент, переехавший из старой раскладки;
    // живёт в `components/orders/tabs/`, не в `components/orders/view/tabs/`.
    expect(pageSrc).toMatch(
      /from '@\/components\/orders\/tabs\/order-operations-tab'/,
    );
    // «Сводно по заказу» — wrapper над `OrderSummaryUnifiedTable`,
    // тоже из `components/orders/tabs/`.
    expect(pageSrc).toMatch(
      /from '@\/components\/orders\/tabs\/order-summary-tab'/,
    );
    expect(pageSrc).toMatch(
      /from '@\/components\/orders\/view\/tabs\/order-needs-tab'/,
    );
    expect(pageSrc).toMatch(
      /from '@\/components\/orders\/view\/tabs\/order-history-tab'/,
    );
  });

  test('hero-слот не содержит таблиц / списков паспортов / size-breakdown', () => {
    // Шапка должна быть только summary + action center — никаких
    // таблиц материалов, операций или паспортов.
    const heroStart = pageSrc.indexOf('hero={');
    const heroEnd = pageSrc.indexOf('tabs={', heroStart);
    expect(heroStart).toBeGreaterThan(-1);
    expect(heroEnd).toBeGreaterThan(heroStart);
    const heroBlock = pageSrc.slice(heroStart, heroEnd);
    expect(heroBlock).not.toMatch(/<OrderMaterialsUnifiedTable\b/);
    expect(heroBlock).not.toMatch(/<OrderOperationsUnifiedTable\b/);
    expect(heroBlock).not.toMatch(/<OrderSummaryUnifiedTable\b/);
    expect(heroBlock).not.toMatch(/<PassportsTable\b/);
    expect(heroBlock).not.toMatch(/<AdminSizeGrid\b/);
  });

  test('управленческие действия живут в OrderManagementHeader, action-center — в OrderActionCenter', () => {
    const headerSrc = read(
      'apps/web/components/orders/view/order-management-header.tsx',
    );
    expect(headerSrc).toMatch(/StartCalculationButton/);
    expect(headerSrc).toMatch(/StartProductionButton/);
    expect(headerSrc).toMatch(/RecalculateOperationPlanButton/);
    expect(headerSrc).toMatch(/ReopenCalculationButton/);
    expect(headerSrc).toMatch(/CompleteOrderButton/);
    expect(headerSrc).toMatch(/CancelOrderButton/);
    // Кнопка «Выпустить паспорт» — ссылка, как было раньше в legacy.
    expect(headerSrc).toMatch(/Выпустить паспорт/);
    expect(headerSrc).toMatch(
      /href=\{`\/orders\/\$\{order\.id\}\/passports\/new`\}/,
    );
    // Action center — алерты с глубокими ссылками в нужную вкладку.
    const acSrc = read(
      'apps/web/components/orders/view/order-action-center.tsx',
    );
    expect(acSrc).toMatch(/order-action-center/);
    expect(acSrc).toMatch(/buildAlerts/);
  });
});

// ---------------------------------------------------------------------------
// 3a. ORDER_VIEW_TABS — единственный источник правды по management-вкладкам
// ---------------------------------------------------------------------------

describe('ORDER_VIEW_TABS — 7 management-вкладок в фиксированном порядке', () => {
  test('конфиг содержит ровно 7 вкладок и поддерживает parseOrderViewTab', () => {
    const src = read(
      'apps/web/components/orders/view/order-view-tabs-config.ts',
    );
    // «Операции» возвращены между «План» и «Сводно по заказу»;
    // «Сводно по заказу» (`costSummary`) — отдельная финансовая
    // вкладка между «Операции» и «Потребности». Менеджер читает
    // карточку как «факт → объекты → план → операции → деньги →
    // обеспечение → аудит». Идентификатор `costSummary` (а не
    // `summary`) сознательно отделён от старого generic-summary,
    // который раньше создавал путаницу.
    const expected = [
      "id: 'production'",
      "id: 'passports'",
      "id: 'plan'",
      "id: 'operations'",
      "id: 'costSummary'",
      "id: 'needs'",
      "id: 'history'",
    ];
    let prev = -1;
    for (const marker of expected) {
      const idx = src.indexOf(marker);
      expect(idx, `tab ${marker} not found`).toBeGreaterThan(-1);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
    expect(src).toMatch(/label: 'Производство'/);
    expect(src).toMatch(/label: 'Паспорта'/);
    expect(src).toMatch(/label: 'План'/);
    expect(src).toMatch(/label: 'Операции'/);
    expect(src).toMatch(/label: 'Сводно по заказу'/);
    expect(src).toMatch(/label: 'Потребности'/);
    expect(src).toMatch(/label: 'История'/);
    expect(src).toMatch(/export function parseOrderViewTab/);
  });
});

// ---------------------------------------------------------------------------
// 4. /admin/orders/[id]/edit — edit mode unified layout
// ---------------------------------------------------------------------------

describe('/admin/orders/[id]/edit — использует OrderWorkspaceLayout mode="edit"', () => {
  const formSrc = read(
    'apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx',
  );

  test('форма импортирует и рендерит OrderWorkspaceLayout / OrderHeroCard / OrderDetailTabs', () => {
    expect(formSrc).toMatch(/OrderWorkspaceLayout/);
    expect(formSrc).toMatch(/OrderHeroCard/);
    expect(formSrc).toMatch(/OrderDetailTabs/);
    expect(formSrc).toMatch(
      /from '@\/components\/orders\/order-workspace-layout'/,
    );
    expect(formSrc).toMatch(
      /from '@\/components\/orders\/order-hero-card'/,
    );
    expect(formSrc).toMatch(
      /from '@\/components\/orders\/order-detail-tabs'/,
    );
  });

  test('форма использует mode="edit" и titleOverride', () => {
    expect(formSrc).toMatch(/<OrderWorkspaceLayout\s*[\s\S]*?mode="edit"/);
    expect(formSrc).toMatch(/<OrderHeroCard\s*[\s\S]*?mode="edit"/);
    expect(formSrc).toMatch(/titleOverride=/);
  });

  test('OrderDetailTabs передаёт productEditHref для активной "product"', () => {
    expect(formSrc).toMatch(/<OrderDetailTabs/);
    expect(formSrc).toMatch(/orderId=\{order\.id\}/);
    expect(formSrc).toMatch(/activeTab="product"/);
    expect(formSrc).toMatch(/productEditHref/);
  });

  test('FormData-контракт updateAdminOrderAction не сломан', () => {
    expect(formSrc).toMatch(/updateAdminOrderAction/);
    expect(formSrc).toMatch(/name="status"/);
    expect(formSrc).toMatch(/name="orderDate"/);
    expect(formSrc).toMatch(/name="dueDate"/);
    expect(formSrc).toMatch(/name="clientId"/);
    expect(formSrc).toMatch(/name="patternItemId"/);
    expect(formSrc).toMatch(/name="division"/);
    expect(formSrc).toMatch(/name="color"/);
    expect(formSrc).toMatch(/name="comment"/);
    expect(formSrc).toMatch(/name="techCardId"/);
    expect(formSrc).toMatch(/name="routeTemplateId"/);
    expect(formSrc).toMatch(/name="customerUnitPrice"/);
    expect(formSrc).toMatch(/name="customerCurrency"/);
    expect(formSrc).toMatch(/AdminSizeGrid/);
  });
});

// ---------------------------------------------------------------------------
// 5. CSS — order-workspace / order-hero-card / order-detail-tabs / panels
// ---------------------------------------------------------------------------

describe('CSS unified workspace — globals.css содержит ключевые классы', () => {
  const css = read('apps/web/app/globals.css');

  test('order-workspace классы определены', () => {
    expect(css).toMatch(/\.order-workspace\s*\{/);
    expect(css).toMatch(/\.order-workspace__hero\b/);
    expect(css).toMatch(/\.order-workspace__tabs\b/);
    expect(css).toMatch(/\.order-workspace__body\b/);
  });

  test('order-hero-card классы определены — basic-form / kpis / actions', () => {
    expect(css).toMatch(/\.order-hero-card\s*\{/);
    expect(css).toMatch(/\.order-hero-card--create\b/);
    expect(css).toMatch(/\.order-hero-card--view\b/);
    expect(css).toMatch(/\.order-hero-card--edit\b/);
    expect(css).toMatch(/\.order-hero-card__basic-form\b/);
    expect(css).toMatch(/\.order-hero-card__basic-grid\b/);
    expect(css).toMatch(/\.order-hero-card__field\b/);
    expect(css).toMatch(/\.order-hero-card__field--price\b/);
    expect(css).toMatch(/\.order-hero-card__identity\b/);
    expect(css).toMatch(/\.order-hero-card__status\b/);
    expect(css).toMatch(/\.order-hero-card__kpis\b/);
    expect(css).toMatch(/\.order-hero-card__actions\b/);
  });

  test('order-detail-tabs классы определены', () => {
    expect(css).toMatch(/\.order-detail-tabs\s*\{/);
    expect(css).toMatch(/\.order-detail-tabs__link\b/);
    expect(css).toMatch(/\.order-detail-tabs__link--active\b/);
    expect(css).toMatch(/\.order-detail-tabs__link--disabled\b/);
  });

  test('order-tab-empty-state класс определён', () => {
    expect(css).toMatch(/\.order-tab-empty-state\s*\{/);
    expect(css).toMatch(/\.order-tab-empty-state__title\b/);
    expect(css).toMatch(/\.order-tab-empty-state__hint\b/);
  });

  test('order-tab-panel и focused tab классы определены', () => {
    expect(css).toMatch(/\.order-tab-panel\s*\{/);
    expect(css).toMatch(/\.order-product-tab\b/);
    expect(css).toMatch(/\.order-materials-tab\b/);
    expect(css).toMatch(/\.order-operations-tab\b/);
    expect(css).toMatch(/\.order-logistics-tab\b/);
    expect(css).toMatch(/\.order-summary-tab\b/);
    expect(css).toMatch(/\.order-recommendations-tab\b/);
  });

  test('media query для узкого экрана сжимает hero и kpi', () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.order-hero-card\b/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Single source of truth — ORDER_DETAIL_TABS (для create/edit-форм)
// ---------------------------------------------------------------------------

describe('ORDER_DETAIL_TABS — единственный источник правды по вкладкам create/edit', () => {
  test('константа определена в одном файле и импортируется create/edit-формами', () => {
    const configPath =
      'apps/web/components/orders/order-detail-tabs-config.ts';
    expect(exists(configPath)).toBe(true);

    const tabsSrc = read('apps/web/components/orders/order-detail-tabs.tsx');
    expect(tabsSrc).toMatch(
      /from '\.\/order-detail-tabs-config'/,
    );

    // /admin/orders/new + /admin/orders/[id]/edit используют ORDER_DETAIL_TABS
    // (active = product). Управленческая карточка `/admin/orders/[id]` теперь
    // живёт на отдельном `ORDER_VIEW_TABS` (5 вкладок) — см. отдельный
    // describe выше; это сознательное разделение, чтобы edit-форма и
    // view-режим не делили один и тот же набор вкладок.
    const newSrc = read(
      'apps/web/app/admin/orders/new/admin-create-order-form.tsx',
    );
    expect(newSrc).toMatch(
      /from '@\/components\/orders\/order-detail-tabs-config'/,
    );
  });

  test('ни одна страница не дублирует список вкладок руками', () => {
    const configSrc = read(
      'apps/web/components/orders/order-detail-tabs-config.ts',
    );
    expect(configSrc).toMatch(/Продукция/);
    expect(configSrc).toMatch(/Сводно по заказу/);

    const newSrc = read(
      'apps/web/app/admin/orders/new/admin-create-order-form.tsx',
    );
    const editSrc = read(
      'apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx',
    );
    for (const src of [newSrc, editSrc]) {
      expect(src).not.toMatch(/'Продукция',\s*'Материалы',\s*'Операции',\s*'Логистика'/);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Backend / Prisma не задействованы (UI-only refactor)
// ---------------------------------------------------------------------------

describe('order-workspace unification — UI-only refactor', () => {
  test('createOrderAction / updateOrderAction / completeOrderCalculationAction не изменены по контракту', () => {
    const src = read('apps/web/app/orders/actions.ts');
    expect(src).toMatch(/export async function createOrderAction/);
    expect(src).toMatch(/export async function updateOrderAction/);
    expect(src).toMatch(/export async function completeOrderCalculationAction/);
    expect(src).toMatch(/export async function reopenOrderCalculationAction/);
    expect(src).toMatch(/export async function startOrderAction/);
    expect(src).toMatch(/redirect\(`\/admin\/orders\/\$\{created\.id\}`\)/);
  });

  test('updateAdminOrderAction в edit-page не изменён', () => {
    const src = read('apps/web/app/admin/orders/[id]/edit/actions.ts');
    expect(src).toMatch(/export async function updateAdminOrderAction/);
    expect(src).toMatch(/UpdateOrderSchema/);
    expect(src).toMatch(/redirect\(`\/admin\/orders\/\$\{orderId\}`\)/);
  });

  test('updateOrderBasicsAction есть и переиспользует updateOrder', () => {
    const src = read('apps/web/app/admin/orders/[id]/basic-actions.ts');
    expect(src).toMatch(/export async function updateOrderBasicsAction/);
    expect(src).toMatch(/UpdateOrderSchema/);
    expect(src).toMatch(/updateOrder\(/);
    // Не делает redirect — остаёмся на той же странице.
    expect(src).not.toMatch(/redirect\(/);
    // Парсит все ожидаемые поля «Основное».
    expect(src).toMatch(/division/);
    expect(src).toMatch(/dueDate/);
    expect(src).toMatch(/clientId/);
    expect(src).toMatch(/customer/);
    expect(src).toMatch(/customerUnitPrice/);
    expect(src).toMatch(/customerCurrency/);
    expect(src).toMatch(/comment/);
  });
});

// ---------------------------------------------------------------------------
// 8. OrderBasicsForm — inline edit «Основное» в hero view-режима
// ---------------------------------------------------------------------------

describe('OrderBasicsForm — inline-форма «Сохранить основное» в hero', () => {
  const src = read('apps/web/components/orders/order-basics-form.tsx');

  test('форма содержит все управленческие поля', () => {
    expect(src).toMatch(/name="division"/);
    expect(src).toMatch(/name="dueDate"/);
    expect(src).toMatch(/name="clientId"/);
    expect(src).toMatch(/name="customerUnitPrice"/);
    expect(src).toMatch(/name="customerCurrency"/);
    expect(src).toMatch(/name="comment"/);
    // customer free-text сохранён hidden-полем для совместимости.
    expect(src).toMatch(/name="customer"/);
  });

  test('форма submit-ит updateOrderBasicsAction', () => {
    expect(src).toMatch(/updateOrderBasicsAction/);
    expect(src).toMatch(/Сохранить основное/);
  });

  test('терминальные статусы делают форму disabled', () => {
    expect(src).toMatch(/'DONE' \|\| status === 'CANCELLED'/);
    expect(src).toMatch(/disabled=\{isTerminal\}/);
  });
});

// ---------------------------------------------------------------------------
// 9. OrderRecommendationsCard — rule-based рекомендации
// ---------------------------------------------------------------------------

describe('OrderRecommendationsCard — rule-based, не AI', () => {
  const src = read(
    'apps/web/components/orders/order-recommendations-card.tsx',
  );

  test('содержит классические правила («не заполнена цена», «нет срока», «нет лекала», …)', () => {
    expect(src).toMatch(/Не заполнена цена продажи/);
    expect(src).toMatch(/Не указана валюта/);
    expect(src).toMatch(/Не указан срок/);
    expect(src).toMatch(/Не выбрана номенклатура/);
    expect(src).toMatch(/Пустая размерная матрица/);
    expect(src).toMatch(/Не выбран маршрут/);
    expect(src).toMatch(/Не выбрана техкарта/);
    expect(src).toMatch(/План операций устарел/);
  });

  test('empty-state «Замечаний нет»', () => {
    expect(src).toMatch(/Замечаний нет/);
  });
});
