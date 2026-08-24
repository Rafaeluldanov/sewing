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

describe('/admin/orders/new — мастер создания вместо одностраничной формы', () => {
  const formSrc = read(
    'apps/web/app/admin/orders/new/order-create-wizard.tsx',
  );

  test('мастер не использует workspace-обвязку карточки', () => {
    // `OrderWorkspaceLayout` / `OrderHeroCard` / `OrderDetailTabs` —
    // каркас карточки и формы правки. Создание больше не притворяется
    // карточкой: у него степпер и панель шага.
    expect(formSrc).not.toMatch(/OrderWorkspaceLayout/);
    expect(formSrc).not.toMatch(/OrderHeroCard/);
    expect(formSrc).not.toMatch(/OrderDetailTabs/);
    expect(formSrc).toMatch(/WIZARD_STEPS/);
    expect(formSrc).toMatch(/from '\.\/wizard-steps'/);
    expect(formSrc).toMatch(/order-wizard__steps/);
  });

  test('управленческие поля собраны на первом шаге', () => {
    expect(formSrc).toMatch(/setCompanyDivisionId/);
    expect(formSrc).toMatch(/setDueDate/);
    expect(formSrc).toMatch(/setClientId/);
    expect(formSrc).toMatch(/setCustomerUnitPrice/);
    expect(formSrc).toMatch(/setCustomerCurrency/);
    expect(formSrc).toMatch(/setComment/);
    // Редкие настройки — под раскрывашкой, а не первыми полями.
    expect(formSrc).toMatch(/setExtrasOpen/);
    expect(formSrc).toMatch(/setFinishedGoodsWarehouseId/);
    expect(formSrc).toMatch(/setMaterialsPolicy/);
  });

  test('содержимое шагов покрывает прежний Product tab', () => {
    expect(formSrc).toMatch(/patternItemId/);
    expect(formSrc).toMatch(/OrderColorwaysFieldset/);
    expect(formSrc).toMatch(/SizePlanSelector/);
    expect(formSrc).toMatch(/routeTemplateId/);
    expect(formSrc).toMatch(/OrderApplicationsEditor/);
  });

  test('нет единого <form action={createOrderAction}>', () => {
    // Прежняя форма собирала весь заказ одним сабмитом. Мастер пишет
    // по шагам, поэтому общей формы нет — и нет снимка «всей формы»,
    // который мог бы затереть чужие правки.
    expect(formSrc).not.toMatch(/action=\{formAction\}/);
    expect(formSrc).not.toMatch(/useFormState/);
    expect(formSrc).toMatch(/createOrderDraftAction/);
    expect(formSrc).toMatch(/patchOrderDraftAction/);
    expect(formSrc).toMatch(/saveDraftApplicationsAction/);
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
    // Алерты заказа переехали из отдельного блока над вкладками в
    // колокольчик шапки (`OrderAlertsBell` внутри
    // `OrderManagementHeader`), поэтому страница их больше не рендерит.
    expect(pageSrc).not.toMatch(/<OrderActionCenter\b/);
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

  test('страница рендерит ровно 6 management-вкладок', () => {
    for (const tab of [
      'production',
      'passports',
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
    // Вкладка «План» удалена — её настроечные блоки переехали в
    // «Производство», продукт/даты — в шапку заказа.
    expect(pageSrc).not.toMatch(/activeTab === 'plan'/);
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
    // order-plan-tab удалён — больше не импортируется страницей.
    expect(pageSrc).not.toMatch(
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
    // Смена статуса — контрол-список рядом с бейджем; в action-row
    // остались только не-статусные действия.
    expect(headerSrc).toMatch(/<OrderStatusSelect/);
    expect(headerSrc).toMatch(/RecalculateOperationPlanButton/);
    expect(headerSrc).toMatch(/DeleteOrderButton/);
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
// 3b. Колокольчик уведомлений в шапке заказа
// ---------------------------------------------------------------------------

describe('OrderAlertsBell — задачи и предупреждения свёрнуты в колокольчик', () => {
  const bellSrc = read(
    'apps/web/components/orders/view/order-alerts-bell.tsx',
  );
  const headerSrc = read(
    'apps/web/components/orders/view/order-management-header.tsx',
  );
  const acSrc = read('apps/web/components/orders/view/order-action-center.tsx');

  test('колокольчик — клиентский компонент с toggle, Esc и клик-вне', () => {
    expect(bellSrc).toMatch(/^'use client';/m);
    expect(bellSrc).toMatch(/aria-expanded=\{open\}/);
    expect(bellSrc).toMatch(/aria-controls=\{popoverId\}/);
    expect(bellSrc).toMatch(/'Escape'/);
    expect(bellSrc).toMatch(/mousedown/);
    // Счётчик обрезаем на 9+, чтобы не разрывать кружок.
    expect(bellSrc).toMatch(/count > 9 \? '9\+'/);
    // Подпись для screen-reader расшифровывает цифру.
    expect(bellSrc).toMatch(/Уведомления по заказу/);
  });

  test('шапка рендерит колокольчик рядом с бейджем статуса и больше не дублирует stale-плашку', () => {
    expect(headerSrc).toMatch(/<OrderAlertsBell/);
    expect(headerSrc).toMatch(/buildAlerts\(order, passports\)/);
    expect(headerSrc).toMatch(/resolveAlertsTone/);
    // Плашка «План операций устарел» в шапке снята — это тот же алерт
    // `operation-plan-stale`, что лежит в колокольчике.
    expect(headerSrc).not.toMatch(/order-mgmt-header__warning/);
  });

  test('правила алертов и рендер списка остались в order-action-center', () => {
    expect(acSrc).toMatch(/export function buildAlerts/);
    expect(acSrc).toMatch(/export function OrderAlertsList/);
    expect(acSrc).toMatch(/export function resolveAlertsTone/);
    // Тон счётчика — самый тяжёлый в списке, а не первый по порядку.
    expect(acSrc).toMatch(/a\.tone === 'danger'/);
    // Классы списка переиспользуются как были.
    expect(acSrc).toMatch(/order-action-center__item--\$\{a\.tone\}/);
  });

  test('стили колокольчика и поповера есть в globals.css', () => {
    const css = read('apps/web/app/globals.css');
    expect(css).toMatch(/\.order-alerts-bell__button\b/);
    expect(css).toMatch(/\.order-alerts-bell__count--danger\b/);
    expect(css).toMatch(/\.order-alerts-bell__count--warning\b/);
    expect(css).toMatch(/\.order-alerts-popover\b/);
  });
});

// ---------------------------------------------------------------------------
// 3a. ORDER_VIEW_TABS — единственный источник правды по management-вкладкам
// ---------------------------------------------------------------------------

describe('ORDER_VIEW_TABS — management-вкладки в фиксированном порядке', () => {
  test('конфиг содержит вкладки в порядке и поддерживает parseOrderViewTab', () => {
    const src = read(
      'apps/web/components/orders/view/order-view-tabs-config.ts',
    );
    // Вкладка «План» удалена: её настроечные блоки переехали в
    // «Производство», продукт/даты — в шапку заказа. «Сводно по
    // заказу» (`costSummary`) — отдельная финансовая вкладка между
    // «Операции» и «Потребности». Менеджер читает карточку как
    // «факт → объекты → операции → деньги → обеспечение → аудит».
    // Идентификатор `costSummary` (а не `summary`) сознательно
    // отделён от старого generic-summary, который раньше создавал
    // путаницу.
    const expected = [
      "id: 'production'",
      "id: 'passports'",
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
    // Удалённая вкладка «План» не должна вернуться в конфиг.
    expect(src).not.toMatch(/id: 'plan'/);
    expect(src).toMatch(/label: 'Производство'/);
    expect(src).toMatch(/label: 'Паспорта'/);
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
    // Подразделение — FK на master-справочник `CompanyDivision`.
    expect(formSrc).toMatch(/name="companyDivisionId"/);
    expect(formSrc).toMatch(/name="color"/);
    expect(formSrc).toMatch(/name="comment"/);
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
    // Мастер создания на этот конфиг больше не завязан — у него свой
    // `WIZARD_STEPS`. ORDER_DETAIL_TABS остался у формы правки.
    const editSrc = read(
      'apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx',
    );
    expect(editSrc).toMatch(/OrderDetailTabs/);
  });

  test('ни одна страница не дублирует список вкладок руками', () => {
    const configSrc = read(
      'apps/web/components/orders/order-detail-tabs-config.ts',
    );
    expect(configSrc).toMatch(/Продукция/);
    expect(configSrc).toMatch(/Сводно по заказу/);

    const newSrc = read(
      'apps/web/app/admin/orders/new/order-create-wizard.tsx',
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
    expect(src).toMatch(/companyDivisionId/);
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

describe('OrderBasicsForm — форма блока «Основное» (правка на месте)', () => {
  const src = read('apps/web/components/orders/order-basics-form.tsx');
  const headerSrc = read(
    'apps/web/components/orders/view/order-management-header.tsx',
  );

  test('форма содержит управленческие поля блока', () => {
    expect(src).toMatch(/name="dueDate"/);
    expect(src).toMatch(/name="clientId"/);
    expect(src).toMatch(/name="customerUnitPrice"/);
    expect(src).toMatch(/name="customerCurrency"/);
    expect(src).toMatch(/name="comment"/);
    // customer free-text сохранён hidden-полем для совместимости.
    expect(src).toMatch(/name="customer"/);
  });

  test('подразделения в блоке «Основное» НЕТ — у него другое окно правки', () => {
    // `companyDivisionId` — «безопасное плановое» поле: backend разрешает
    // менять его только до запуска производства (`isOrderPlanEditable`), а
    // «Основное» правится на любом статусе. Видимое поле, которое backend
    // отбивает 409 ORDER_LOCKED, — то самое враньё, ради которого затевалась
    // правка на месте. Поле переезжает в блок «Настройки заказа» (шаг 3).
    expect(src).not.toMatch(/name="companyDivisionId"/);
  });

  test('форма submit-ит updateOrderBasicsAction', () => {
    expect(src).toMatch(/updateOrderBasicsAction/);
    expect(src).toMatch(/Сохранить/);
  });

  test('результат сохранения форма докладывает блоку, а не рисует сама', () => {
    // Состояния «сохранено» / «не сохранено» принадлежат `OrderEditBlock`
    // (общий паттерн блока), поэтому форма зовёт api блока, а собственных
    // тостов и баннеров не держит.
    expect(src).toMatch(/useOrderEditBlockApi/);
    expect(src).toMatch(/block\.saved\(\)/);
    expect(src).toMatch(/block\.failed\(/);
    // «Повторить» на блоке шлёт тот же запрос — форма отдаёт retry.
    expect(src).toMatch(/requestSubmit\(\)/);
  });

  test('терминальные статусы закрывает гейт блока в шапке', () => {
    expect(headerSrc).toMatch(
      /const isTerminal = status === 'DONE' \|\| status === 'CANCELLED';/,
    );
    expect(headerSrc).toMatch(/isTerminal[\s\S]*?editable: false/);
  });
});

// ---------------------------------------------------------------------------
// 8a. OrderEditBlock — общий паттерн «правка на месте»
// ---------------------------------------------------------------------------

describe('OrderEditBlock — общий паттерн блока карточки заказа', () => {
  const src = read('apps/web/components/orders/blocks/order-edit-block.tsx');
  const headerSrc = read(
    'apps/web/components/orders/view/order-management-header.tsx',
  );
  const pageSrc = read('apps/web/app/admin/orders/[id]/page.tsx');

  test('четыре состояния блока размечены в DOM (data-state)', () => {
    expect(src).toMatch(/data-state=\{state\}/);
    expect(src).toMatch(/order-edit-block__chip--saved/);
    expect(src).toMatch(/order-edit-block__chip--failed/);
    expect(src).toMatch(/order-edit-block__chip--editing/);
  });

  test('«один блок за раз»: соседние блоки только для чтения', () => {
    expect(src).toMatch(/OrderEditBlocksProvider/);
    expect(src).toMatch(/blockedByNeighbour/);
    expect(src).toMatch(
      /Пока правится соседний блок, остальные только для чтения/,
    );
  });

  test('правки не теряются при ошибке: блок остаётся в правке', () => {
    // В состоянии «не сохранено» форма продолжает рендериться, а выбросить
    // введённое можно только явной кнопкой.
    expect(src).toMatch(/Отменить правку/);
    expect(src).toMatch(/Повторить/);
  });

  test('гейт объясняет не только «нельзя», но и «как можно»', () => {
    expect(src).toMatch(/reason\?: string/);
    expect(src).toMatch(/action\?: OrderEditBlockAction/);
  });

  test('api приходит формам контекстом, а не render-prop-ом', () => {
    // Блоки живут внутри серверных компонентов: функцию нельзя передать
    // пропом из server в client.
    expect(src).toMatch(/export function useOrderEditBlockApi/);
    expect(src).toMatch(/children: ReactNode/);
  });

  test('карточка заказа обёрнута провайдером и рендерит блок «Основное»', () => {
    expect(pageSrc).toMatch(/<OrderEditBlocksProvider>/);
    expect(headerSrc).toMatch(/<OrderEditBlock\s/);
    expect(headerSrc).toMatch(/id="basics"/);
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
    expect(src).toMatch(/Нет материалов в спецификации/);
    expect(src).toMatch(/План операций устарел/);
  });

  test('empty-state «Замечаний нет»', () => {
    expect(src).toMatch(/Замечаний нет/);
  });
});
