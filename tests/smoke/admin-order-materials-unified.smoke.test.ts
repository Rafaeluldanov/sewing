/**
 * Smoke-тесты для рефакторинга «единый рабочий экран закупщика»
 * — вкладка «Материалы» карточки заказа `/admin/orders/[id]`.
 *
 * Source-of-truth:
 *   - Tab wrapper:     `apps/web/components/orders/tabs/order-materials-tab.tsx`
 *   - Unified table:   `apps/web/components/orders/materials/order-materials-unified-table.tsx`
 *   - Row builder:     `apps/web/components/orders/materials/build-order-material-rows.ts`
 *   - Manual unblock:  `apps/web/components/orders/materials/manual-material-arrival-actions.tsx`
 *   - Page wiring:     `apps/web/app/admin/orders/[id]/page.tsx`
 *   - Styles:          `apps/web/app/globals.css`
 *
 * Цели проверок:
 *   1. Вкладка «Материалы» больше не содержит отдельных карточек
 *      `WorkshopNeedsCard` / `OrderCostEstimateCard` /
 *      `CutReadinessCard` — они склеены в одну таблицу.
 *   2. Таблица содержит все 12 обязательных колонок (см. ТЗ §3).
 *   3. Под таблицей — компактный блок ручной разблокировки кроя
 *      с пояснением «не создаёт складскую приёмку».
 *   4. Existing actions переиспользуются (`MaterialArrivedButton`,
 *      `RevokeMaterialArrivalButton`, `markOrderMaterialArrivedAction`).
 *   5. Backend / Prisma / WorkshopNeed / OrderCostEstimate /
 *      CutReadinessService / OrderMaterialArrivalOverride logic
 *      НЕ менялись — это UI/layout refactor.
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
// 1. Files exist
// ---------------------------------------------------------------------------

describe('Materials tab — компоненты existуют', () => {
  test('файлы новых компонентов на месте', () => {
    expect(
      exists('apps/web/components/orders/tabs/order-materials-tab.tsx'),
    ).toBe(true);
    expect(
      exists(
        'apps/web/components/orders/materials/order-materials-unified-table.tsx',
      ),
    ).toBe(true);
    expect(
      exists(
        'apps/web/components/orders/materials/build-order-material-rows.ts',
      ),
    ).toBe(true);
    expect(
      exists(
        'apps/web/components/orders/materials/manual-material-arrival-actions.tsx',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Page wiring: вкладка «Материалы» использует новый wrapper
// ---------------------------------------------------------------------------

describe('/admin/orders/[id] — needs tab использует OrderMaterialsUnifiedTable через OrderNeedsTab', () => {
  const pageSrc = read('apps/web/app/admin/orders/[id]/page.tsx');
  const needsTabSrc = read(
    'apps/web/components/orders/view/tabs/order-needs-tab.tsx',
  );

  test('страница импортирует OrderNeedsTab (вкладка «Потребности»)', () => {
    expect(pageSrc).toMatch(/OrderNeedsTab/);
    expect(pageSrc).toMatch(
      /from '@\/components\/orders\/view\/tabs\/order-needs-tab'/,
    );
  });

  test('OrderNeedsTab рендерит unified-таблицу + ManualMaterialArrivalActions', () => {
    expect(needsTabSrc).toMatch(/<OrderMaterialsUnifiedTable\b/);
    expect(needsTabSrc).toMatch(/<ManualMaterialArrivalActions\b/);
    expect(needsTabSrc).not.toMatch(/<WorkshopNeedsCard\b/);
    expect(needsTabSrc).not.toMatch(/<CutReadinessCard\b/);
  });

  test('страница больше не импортирует WorkshopNeedsCard / CutReadinessCard / OrderMaterialsTab', () => {
    expect(pageSrc).not.toMatch(/import\s*\{\s*WorkshopNeedsCard\s*\}/);
    expect(pageSrc).not.toMatch(/import\s*\{\s*CutReadinessCard\s*\}/);
    expect(pageSrc).not.toMatch(/import\s*\{\s*OrderMaterialsTab\s*\}/);
  });

  test('OrderNeedsTab прокидывает order / passports / canManage', () => {
    expect(pageSrc).toMatch(/<OrderNeedsTab[\s\S]*?order=\{order\}/);
    expect(pageSrc).toMatch(/<OrderNeedsTab[\s\S]*?passports=\{passports\}/);
    expect(pageSrc).toMatch(/canManage=\{isManager\}/);
  });
});

// ---------------------------------------------------------------------------
// 3. OrderMaterialsTab wrapper
// ---------------------------------------------------------------------------

describe('OrderMaterialsTab — wrapper рендерит таблицу + ручную разблокировку', () => {
  const src = read(
    'apps/web/components/orders/tabs/order-materials-tab.tsx',
  );

  test('экспортирует именованный server component', () => {
    expect(src).toMatch(/export\s+function\s+OrderMaterialsTab/);
  });

  test('рендерит OrderMaterialsUnifiedTable + ManualMaterialArrivalActions', () => {
    expect(src).toMatch(/<OrderMaterialsUnifiedTable\b/);
    expect(src).toMatch(/<ManualMaterialArrivalActions\b/);
    expect(src).toMatch(
      /from '@\/components\/orders\/materials\/order-materials-unified-table'/,
    );
    expect(src).toMatch(
      /from '@\/components\/orders\/materials\/manual-material-arrival-actions'/,
    );
  });

  test('не импортирует legacy-карточки (WorkshopNeedsCard / OrderCostEstimateCard / CutReadinessCard)', () => {
    // JSDoc может упоминать имена этих карточек как «что мы НЕ
    // рендерим», поэтому проверяем именно импорты + JSX, а не
    // substring всего файла.
    expect(src).not.toMatch(/import\s*\{[^}]*WorkshopNeedsCard[^}]*\}/);
    expect(src).not.toMatch(/import\s*\{[^}]*OrderCostEstimateCard[^}]*\}/);
    expect(src).not.toMatch(/import\s*\{[^}]*CutReadinessCard[^}]*\}/);
    expect(src).not.toMatch(/<WorkshopNeedsCard\b/);
    expect(src).not.toMatch(/<OrderCostEstimateCard\b/);
    expect(src).not.toMatch(/<CutReadinessCard\b/);
  });
});

// ---------------------------------------------------------------------------
// 4. OrderMaterialsUnifiedTable
// ---------------------------------------------------------------------------

describe('OrderMaterialsUnifiedTable — единая таблица материалов', () => {
  const src = read(
    'apps/web/components/orders/materials/order-materials-unified-table.tsx',
  );

  test('async server component с data-testid=order-materials-unified-table', () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+OrderMaterialsUnifiedTable/,
    );
    expect(src).toMatch(/data-testid="order-materials-unified-table"/);
  });

  test('использует existing API-обёртки, не дублируя backend-вызовы', () => {
    // Helpers из `@/lib/*-api` — те же, что и у legacy-карточек,
    // никаких новых backend-эндпоинтов мы не добавляли.
    expect(src).toMatch(/getOrderWorkshopNeeds/);
    expect(src).toMatch(/getOrderCutReadiness/);
    expect(src).toMatch(/getOrderPurchaseOrders/);
    expect(src).toMatch(/getOrderPurchaseReceipts/);
  });

  test('использует helper buildOrderMaterialRows', () => {
    expect(src).toMatch(/buildOrderMaterialRows/);
    expect(src).toMatch(
      /from '\.\/build-order-material-rows'/,
    );
  });

  test('таблица содержит все 12 колонок ТЗ', () => {
    const expectedHeaders = [
      "header: 'Роль'",
      "header: 'Описание'",
      "header: 'Чистая'",
      "header: 'К закупке'",
      "header: 'Цена'",
      "header: 'Сумма'",
      "header: 'Принято'",
      "header: 'В ячейках'",
      "header: 'Статус'",
      "header: 'Дата поступления'",
      "header: 'Поставщик'",
      "header: 'Комментарий'",
    ];
    let prev = -1;
    for (const h of expectedHeaders) {
      const idx = src.indexOf(h);
      expect(idx, `column ${h} not found`).toBeGreaterThan(-1);
      expect(idx, `column ${h} should follow previous`).toBeGreaterThan(prev);
      prev = idx;
    }
  });

  test('строка таблицы НЕ повторяет название номенклатуры / номер заказа / клиента', () => {
    // Эти данные живут в hero и во вкладке «Продукция»;
    // в строках таблицы материалов их быть не должно.
    expect(src).not.toMatch(/nomenclatureName/);
    expect(src).not.toMatch(/orderNumber/);
    expect(src).not.toMatch(/clientName\b/);
    expect(src).not.toMatch(/order\.customer\b/);
  });

  test('hardware enrichment виден через DescriptionCell (size / material / color / image)', () => {
    expect(src).toMatch(/DescriptionCell/);
    // metaText собран из hardware* + color* в build-order-material-rows.
    expect(src).toMatch(/metaText/);
    // requiresColorSelection отрисовывает warning-плашку.
    expect(src).toMatch(/requiresColorSelection/);
    expect(src).toMatch(/Цвет нужно указать в заказе/);
    // Маленькое preview через materialImageUrl (rendered в OriginalNeed).
    expect(src).toMatch(/imageUrl/);
  });

  test('рядом с warning «Цвет нужно указать в заказе» есть CTA «Указать цвет» во вкладку «Производство»', () => {
    // Текст CTA + ссылка на карточку заказа.
    expect(src).toMatch(/Указать цвет/);
    // CTA ведёт на ?tab=production#order-material-colors (блок «Цвета
    // по строкам техкарты» переехал из удалённой вкладки «План» в
    // «Производство», см. ТЗ §C).
    expect(src).toMatch(/\?tab=production#order-material-colors/);
    expect(src).toMatch(/data-testid="order-materials-color-cta"/);
    // orderId прокидывается из таблицы внутрь DescriptionCell, не
    // придумывается на месте — иначе стабильной ссылки не будет.
    expect(src).toMatch(/<DescriptionCell\s+row=\{row\}\s+orderId=\{orderId\}/);
  });

  test('таблица НЕ становится source of truth по цвету: нет inline-формы / PATCH-логики', () => {
    // Primary-edit для selectedColorText живёт в OrderMaterialColorsCard
    // (вкладка «Производство»), в Needs остаются только warning + CTA-ссылка.
    expect(src).not.toMatch(/MaterialColorForm/);
    expect(src).not.toMatch(/updateOrderMaterialRequirementColor/);
    expect(src).not.toMatch(/<form\b/);
    expect(src).not.toMatch(/useFormState/);
    expect(src).not.toMatch(/'use client'/);
  });

  test('сумма строки = qty × price (lineTotalRub / lineTotalUsd)', () => {
    expect(src).toMatch(/lineTotalRub/);
    expect(src).toMatch(/lineTotalUsd/);
    expect(src).toMatch(/<TotalCell\s+row=\{row\}/);
  });

  test('Принято и «В ячейках» — отдельные колонки', () => {
    expect(src).toMatch(/receivedQty/);
    expect(src).toMatch(/placedQty/);
    expect(src).toMatch(/В ячейках/);
    expect(src).toMatch(/Принято/);
  });

  test('summary над таблицей: строки / сумма / блокеры (без отдельных карточек)', () => {
    expect(src).toMatch(/order-materials-table-card__summary/);
    expect(src).toMatch(/data-testid="order-materials-summary-rows"/);
    expect(src).toMatch(/data-testid="order-materials-summary-blockers"/);
  });
});

// ---------------------------------------------------------------------------
// 5. buildOrderMaterialRows helper
// ---------------------------------------------------------------------------

describe('buildOrderMaterialRows — pure web-helper, не трогает backend', () => {
  const src = read(
    'apps/web/components/orders/materials/build-order-material-rows.ts',
  );

  test('экспортирует тип OrderMaterialTableRow со всеми колонками таблицы', () => {
    expect(src).toMatch(/export\s+interface\s+OrderMaterialTableRow\s*\{/);
    expect(src).toMatch(/roleLabel:\s*string/);
    expect(src).toMatch(/description:\s*string/);
    expect(src).toMatch(/calculatedQty:\s*string/);
    expect(src).toMatch(/purchaseQty:\s*string \| null/);
    expect(src).toMatch(/quotedPrice:\s*string \| null/);
    expect(src).toMatch(/lineTotalRub:\s*string \| null/);
    expect(src).toMatch(/receivedQty:\s*string/);
    expect(src).toMatch(/placedQty:\s*string/);
    expect(src).toMatch(/statusLabel:\s*string/);
    expect(src).toMatch(/expectedOrReceivedDate:\s*string \| null/);
    expect(src).toMatch(/supplierName:\s*string \| null/);
    expect(src).toMatch(/commentText:\s*string \| null/);
    expect(src).toMatch(/warnings:\s*string\[\]/);
  });

  test('экспортирует buildOrderMaterialRows и summariseOrderMaterialRows', () => {
    expect(src).toMatch(/export\s+function\s+buildOrderMaterialRows/);
    expect(src).toMatch(/export\s+function\s+summariseOrderMaterialRows/);
  });

  test('лейблы ролей соответствуют ТЗ §6 (PACKAGING → «Фурнитура», unknown → «Прочее»)', () => {
    expect(src).toMatch(/MAIN_FABRIC: 'Основной материал'/);
    expect(src).toMatch(/RIB: 'Рибана \/ кашкорсе'/);
    expect(src).toMatch(/LINING: 'Подкладка'/);
    expect(src).toMatch(/FILLER: 'Наполнитель'/);
    expect(src).toMatch(/INTERLINING: 'Дублерин \/ клеевые'/);
    expect(src).toMatch(/THREAD: 'Нитки'/);
    expect(src).toMatch(/PACKAGING: 'Фурнитура'/);
    expect(src).toMatch(/MARKING: 'Маркировка'/);
    expect(src).toMatch(/APPLICATION: 'Нанесение'/);
    expect(src).toMatch(/return 'Прочее'/);
  });

  test('статусы строки имеют приоритеты ТЗ §14 (Нужен цвет → Нет цены → Принято → …)', () => {
    expect(src).toMatch(/Нужен цвет/);
    expect(src).toMatch(/Нет цены/);
    expect(src).toMatch(/Принято/);
    expect(src).toMatch(/Готово к крою/);
    expect(src).toMatch(/Заказан/);
    expect(src).toMatch(/Разблокировано вручную/);
  });

  test('сумма строки считается из qtyForTotal × price (RUB или USD)', () => {
    // Реализация умножает purchaseQty ?? calculatedQty на
    // quotedPrice. В исходнике это идёт через `toFiniteNumber(...)
    // ?? toFiniteNumber(...)`, поэтому проверяем оба слагаемых
    // и сам `??` сепаратор отдельно от закрывающих скобок.
    expect(src).toMatch(/need\.purchaseQty/);
    expect(src).toMatch(/need\.calculatedQty/);
    expect(src).toMatch(/qtyForTotal/);
    expect(src).toMatch(/priceNum\s*\*\s*qtyForTotal/);
    expect(src).toMatch(/lineTotalRub/);
    expect(src).toMatch(/lineTotalUsd/);
    // USD-строки помечаются warning-ом, не подмешиваются в RUB-итог.
    expect(src).toMatch(/USD без курса/);
  });

  test('helper НЕ дёргает backend напрямую (только pure-функции и shared DTO)', () => {
    // Никаких import из @/lib/*-api здесь быть не должно — за загрузку
    // отвечает компонент.
    expect(src).not.toMatch(/from '@\/lib\//);
    // Никаких импортов prisma / @sewing/api / nest.
    expect(src).not.toMatch(/from '@prisma\/client'/);
    expect(src).not.toMatch(/@nestjs\//);
  });

  test('фильтрует stale calculationNote «Цвет нужно указать в заказе», если selectedColorText/resolvedColorText уже заполнен (см. ТЗ §E)', () => {
    // Backend (workshop-needs.service.ts) пишет
    // `calculationNote = "Цвет нужно указать в заказе"` в момент
    // calculateForOrder и не пересчитывает её после PATCH цвета.
    // UI должен прятать stale-нотку, иначе свежий selectedColorText
    // будет «перекрыт» старым предупреждением в колонке Комментарий.
    expect(src).toMatch(/isColorWarningNote/);
    expect(src).toMatch(/Цвет нужно указать в заказе/);
    expect(src).toMatch(/filteredCalculationNote/);
  });
});

// ---------------------------------------------------------------------------
// 6. ManualMaterialArrivalActions
// ---------------------------------------------------------------------------

describe('ManualMaterialArrivalActions — компактная ручная разблокировка кроя', () => {
  const src = read(
    'apps/web/components/orders/materials/manual-material-arrival-actions.tsx',
  );

  test('async server component, использует MaterialArrivedButton (existing action)', () => {
    expect(src).toMatch(
      /export\s+async\s+function\s+ManualMaterialArrivalActions/,
    );
    expect(src).toMatch(/MaterialArrivedButton/);
    expect(src).toMatch(
      /from '@\/components\/orders\/material-arrived-button'/,
    );
  });

  test('подсказка «Ручная отметка ... не создаёт складскую приёмку»', () => {
    expect(src).toMatch(
      /Ручная отметка разблокирует крой, но не создаёт складскую/,
    );
    expect(src).toMatch(/приёмку/);
  });

  test('подключает RevokeMaterialArrivalButton для активных overrides', () => {
    expect(src).toMatch(/RevokeMaterialArrivalButton/);
    expect(src).toMatch(
      /from '@\/components\/orders\/revoke-material-arrival-button'/,
    );
  });

  test('кнопка скрывается для DONE / CANCELLED статусов заказа', () => {
    expect(src).toMatch(/'DONE'/);
    expect(src).toMatch(/'CANCELLED'/);
    expect(src).toMatch(/isTerminalOrderStatus/);
  });

  test('блок не оформлен как большая отдельная карточка (без AdminCard / AdminSectionHeader)', () => {
    expect(src).not.toMatch(/AdminCard\b/);
    expect(src).not.toMatch(/AdminSectionHeader\b/);
  });

  test('активные overrides отображаются через details (compact, не карточкой)', () => {
    expect(src).toMatch(/<details/);
    expect(src).toMatch(/Ручные отметки:/);
    expect(src).toMatch(
      /data-testid="order-materials-manual-unlock-overrides"/,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. CSS classes
// ---------------------------------------------------------------------------

describe('globals.css — стили для unified materials table', () => {
  const css = read('apps/web/app/globals.css');

  test('базовые классы таблицы определены', () => {
    expect(css).toMatch(/\.order-materials-table-card\s*\{/);
    expect(css).toMatch(/\.order-materials-table-wrap\b/);
    expect(css).toMatch(/\.order-materials-table\s*\{/);
    expect(css).toMatch(/\.order-materials-table__role\b/);
    expect(css).toMatch(/\.order-materials-table__description\b/);
    expect(css).toMatch(/\.order-materials-table__description-main\b/);
    expect(css).toMatch(/\.order-materials-table__description-meta\b/);
    expect(css).toMatch(/\.order-materials-table__image\b/);
    expect(css).toMatch(/\.order-materials-table__qty\b/);
    expect(css).toMatch(/\.order-materials-table__money\b/);
    expect(css).toMatch(/\.order-materials-table__status\b/);
    expect(css).toMatch(/\.order-materials-table__warning\b/);
    expect(css).toMatch(/\.order-materials-table__comment\b/);
  });

  test('таблица имеет min-width для горизонтального скролла', () => {
    // После добавления колонок «План / факт» и «Стоимость план /
    // факт» (frontend-итерация «план/факт» поверх MaterialIssue)
    // min-width выросло — иначе ячейки сжимаются и плохо
    // читаются. Конкретное значение менять допустимо без backend
    // изменений, но min-width должен оставаться выше 1180px,
    // чтобы 14+ колонок укладывались.
    expect(css).toMatch(
      /\.order-materials-table\s*\{[\s\S]*?min-width:\s*1380px/,
    );
  });

  test('блок ручной разблокировки имеет свои классы (не AdminCard)', () => {
    expect(css).toMatch(/\.order-materials-manual-unlock\s*\{/);
    expect(css).toMatch(/\.order-materials-manual-unlock__hint\b/);
  });
});

// ---------------------------------------------------------------------------
// 8. Backend / Prisma не менялись (UI/layout refactor)
// ---------------------------------------------------------------------------

describe('Materials tab refactor — backend / Prisma НЕ менялись', () => {
  test('Prisma schema без новых таблиц для unified materials', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).not.toMatch(/model\s+OrderMaterialsUnifiedTable/);
    expect(schema).not.toMatch(/model\s+OrderMaterialRow\b/);
  });

  test('WorkshopNeedsService формулы расчёта не упоминают unified-таблицу', () => {
    const svc = read(
      'apps/api/src/modules/workshop-needs/workshop-needs.service.ts',
    );
    expect(svc).not.toMatch(/OrderMaterialsUnifiedTable/);
    expect(svc).not.toMatch(/buildOrderMaterialRows/);
  });

  test('CutReadinessService не упоминает unified-таблицу', () => {
    const svc = read(
      'apps/api/src/modules/cut-readiness/cut-readiness.service.ts',
    );
    expect(svc).not.toMatch(/OrderMaterialsUnifiedTable/);
  });

  test('OrderMaterialArrivalsService не менялся под unified-таблицу', () => {
    const svc = read(
      'apps/api/src/modules/order-material-arrivals/order-material-arrivals.service.ts',
    );
    expect(svc).not.toMatch(/OrderMaterialsUnifiedTable/);
  });

  test('OrderCostEstimatesService не менялся под unified-таблицу', () => {
    const svc = read(
      'apps/api/src/modules/orders/order-cost-estimates.service.ts',
    );
    expect(svc).not.toMatch(/OrderMaterialsUnifiedTable/);
  });

  test('helper buildOrderMaterialRows живёт строго в apps/web (не shared, не backend)', () => {
    expect(
      exists(
        'apps/web/components/orders/materials/build-order-material-rows.ts',
      ),
    ).toBe(true);
    // Не появилось дублёра в shared или backend.
    expect(
      exists('packages/shared/src/order-materials-unified-table.ts'),
    ).toBe(false);
    expect(
      exists('apps/api/src/modules/order-materials-unified-table'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Existing actions preserved
// ---------------------------------------------------------------------------

describe('Existing actions preserved', () => {
  test('material-arrivals server actions не изменились по экспортам', () => {
    const src = read(
      'apps/web/app/admin/orders/[id]/material-arrivals-actions.ts',
    );
    expect(src).toMatch(/export\s+async\s+function\s+markOrderMaterialArrivedAction/);
    expect(src).toMatch(
      /export\s+async\s+function\s+revokeOrderMaterialArrivalOverrideAction/,
    );
    // `'use server'` файл экспортирует ТОЛЬКО async-функции — иначе
    // Next.js роняет рендер страницы целиком («A "use server" file can
    // only export async functions, found object»). Initial state живёт
    // в соседнем модуле без директивы.
    expect(src).not.toMatch(/^export\s+(const|let|var|class|enum)\s/m);
    const formState = read(
      'apps/web/app/admin/orders/[id]/material-arrivals-form-state.ts',
    );
    expect(formState).toMatch(/initialOrderMaterialArrivalsFormState/);
  });

  test('MaterialArrivedButton всё ещё зовёт markOrderMaterialArrivedAction', () => {
    const btn = read('apps/web/components/orders/material-arrived-button.tsx');
    expect(btn).toMatch(/markOrderMaterialArrivedAction/);
  });
});
