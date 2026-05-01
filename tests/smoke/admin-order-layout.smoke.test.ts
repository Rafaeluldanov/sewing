/**
 * Admin Order Form 2.3 + Order Detail Polish — smoke-тесты карточного
 * layout (`/admin/orders/new`) и карточки заказа (`/admin/orders/[id]`).
 *
 * После этапа «Номенклатура = Лекала» форма создания заказа имеет
 * следующий layout:
 *   - Верхняя строка `admin-order-form__top`:
 *       • «1. Заказ» (`--order`)  — клиент / даты (orderDate + dueDate
 *         с badge «Срок не указан») / подразделение / комментарий / статус;
 *       • «Превью изделия» (`--hero`) — `PatternHeroPreview` справа сверху.
 *   - Средняя строка `admin-order-form__middle`:
 *       • «2. Изделие» (`--product`)    — единственный select
 *         «Номенклатура / лекало» (`patternItemId`) + цвет;
 *         legacy `productId` («Учётное изделие») удалён;
 *       • «3. Производство» (`--production`) — техкарта / маршрут.
 *   - «4. План по размерам» (`--sizes`) — компактный
 *     `SizePlanSelector` (см.
 *     `apps/web/app/admin/orders/new/size-plan-selector.tsx`):
 *     summary («Размеры не выбраны» / «Выбрано размеров: N» +
 *     чипсы) и кнопка «Выбрать размеры» / «Изменить размеры»,
 *     открывающая модалку. Полный набор инпутов сразу больше не
 *     рендерится; FormData-контракт `qty[<sizeId>]` сохранён через
 *     hidden inputs по всем размерам справочника.
 *
 * Старые карточки `--dates` и нумерация «2. Сроки / 5. План» удалены.
 *
 * /admin/orders/[id] — polish-итерация «объединённый блок Изделие»:
 *   - блоки «Изделие» / «План по размерам» / «Потребность цеха»
 *     склеены в одну карточку «5. Изделие» (отдельные grid-areas
 *     `plan` и `needs` удалены, см. `--item`);
 *   - «Готовность к крою» переехала в правую пару к «Изделию»
 *     (`item readiness`);
 *   - «Заказ | Превью» и «Сроки | Сводка» получают одинаковую
 *     высоту через `align-items: stretch` + `display: flex`;
 *   - из «Сводки» убраны строка «Создан» (createdAt) и длинная
 *     строка «Контроль срока» — последняя превратилась в
 *     компактную иконку справа сверху (`<DeadlineControlIcon>` /
 *     `.admin-order-summary-control`);
 *   - `<AdminTechInfo>` (createdAt / raw status / id-шники) убран
 *     из карточки — это deep-tech, который дублирует подробности
 *     в карточках клиента / лекала / техкарты;
 *   - в «Производство» добавлена краткая подпись «Техкарта
 *     определяет материалы, маршрут — операции»;
 *   - «Готовность к крою» получила стат-боксы (`.cut-readiness-stats`,
 *     `auto-fit grid`) и `.cut-readiness-materials-scroll`-обёртку
 *     с `min-width: 720px` у самой таблицы — таблица скроллится
 *     внутри карточки, статусы не разъезжаются.
 *
 * Сам компонент `AdminSizeGrid` сохранён — он продолжает
 * использоваться в read-only режиме на `/admin/orders/[id]` и в
 * admin edit form, поэтому смоки на его контракт остаются.
 *
 * Все проверки — source-level (как и остальные smoke-тесты в этой
 * папке). Контракт FormData (`qty[<sizeId>]`) и backend остаются
 * нетронутыми; смежно это проверяют `admin-orders-create.smoke.test.ts`
 * и `admin-order-client-date.smoke.test.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function exists(relativePath: string): boolean {
  return existsSync(path.join(repoRoot, relativePath));
}

// ---------------------------------------------------------------------------
// 1. AdminSizeGrid component + CSS
// ---------------------------------------------------------------------------

describe('AdminSizeGrid — компонент и стили', () => {
  const src = read('apps/web/components/admin/admin-size-grid.tsx');

  test('файл компонента существует и реэкспортируется через components/admin', () => {
    expect(exists('apps/web/components/admin/admin-size-grid.tsx')).toBe(true);
    const indexSrc = read('apps/web/components/admin/index.ts');
    expect(indexSrc).toMatch(/AdminSizeGrid/);
  });

  test('AdminSizeGrid рендерит admin-size-grid и input с name=qty[…]', () => {
    expect(src).toMatch(/['"]admin-size-grid['"]/);
    expect(src).toMatch(/className="admin-size-grid__label"/);
    expect(src).toMatch(/className="admin-size-grid__input"/);
    // FormData-имя `qty[<sizeId>]` собирается через namePrefix; без
    // этой строки сломается createOrderAction (см. apps/web/app/orders/actions.ts).
    expect(src).toMatch(/name=\{`\$\{namePrefix\}\[\$\{size\.id\}\]`\}/);
    expect(src).toMatch(/namePrefix\s*=\s*['"]qty['"]/);
  });

  test('корневой div помечен data-size-grid="true"', () => {
    expect(src).toMatch(/data-size-grid="true"/);
  });

  test('AdminSizeGrid вешает класс admin-size-grid__item--active при qty > 0', () => {
    expect(src).toMatch(/admin-size-grid__item--active/);
  });

  test('AdminSizeGrid реализует Enter/Shift+Enter навигацию между inputами', () => {
    // Проверяем, что Enter перехватывается и форма не сабмитится.
    expect(src).toMatch(/onKeyDown/);
    expect(src).toMatch(/key !== 'Enter'/);
    expect(src).toMatch(/preventDefault/);
    expect(src).toMatch(/shiftKey/);
    // Сохраняем uncontrolled-поведение (defaultValue), без него ломается
    // FormData-сборка из браузера.
    expect(src).toMatch(/defaultValue=/);
    // Read-only режим обязателен (используется на /admin/orders/[id]).
    expect(src).toMatch(/readOnly/);
    expect(src).toMatch(/disabled=\{readOnly\}/);
  });

  test('CSS-классы .admin-size-grid* определены в globals.css', () => {
    const css = read('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-size-grid\s*\{/);
    expect(css).toMatch(/\.admin-size-grid__item\s*\{/);
    expect(css).toMatch(/\.admin-size-grid__label\s*\{/);
    expect(css).toMatch(/\.admin-size-grid__input\s*\{/);
    // Сетка задаётся через repeat(auto-fill, minmax(80px, 1fr)) — это и есть
    // «80px-чипы по всей ширине», на которые ушёл редизайн.
    expect(css).toMatch(
      /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(80px,\s*1fr\)\)/,
    );
    expect(css).toMatch(/\.admin-size-grid__item:hover\s*\{/);
    // Активная плитка должна иметь свой блок стилей.
    expect(css).toMatch(/\.admin-size-grid__item--active\b/);
  });
});

// ---------------------------------------------------------------------------
// 2. /admin/orders/new — карточный layout формы
// ---------------------------------------------------------------------------

describe('/admin/orders/new — Admin Order Form (Order workspace v2)', () => {
  const formSrc = read(
    'apps/web/app/admin/orders/new/admin-create-order-form.tsx',
  );

  test('форма обёрнута в admin-order-form и использует OrderWorkspaceLayout', () => {
    expect(formSrc).toMatch(/admin-order-form\b/);
    expect(formSrc).toMatch(/OrderWorkspaceLayout/);
    // Поля «Основное» теперь в hero, а внутри Product tab — две строки
    // карточек (изделие + превью / производство / нанесение / размеры).
    expect(formSrc).toMatch(/admin-order-form__grid/);
    expect(formSrc).toMatch(/admin-order-form__top/);
  });

  test('содержит карточки «Изделие / Производство / План» + hero-карточку превью', () => {
    // Карточка «Заказ» переехала в hero-блок «Основное» (управленческие
    // поля editable inline). В Product tab остались карточки про
    // продукт/производство/размеры.
    expect(formSrc).not.toMatch(/admin-order-card--order/);
    expect(formSrc).toMatch(/admin-order-card--product/);
    expect(formSrc).toMatch(/admin-order-card--production/);
    expect(formSrc).toMatch(/admin-order-card--sizes/);
    expect(formSrc).toMatch(/admin-order-card--hero/);
    expect(formSrc).not.toMatch(/admin-order-card--dates/);
  });

  test('заголовки карточек в Product tab без сквозной нумерации', () => {
    expect(formSrc).toMatch(/Изделие/);
    expect(formSrc).toMatch(/Производство/);
    expect(formSrc).toMatch(/План по размерам/);
    expect(formSrc).toMatch(/Превью изделия/);
    // Старые нумерованные заголовки — наследие «простыни», убраны.
    expect(formSrc).not.toMatch(/2\.\s*Сроки/);
    expect(formSrc).not.toMatch(/5\.\s*План по размерам/);
  });

  test('размеры рендерятся через SizePlanSelector (компактный summary + модалка)', () => {
    // Polish-итерация «План по размерам — модалка»: видимая сетка
    // `AdminSizeGrid` на /admin/orders/new больше не используется.
    expect(formSrc).not.toMatch(/AdminSizeGrid/);
    expect(formSrc).toMatch(/SizePlanSelector/);
    expect(formSrc).toMatch(/from '\.\/size-plan-selector'/);
    // FormData-контракт сохранён через hidden inputs по всему
    // справочнику размеров — смежно проверяет
    // `admin-orders-create.smoke.test.ts`.
    expect(formSrc).toMatch(/type="hidden"/);
    expect(formSrc).toMatch(/name=\{`qty\[\$\{s\.id\}\]`\}/);
    expect(formSrc).not.toMatch(/admin-table/);
    expect(formSrc).not.toMatch(/<table/);
    expect(formSrc).not.toMatch(/Добавить строку/);
    expect(formSrc).not.toMatch(/Trash2/);
  });

  test('SizePlanSelector реализует компактный блок «4. План по размерам»', () => {
    const src = read(
      'apps/web/app/admin/orders/new/size-plan-selector.tsx',
    );
    // role="dialog" + aria-modal — обязательно по ТЗ модалки.
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-modal="true"/);
    // Кнопки с двумя состояниями (выбрать/изменить).
    expect(src).toMatch(/Выбрать размеры/);
    expect(src).toMatch(/Изменить размеры/);
    // Empty state и подсказки.
    expect(src).toMatch(/Размеры не выбраны/);
    expect(src).toMatch(/Сначала выберите номенклатуру/);
    expect(src).toMatch(/нет активных размеров/);
    // Кнопки модалки.
    expect(src).toMatch(/Очистить\s*<\/button>/);
    expect(src).toMatch(/Отмена\s*<\/button>/);
    expect(src).toMatch(/Сохранить\s*<\/button>/);
    // Esc / клик по backdrop закрывает.
    expect(src).toMatch(/Escape/);
    expect(src).toMatch(/handleBackdropClick/);
    // Disabled-состояние, пока номенклатура не выбрана / нет DXF.
    expect(src).toMatch(/disabled=\{!canOpen\}/);
  });

  test('CSS .admin-size-plan* и .admin-size-plan-modal* определены в globals.css', () => {
    const css = read('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-size-plan\s*\{/);
    expect(css).toMatch(/\.admin-size-plan__chip\b/);
    expect(css).toMatch(/\.admin-size-plan-modal\b/);
    expect(css).toMatch(/\.admin-size-plan-modal__backdrop\b/);
    expect(css).toMatch(/\.admin-size-plan-modal__row\b/);
    expect(css).toMatch(/\.admin-order-card__meta\b/);
  });

  test('FormData-ключи (включая qty[<sizeId>] через hidden inputs) сохранены', () => {
    expect(formSrc).toMatch(/name="orderDate"/);
    expect(formSrc).toMatch(/name="dueDate"/);
    expect(formSrc).toMatch(/name="clientId"/);
    expect(formSrc).toMatch(/name="division"/);
    expect(formSrc).toMatch(/name="techCardId"/);
    expect(formSrc).toMatch(/name="routeTemplateId"/);
    // Этап «Номенклатура = Лекала»: единственная видимая
    // номенклатура — `patternItemId`; `productId` UI больше не шлёт.
    expect(formSrc).toMatch(/name="patternItemId"/);
    expect(formSrc).not.toMatch(/name="productId"/);
    expect(formSrc).toMatch(/name="color"/);
    expect(formSrc).toMatch(/name="comment"/);
    // Polish-итерация «План по размерам — модалка»: ключ `qty[<sizeId>]`
    // больше не приходит из `AdminSizeGrid`. Форма сама рендерит
    // hidden input по каждому размеру справочника — value берёт из
    // client state `quantities`.
    expect(formSrc).toMatch(/type="hidden"/);
    expect(formSrc).toMatch(/name=\{`qty\[\$\{s\.id\}\]`\}/);
    // AdminSizeGrid сохранил namePrefix — он используется на
    // /admin/orders/[id] (read-only). Без этого сломалась бы
    // карточка заказа.
    const gridSrc = read('apps/web/components/admin/admin-size-grid.tsx');
    expect(gridSrc).toMatch(/name=\{`\$\{namePrefix\}\[\$\{size\.id\}\]`\}/);
    expect(gridSrc).toMatch(/namePrefix\s*=\s*['"]qty['"]/);
  });

  test('hero-превью лекала и блок «Изделие» сшиты через PatternHeroPreview', () => {
    // Polish: компонент-герой выведен в @/components/admin и
    // переиспользуется на форме заказа.
    expect(formSrc).toMatch(/PatternHeroPreview/);
    const indexSrc = read('apps/web/components/admin/index.ts');
    expect(indexSrc).toMatch(/PatternHeroPreview/);
    // Этап «Номенклатура = Лекала»: внутри блока «Изделие» —
    // ровно один select «Номенклатура / лекало». Legacy
    // «Учётное изделие» удалён, secondary-контейнер тоже.
    expect(formSrc).not.toMatch(/admin-order-card__secondary/);
    expect(formSrc).not.toMatch(/Учётное изделие/);
    expect(formSrc).toMatch(/>Номенклатура \/ лекало</);
  });

  test('срок сдачи теперь в hero «Основное»', () => {
    // Order workspace v2: dueDate переехал из карточки «Заказ» в
    // hero-форму «Основное». Отдельный admin-order-due-badge больше
    // не нужен — поле редактируется inline.
    expect(formSrc).toMatch(/name="dueDate"/);
    expect(formSrc).not.toMatch(/admin-order-due-badge/);
    expect(formSrc).not.toMatch(/Статус срока/);
    expect(formSrc).not.toMatch(/Без срока сдачи/);
  });

  test('маршрут показывает превью через AdminRouteSteps', () => {
    expect(formSrc).toMatch(/AdminRouteSteps/);
  });
});

// ---------------------------------------------------------------------------
// 3. /admin/orders/[id] — read-only сетка размеров (контракт сохранён)
// ---------------------------------------------------------------------------

describe('/admin/orders/[id] — план по размерам в OrderPlanTab (read-only)', () => {
  const planSrc = read(
    'apps/web/components/orders/view/tabs/order-plan-tab.tsx',
  );
  const productionSrc = read(
    'apps/web/components/orders/view/tabs/order-production-tab.tsx',
  );

  test('OrderPlanTab использует AdminSizeGrid (read-only)', () => {
    expect(planSrc).toMatch(/AdminSizeGrid/);
    expect(planSrc).toMatch(/readOnly/);
    expect(planSrc).toMatch(/План по размерам/);
  });

  test('OrderProductionTab показывает sizeBreakdown с фактом раскроя (qtyCutFact)', () => {
    // Order management redesign: размерный production-breakdown
    // переехал в `OrderProductionTab` — там же sizeBreakdown с
    // фактом раскроя и остатком.
    expect(productionSrc).toMatch(/sizeBreakdown/);
    expect(productionSrc).toMatch(/qtyCutFact/);
  });
});

// ---------------------------------------------------------------------------
// 4. /admin/orders/[id] — Order workspace v2 (hero + tabs)
//
// Карточка заказа теперь — workspace с hero «Основное» и
// шестью вкладками. Старая сплошная grid-сетка `admin-order-detail-layout`
// с 11 зонами уехала в Product tab как focused subset.
// ---------------------------------------------------------------------------

describe.skip('/admin/orders/[id] — единая grid-сетка с именованными зонами (legacy)', () => {
  const pageSrc = read('apps/web/app/admin/orders/[id]/page.tsx');
  const css = read('apps/web/app/globals.css');

  test('страница использует className="admin-order-detail-layout" как основной layout', () => {
    expect(pageSrc).toMatch(/admin-order-detail-layout/);
    // Старая схема двух независимых колонок (`column--ops` /
    // `column--summary`) больше не управляет раскладкой — иначе
    // блоки снова наедут друг на друга. CSS-классы могут
    // оставаться в globals.css для совместимости, но в JSX их
    // быть не должно.
    expect(pageSrc).not.toMatch(/admin-order-detail-column--ops/);
    expect(pageSrc).not.toMatch(/admin-order-detail-column--summary/);
    expect(pageSrc).not.toMatch(/admin-order-detail-grid/);
  });

  test('admin-grid-2 / admin-stack больше не используются как основной layout', () => {
    // На этой странице не должно быть упоминаний
    // `className="admin-grid-2"` / `className="admin-stack"`.
    // Сами классы остаются глобально для других admin-страниц.
    expect(pageSrc).not.toMatch(/className="admin-grid-2"/);
    expect(pageSrc).not.toMatch(/className="admin-stack"/);
  });

  test('OrderWorkflowCard рендерится в admin-order-area--status (row 1, на всю ширину)', () => {
    // Workflow-блок — первая зона `status` единой сетки.
    expect(pageSrc).toMatch(/<OrderWorkflowCard\b/);
    expect(pageSrc).toMatch(
      /admin-order-area--status[\s\S]*?<OrderWorkflowCard\b/,
    );
  });

  test('PatternPreviewCard живёт в admin-order-area--preview (row 2 справа от «Заказ»)', () => {
    expect(pageSrc).toMatch(/<PatternPreviewCard\b/);
    expect(pageSrc).toMatch(
      /admin-order-area--preview[\s\S]*?<PatternPreviewCard\b/,
    );
  });

  test('CutReadinessCard живёт в admin-order-area--readiness (row 5 справа от «Изделие»)', () => {
    expect(pageSrc).toMatch(/<CutReadinessCard\b/);
    expect(pageSrc).toMatch(
      /admin-order-area--readiness[\s\S]*?<CutReadinessCard\b/,
    );
  });

  test('WorkshopNeedsCard живёт внутри admin-order-area--item (объединённый блок «Изделие»)', () => {
    // Polish-итерация «объединённый блок Изделие»:
    // `WorkshopNeedsCard` больше не самостоятельная grid-area
    // `--needs`. Он рендерится как третья подсекция внутри
    // карточки «5. Изделие». Backend / API / DTO / сам компонент
    // не меняли — изменили только размещение.
    expect(pageSrc).toMatch(/<WorkshopNeedsCard\b/);
    expect(pageSrc).toMatch(
      /admin-order-area--item[\s\S]*?<WorkshopNeedsCard\b/,
    );
    // Старая отдельная зона `--needs` удалена.
    expect(pageSrc).not.toMatch(/admin-order-area--needs/);
  });

  test('PurchaseOrdersCard живёт в admin-order-area--purchase-orders (row 6 слева)', () => {
    expect(pageSrc).toMatch(/<PurchaseOrdersCard\b/);
    expect(pageSrc).toMatch(
      /admin-order-area--purchase-orders[\s\S]*?<PurchaseOrdersCard\b/,
    );
  });

  test('PurchaseReceiptsCard живёт в admin-order-area--receipts (row 6 справа)', () => {
    expect(pageSrc).toMatch(/<PurchaseReceiptsCard\b/);
    expect(pageSrc).toMatch(
      /admin-order-area--receipts[\s\S]*?<PurchaseReceiptsCard\b/,
    );
  });

  test('Паспорта / партии находятся в admin-order-area--passports (row 7, на всю ширину)', () => {
    expect(pageSrc).toMatch(
      /admin-order-area--passports[\s\S]*?Паспорта \/ партии/,
    );
  });

  test('все 11 admin-order-area* зон присутствуют (без отдельных --plan / --needs)', () => {
    // Polish-итерация: убрали отдельные grid-areas `plan` и
    // `needs` — содержимое объединено в `--item`. Осталось 11 зон.
    expect(pageSrc).toMatch(/admin-order-area--status/);
    expect(pageSrc).toMatch(/admin-order-area--order/);
    expect(pageSrc).toMatch(/admin-order-area--preview/);
    expect(pageSrc).toMatch(/admin-order-area--deadlines/);
    expect(pageSrc).toMatch(/admin-order-area--summary/);
    expect(pageSrc).toMatch(/admin-order-area--production/);
    expect(pageSrc).toMatch(/admin-order-area--item/);
    expect(pageSrc).toMatch(/admin-order-area--readiness/);
    expect(pageSrc).toMatch(/admin-order-area--purchase-orders/);
    expect(pageSrc).toMatch(/admin-order-area--receipts/);
    expect(pageSrc).toMatch(/admin-order-area--passports/);
    // Зоны `plan` и `needs` удалены из основного layout.
    expect(pageSrc).not.toMatch(/admin-order-area--plan\b/);
    expect(pageSrc).not.toMatch(/admin-order-area--needs\b/);
  });

  test('визуальный порядок блоков в DOM соответствует ТЗ', () => {
    // Порядок должен быть: status → order → preview → deadlines
    // → summary → production → item → readiness → purchase-orders
    // → receipts → passports.
    const order = [
      'admin-order-area--status',
      'admin-order-area--order',
      'admin-order-area--preview',
      'admin-order-area--deadlines',
      'admin-order-area--summary',
      'admin-order-area--production',
      'admin-order-area--item',
      'admin-order-area--readiness',
      'admin-order-area--purchase-orders',
      'admin-order-area--receipts',
      'admin-order-area--passports',
    ];
    let prevIdx = -1;
    for (const marker of order) {
      const idx = pageSrc.indexOf(marker);
      expect(idx, `marker ${marker} not found in page.tsx`).toBeGreaterThan(
        -1,
      );
      expect(
        idx,
        `marker ${marker} expected to come after ${order[order.indexOf(marker) - 1] ?? '<start>'} (got idx=${idx}, prev=${prevIdx})`,
      ).toBeGreaterThan(prevIdx);
      prevIdx = idx;
    }
  });

  test('все обязательные блоки на странице присутствуют', () => {
    // Не удалять блоки (раздел 9 ТЗ): статус workflow, заказ,
    // картинка, сроки, сводка, производство, изделие
    // (объединённое: + план по размерам + потребность цеха),
    // готовность к крою, заказы поставщикам, поступления,
    // паспорта.
    expect(pageSrc).toMatch(/<OrderWorkflowCard\b/);
    expect(pageSrc).toMatch(/<PatternPreviewCard\b/);
    expect(pageSrc).toMatch(/<CutReadinessCard\b/);
    expect(pageSrc).toMatch(/<WorkshopNeedsCard\b/);
    expect(pageSrc).toMatch(/<PurchaseOrdersCard\b/);
    expect(pageSrc).toMatch(/<PurchaseReceiptsCard\b/);
    expect(pageSrc).toMatch(/title="1\. Заказ"/);
    expect(pageSrc).toMatch(/title="2\. Сроки"/);
    expect(pageSrc).toMatch(/title="3\. Сводка"/);
    expect(pageSrc).toMatch(/title="4\. Производство"/);
    expect(pageSrc).toMatch(/title="5\. Изделие"/);
    expect(pageSrc).toMatch(/title="6\. Паспорта \/ партии"/);
    // «6. План по размерам» и «Готовность к крою» как
    // отдельные нумерованные карточки заголовков больше нет:
    // план — подсекция внутри «5. Изделие», готовность к крою —
    // компонент со своим title, без сквозной нумерации.
    expect(pageSrc).not.toMatch(/title="6\. План по размерам"/);
    expect(pageSrc).not.toMatch(/title="7\. Паспорта \/ партии"/);
  });

  test('AdminTechInfo (createdAt / raw status / id-шники) убран из карточки заказа', () => {
    // ТЗ §4 «Убрать техническую информацию из карточки заказа»:
    // `<AdminTechInfo>` дублировал createdAt и показывал deep-tech
    // id-шники, которые есть в карточках клиента / лекала /
    // техкарты. На карточке заказа теперь нет ни компонента, ни
    // импорта.
    expect(pageSrc).not.toMatch(/<AdminTechInfo\b/);
    expect(pageSrc).not.toMatch(/import\s*\{[^}]*AdminTechInfo[^}]*\}/);
  });

  test('из «Сводки» убраны «Создан» и «Контроль срока», вместо последнего — компактная иконка', () => {
    // ТЗ §5: в карточке «Сводка» больше нет строки «Создан» и
    // даты создания. «Контроль срока» / «Контроль выпуска» —
    // компактная иконка в правом верхнем углу через
    // `DeadlineControlIcon` + `.admin-order-summary-control`,
    // не отдельная строка `<dt>/<dd>` (раздувала карточку).
    const summaryStart = pageSrc.indexOf('admin-order-area--summary');
    const summaryEnd = pageSrc.indexOf(
      'admin-order-area--production',
      summaryStart,
    );
    expect(summaryStart).toBeGreaterThan(-1);
    expect(summaryEnd).toBeGreaterThan(summaryStart);
    const summaryBlock = pageSrc.slice(summaryStart, summaryEnd);
    expect(summaryBlock).not.toMatch(/<dt>Создан<\/dt>/);
    expect(summaryBlock).not.toMatch(/<dt>Контроль срока<\/dt>/);
    expect(summaryBlock).not.toMatch(/formatDateTime\(order\.createdAt\)/);
    expect(summaryBlock).toMatch(/<DeadlineControlIcon\b/);
    // Сам helper-компонент существует и пользуется CSS-классом.
    expect(pageSrc).toMatch(/function DeadlineControlIcon\b/);
    expect(pageSrc).toMatch(/admin-order-summary-control/);
  });

  test('блок «Производство» содержит техкарту, маршрут и краткое пояснение', () => {
    // ТЗ §7: блок «Производство» должен показывать техкарту и
    // маршрут хотя бы кратко + добавлена подпись «Техкарта
    // определяет материалы, маршрут — операции».
    const start = pageSrc.indexOf('admin-order-area--production');
    expect(start).toBeGreaterThan(-1);
    const end = pageSrc.indexOf('admin-order-area--item', start);
    expect(end).toBeGreaterThan(start);
    const productionBlock = pageSrc.slice(start, end);
    expect(productionBlock).toMatch(/<dt>Техкарта<\/dt>/);
    expect(productionBlock).toMatch(/<dt>Маршрут<\/dt>/);
    expect(productionBlock).toMatch(/admin-order-production-note/);
    expect(productionBlock).toMatch(
      /Техкарта определяет материалы, маршрут — операции/,
    );
  });

  test('блок «Изделие» — объединённая карточка (номенклатура + цвет + план + потребность)', () => {
    // ТЗ §1: «Изделие», «План по размерам», «Потребность цеха»
    // склеены в одну карточку «5. Изделие». Внутри —
    // подзаголовки через `.admin-order-item-card__subtitle`,
    // `WorkshopNeedsCard` встроен как третья подсекция.
    //
    // Полировка «номенклатура vs legacy Product»: главный лейбл
    // теперь «Номенклатура» (не «Название»), и значение приходит
    // из единого resolver-а `resolveOrderNomenclature`, чтобы
    // PatternPreviewCard и блок «Изделие» в одной и той же
    // карточке всегда показывали одно и то же название/артикул.
    const start = pageSrc.indexOf('admin-order-area--item');
    expect(start).toBeGreaterThan(-1);
    const end = pageSrc.indexOf('admin-order-area--readiness', start);
    expect(end).toBeGreaterThan(start);
    const itemBlock = pageSrc.slice(start, end);
    expect(itemBlock).toMatch(/admin-order-item-card\b/);
    expect(itemBlock).toMatch(/title="5\. Изделие"/);
    expect(itemBlock).toMatch(/<dt>Номенклатура<\/dt>/);
    // Старый лейбл «Название» (он же legacy `productName`) удалён —
    // блок «Изделие» больше не рисует Product как основное название.
    expect(itemBlock).not.toMatch(/<dt>Название<\/dt>/);
    expect(itemBlock).not.toMatch(/order\.productName/);
    expect(itemBlock).toMatch(/<dt>Цвет<\/dt>/);
    // Артикул берётся из resolver-а (snapshot ⊃ live), а не из
    // конкретного snapshot-поля — это ровно тот же источник, что
    // и в PatternPreviewCard.
    expect(itemBlock).toMatch(/nomenclature\.article/);
    expect(itemBlock).toMatch(/admin-order-item-card__subtitle/);
    expect(itemBlock).toMatch(/План по размерам/);
    expect(itemBlock).toMatch(/<OrderItemsGrid\b/);
    expect(itemBlock).toMatch(/<WorkshopNeedsCard\b/);
  });

  test('блок «Изделие» использует resolveOrderNomenclature и не показывает productName как основное', () => {
    // ТЗ §«Целевая логика отображения»: главное название изделия в
    // карточке заказа — `resolveOrderNomenclature(order).name`, а
    // не `order.productName`. `productName` остаётся в DTO, но в
    // блоке «Изделие» больше не используется как primary value.
    expect(pageSrc).toMatch(/from '@\/lib\/order-nomenclature'/);
    expect(pageSrc).toMatch(/resolveOrderNomenclature\(order\)/);
    expect(pageSrc).toMatch(/nomenclature\.name/);
    // Бейдж «legacy» рисуется только для исторических заказов
    // (resolver вернул `'legacyProduct'`).
    expect(pageSrc).toMatch(/nomenclature\.source === 'legacyProduct'/);
    expect(pageSrc).toMatch(/admin-order-item-card__source-badge/);
    // CSS-класс бейджа определён в globals.css.
    const css = read('apps/web/app/globals.css');
    expect(css).toMatch(/\.admin-order-item-card__source-badge\b/);
  });

  test('карточки помечены классом admin-order-detail-card-compact', () => {
    // Компактные карточки (раздел 6 ТЗ) — gap уменьшен, padding
    // оставлен как есть. Класс висит как минимум на 6 карточках
    // (Заказ / Сроки / Сводка / Производство / Изделие /
    // Паспорта).
    const matches =
      pageSrc.match(/admin-order-detail-card-compact/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(6);
  });

  test('парные карточки помечены admin-order-detail-card-fill (выравнивание по высоте)', () => {
    // ТЗ §2/§3: «Заказ | Превью» и «Сроки | Сводка» (плюс
    // «Изделие | Готовность») должны быть одной высоты через
    // `align-items: stretch` + `flex: 1 1 auto`. Helper-класс
    // `admin-order-detail-card-fill` расставлен явно как минимум
    // на «Заказ», «Сроки», «Сводка», «Изделие».
    const matches =
      pageSrc.match(/admin-order-detail-card-fill/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  test('CSS .admin-order-detail-layout определён в globals.css', () => {
    expect(css).toMatch(/\.admin-order-detail-layout\s*\{/);
    expect(css).toMatch(/\.admin-order-area\s*\{/);
    expect(css).toMatch(/\.admin-order-detail-card-compact\b/);
    expect(css).toMatch(/\.admin-order-detail-card-fill\s*\{/);
  });

  test('CSS использует grid-template-areas с 7 строками нового ТЗ (без plan/needs)', () => {
    // ТЗ §1 (новая структура layout) — точное совпадение строк
    // grid-template-areas, объединённых в один блок «Изделие».
    expect(css).toMatch(
      /\.admin-order-detail-layout\s*\{[\s\S]*?grid-template-areas:[\s\S]*?'status status'[\s\S]*?'order preview'[\s\S]*?'deadlines summary'[\s\S]*?'production production'[\s\S]*?'item readiness'[\s\S]*?'purchase-orders receipts'[\s\S]*?'passports passports'/,
    );
    // Старые пары `'item plan'` / `'needs readiness'` исчезли
    // из основной template-areas.
    expect(css).not.toMatch(
      /\.admin-order-detail-layout\s*\{[\s\S]*?grid-template-areas:[\s\S]*?'item plan'/,
    );
    expect(css).not.toMatch(
      /\.admin-order-detail-layout\s*\{[\s\S]*?grid-template-areas:[\s\S]*?'needs readiness'/,
    );
  });

  test('CSS назначает grid-area каждой из 11 зон', () => {
    expect(css).toMatch(
      /\.admin-order-area--status\s*\{[\s\S]*?grid-area:\s*status/,
    );
    expect(css).toMatch(
      /\.admin-order-area--order\s*\{[\s\S]*?grid-area:\s*order/,
    );
    expect(css).toMatch(
      /\.admin-order-area--preview\s*\{[\s\S]*?grid-area:\s*preview/,
    );
    expect(css).toMatch(
      /\.admin-order-area--deadlines\s*\{[\s\S]*?grid-area:\s*deadlines/,
    );
    expect(css).toMatch(
      /\.admin-order-area--summary\s*\{[\s\S]*?grid-area:\s*summary/,
    );
    expect(css).toMatch(
      /\.admin-order-area--production\s*\{[\s\S]*?grid-area:\s*production/,
    );
    expect(css).toMatch(
      /\.admin-order-area--item\s*\{[\s\S]*?grid-area:\s*item/,
    );
    expect(css).toMatch(
      /\.admin-order-area--readiness\s*\{[\s\S]*?grid-area:\s*readiness/,
    );
    expect(css).toMatch(
      /\.admin-order-area--purchase-orders\s*\{[\s\S]*?grid-area:\s*purchase-orders/,
    );
    expect(css).toMatch(
      /\.admin-order-area--receipts\s*\{[\s\S]*?grid-area:\s*receipts/,
    );
    expect(css).toMatch(
      /\.admin-order-area--passports\s*\{[\s\S]*?grid-area:\s*passports/,
    );
  });

  test('CSS использует minmax(0, 1fr) и min-width: 0 (защита от horizontal overflow)', () => {
    // Без `minmax(0, 1fr)` колонка наследует `min-content` от
    // широких таблиц и выталкивается за экран.
    expect(css).toMatch(
      /\.admin-order-detail-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/,
    );
    // У `.admin-order-area` обязателен `min-width: 0`, иначе
    // ребёнок-таблица растянет grid-child.
    expect(css).toMatch(
      /\.admin-order-area\s*\{[\s\S]*?min-width:\s*0/,
    );
  });

  test('CSS использует align-items: stretch для выравнивания парных карточек по высоте', () => {
    // ТЗ §2/§3: «Заказ | Превью», «Сроки | Сводка»,
    // «Изделие | Готовность к крою» должны быть одной высоты.
    // `align-items: stretch` на grid-родителе делает все строки
    // одинаковой высоты по самому высокому ребёнку.
    expect(css).toMatch(
      /\.admin-order-detail-layout\s*\{[\s\S]*?align-items:\s*stretch/,
    );
    // У `.admin-order-area` `display: flex` + у детей
    // `flex: 1 1 auto`, чтобы карточка растянулась во всю
    // высоту grid-row.
    expect(css).toMatch(/\.admin-order-area\s*\{[\s\S]*?display:\s*flex/);
    expect(css).toMatch(
      /\.admin-order-area\s*>\s*\*\s*\{[\s\S]*?flex:\s*1\s+1\s+auto/,
    );
  });

  test('CSS даёт overflow-x: auto широким таблицам внутри карточек', () => {
    // `.admin-table-wrap` глобально имеет `overflow: hidden`,
    // что прятало широкие таблицы; здесь мы переопределяем на
    // скролл. Под `.admin-order-detail-layout` должна быть
    // обёртка с `overflow-x: auto`.
    expect(css).toMatch(
      /\.admin-order-detail-layout\s+\.admin-table-wrap\s*\{[\s\S]*?overflow-x:\s*auto/,
    );
    // Дополнительно `.cut-readiness-materials-scroll` обёртывает
    // таблицу материалов с `overflow-x: auto` и задаёт
    // `min-width: 720px` самой таблице, чтобы статусы и колонки
    // не разъезжались на узкой grid-area.
    expect(css).toMatch(
      /\.cut-readiness-materials-scroll\s*\{[\s\S]*?overflow-x:\s*auto/,
    );
    expect(css).toMatch(
      /\.cut-readiness-materials-scroll\s+\.admin-table\s*\{[\s\S]*?min-width:\s*720px/,
    );
  });

  test('CSS определяет media query (max-width: 1199px) на одну колонку', () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*1199px\)\s*\{[\s\S]*?\.admin-order-detail-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    // На узком экране grid-template-areas вырождается в одну
    // колонку из 11 строк (без отдельных plan/needs) — порядок
    // соответствует ТЗ.
    expect(css).toMatch(
      /@media\s*\(max-width:\s*1199px\)\s*\{[\s\S]*?grid-template-areas:[\s\S]*?'status'[\s\S]*?'order'[\s\S]*?'preview'[\s\S]*?'deadlines'[\s\S]*?'summary'[\s\S]*?'production'[\s\S]*?'item'[\s\S]*?'readiness'[\s\S]*?'purchase-orders'[\s\S]*?'receipts'[\s\S]*?'passports'/,
    );
  });

  test('CSS использует box-sizing: border-box на layout и areas', () => {
    expect(css).toMatch(
      /\.admin-order-detail-layout\s*\{[\s\S]*?box-sizing:\s*border-box/,
    );
    expect(css).toMatch(
      /\.admin-order-area\s*\{[\s\S]*?box-sizing:\s*border-box/,
    );
  });

  test('width контейнера ограничен max-width: 100% (нет horizontal overflow)', () => {
    // Контейнер страницы карточки заказа должен быть `width: 100%`
    // и не выходить за `max-width: 100%` доступной области между
    // sidebar и краем экрана. Без этого сетка с широкой таблицей
    // могла продавить body и вызывать горизонтальный скролл всей
    // страницы.
    expect(css).toMatch(
      /\.admin-order-detail\s*\{[\s\S]*?width:\s*100%/,
    );
    expect(css).toMatch(
      /\.admin-order-detail\s*\{[\s\S]*?max-width:\s*100%/,
    );
    expect(css).toMatch(
      /\.admin-order-detail-layout\s*\{[\s\S]*?width:\s*100%/,
    );
  });

  test('CSS блока «Изделие» обнуляет визуал вложенного WorkshopNeedsCard', () => {
    // ТЗ §3: «не вкладывать карточку в карточку с двойными
    // бордерами». `.admin-order-item-card .admin-card` сбрасывает
    // фон/бордер/тень/паддинг — `WorkshopNeedsCard` сливается
    // с родительским «Изделие», без двойных бордеров.
    expect(css).toMatch(/\.admin-order-item-card\b/);
    expect(css).toMatch(
      /\.admin-order-item-card\s+\.admin-card\s*\{[\s\S]*?border:\s*none/,
    );
    expect(css).toMatch(/\.admin-order-item-card__subtitle\b/);
  });

  test('CSS блока «Готовность к крою» имеет компактные стат-боксы', () => {
    // ТЗ §8.A: статусы (Блокеров / Предупреждений / Проверено)
    // лежат в `auto-fit` grid с `minmax(120px, 1fr)`, а не в
    // `dl` (где колонки разъезжались на узкой ширине).
    expect(css).toMatch(/\.cut-readiness-stats\s*\{/);
    expect(css).toMatch(
      /\.cut-readiness-stats\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(120px,\s*1fr\)\)/,
    );
    expect(css).toMatch(/\.cut-readiness-stats__item\s*\{/);
  });

  test('CutReadinessCard использует стат-боксы и scroll-обёртку для материалов', () => {
    const src = read('apps/web/components/orders/cut-readiness-card.tsx');
    // Стат-боксы вместо `<dl>` — компактные и не разъезжаются.
    expect(src).toMatch(/cut-readiness-stats\b/);
    expect(src).toMatch(/cut-readiness-stats__item\b/);
    expect(src).toMatch(/cut-readiness-stats__label\b/);
    expect(src).toMatch(/cut-readiness-stats__value\b/);
    // Scroll-обёртка для таблицы материалов — таблица скроллится
    // внутри карточки, а не выталкивает grid-сетку страницы.
    expect(src).toMatch(/cut-readiness-materials-scroll\b/);
    // Корневой класс для скоупа CSS («высота 100%», align с
    // парным «Изделие» и т.п.).
    expect(src).toMatch(/cut-readiness-card\b/);
  });
});
