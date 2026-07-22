/**
 * Source-level smoke-тесты polish-итерации `/admin/workshop-needs`
 * (см. `apps/web/app/admin/workshop-needs/page.tsx`,
 * `apps/api/src/modules/workshop-needs/workshop-needs.service.ts`,
 * `packages/shared/src/workshop-needs.ts`).
 *
 * Что проверяем:
 *   - DTO содержит новые «лёгкие» поля заказа / клиента / номенклатуры
 *     (`clientName`, `nomenclatureName`, `nomenclaturePreviewImageUrl`,
 *     `orderDueDate`, `orderColor`, `nomenclatureSource`);
 *   - сервис подтягивает их через `include order.client` и
 *     `order.patternItem`;
 *   - shared экспортирует helper `getWorkshopNeedKind` с правильной
 *     классификацией `PATTERN_PARAMETER_NORM → HARDWARE`,
 *     `ORDER_APPLICATION → APPLICATION`,
 *     `ORDER_MATERIAL_REQUIREMENT → MATERIAL`;
 *   - страница `/admin/workshop-needs` имеет переключатель режимов
 *     «По заказам» / «Построчно» с default `view=orders`, рисует
 *     четыре секции (Материалы / Фурнитура / Нанесение / Прочее),
 *     показывает превью + клиента в табличном режиме и не ломает
 *     существующий BulkCreatePo / фильтры.
 *
 * Эти проверки — source-level (без поднятия БД), как и остальные
 * smoke-тесты в этой папке.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  WORKSHOP_NEED_KINDS,
  WORKSHOP_NEED_KIND_LABELS,
  getWorkshopNeedKind,
} from '@sewing/shared/workshop-needs';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Shared DTO
// ---------------------------------------------------------------------------

describe('Shared workshop-needs DTO — polish-итерация', () => {
  const src = read('packages/shared/src/workshop-needs.ts');

  test('WorkshopNeedDto содержит новые поля заказа / клиента / номенклатуры', () => {
    // orderNumber уже был — здесь проверяем, что он остался
    expect(src).toMatch(/orderNumber:\s*string\s*\|\s*null/);
    expect(src).toMatch(/orderStatus:\s*string\s*\|\s*null/);
    expect(src).toMatch(/orderDueDate:\s*string\s*\|\s*null/);
    expect(src).toMatch(/orderColor:\s*string\s*\|\s*null/);
    expect(src).toMatch(/clientId:\s*string\s*\|\s*null/);
    expect(src).toMatch(/clientName:\s*string\s*\|\s*null/);
    expect(src).toMatch(/nomenclatureName:\s*string\s*\|\s*null/);
    expect(src).toMatch(/nomenclatureArticle:\s*string\s*\|\s*null/);
    expect(src).toMatch(/nomenclaturePreviewImageUrl:\s*string\s*\|\s*null/);
    expect(src).toMatch(/nomenclatureSource:\s*WorkshopNeedNomenclatureSource/);
  });

  test('WorkshopNeedListItemDto = WorkshopNeedDto (тонкий тип)', () => {
    expect(src).toMatch(
      /WorkshopNeedListItemDto\s*=\s*WorkshopNeedDto/,
    );
  });

  test('Источник номенклатуры — snapshot/pattern/legacyProduct/none', () => {
    expect(src).toMatch(/'snapshot'/);
    expect(src).toMatch(/'pattern'/);
    expect(src).toMatch(/'legacyProduct'/);
    expect(src).toMatch(/'none'/);
  });

  test('WORKSHOP_NEED_KINDS / лейблы экспортируются', () => {
    expect(src).toMatch(/WORKSHOP_NEED_KINDS/);
    expect(src).toMatch(/WORKSHOP_NEED_KIND_LABELS/);
    expect(WORKSHOP_NEED_KINDS).toEqual([
      'MATERIAL',
      'HARDWARE',
      'APPLICATION',
      'OTHER',
    ]);
    expect(WORKSHOP_NEED_KIND_LABELS).toEqual({
      MATERIAL: 'Материалы',
      HARDWARE: 'Фурнитура',
      APPLICATION: 'Нанесение',
      OTHER: 'Прочее',
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Helper getWorkshopNeedKind
// ---------------------------------------------------------------------------

describe('getWorkshopNeedKind — классификатор типа потребности', () => {
  test('PATTERN_PARAMETER_NORM + materialRole=PACKAGING → HARDWARE (Фурнитура)', () => {
    // Этап «Исправить формирование Потребности цеха» (см. ТЗ §7):
    // классификатор смотрит сперва на materialRole. PACKAGING-роль —
    // это «Фурнитура», независимо от sourceType. Без роли (legacy
    // строка) PATTERN_PARAMETER_NORM теперь возвращает 'OTHER',
    // потому что в реальной БД у норм фурнитуры всегда есть
    // roleKey snapshot (см. `PatternsService.replaceParameterNorms`).
    expect(
      getWorkshopNeedKind({
        sourceType: 'PATTERN_PARAMETER_NORM',
        calculationMethod: 'QTY_PER_UNIT',
        materialRole: 'PACKAGING',
      }),
    ).toBe('HARDWARE');
  });

  test('ORDER_APPLICATION → APPLICATION (Нанесение)', () => {
    expect(
      getWorkshopNeedKind({
        sourceType: 'ORDER_APPLICATION',
        calculationMethod: 'QTY_PER_UNIT',
      }),
    ).toBe('APPLICATION');
  });

  test('ORDER_MATERIAL_REQUIREMENT → MATERIAL', () => {
    expect(
      getWorkshopNeedKind({
        sourceType: 'ORDER_MATERIAL_REQUIREMENT',
        calculationMethod: 'AREA_DENSITY',
      }),
    ).toBe('MATERIAL');
  });

  test('TECH_CARD_MATERIAL_LINE → MATERIAL', () => {
    expect(
      getWorkshopNeedKind({
        sourceType: 'TECH_CARD_MATERIAL_LINE',
        calculationMethod: 'QTY_PER_UNIT',
      }),
    ).toBe('MATERIAL');
  });

  test('AREA_DENSITY (без sourceType) → MATERIAL', () => {
    expect(
      getWorkshopNeedKind({
        sourceType: null,
        calculationMethod: 'AREA_DENSITY',
      }),
    ).toBe('MATERIAL');
  });

  test('Неизвестный sourceType + QTY_PER_UNIT → OTHER', () => {
    expect(
      getWorkshopNeedKind({
        sourceType: 'SOMETHING_ELSE',
        calculationMethod: 'QTY_PER_UNIT',
      }),
    ).toBe('OTHER');
  });

  test('Несколько PATTERN_PARAMETER_NORM с PACKAGING остаются HARDWARE', () => {
    // Три нормы с одним roleKey = PACKAGING (Люверсы / Шнур / Наконечники)
    // — все должны попасть в одну секцию «Фурнитура», но как
    // отдельные строки. Группировка идёт по materialRole, поэтому
    // в helper передаём roleKey (см. ТЗ §7).
    const inputs = [
      { sourceType: 'PATTERN_PARAMETER_NORM', materialRole: 'PACKAGING' },
      { sourceType: 'PATTERN_PARAMETER_NORM', materialRole: 'PACKAGING' },
      { sourceType: 'PATTERN_PARAMETER_NORM', materialRole: 'PACKAGING' },
    ];
    for (const i of inputs) {
      expect(
        getWorkshopNeedKind({
          sourceType: i.sourceType,
          calculationMethod: 'QTY_PER_UNIT',
          materialRole: i.materialRole,
        }),
      ).toBe('HARDWARE');
    }
  });

  test('PATTERN_PARAMETER_NORM с THREAD/FILLER → MATERIAL (а не HARDWARE)', () => {
    // Этап «Исправить формирование Потребности цеха» (см. ТЗ §7):
    // нитки / синтепон / наполнитель не должны падать в «Фурнитуру»
    // только из-за QTY_PER_UNIT источника. Это прямой регрессионный
    // pin: до этапа была баг-классификация.
    for (const role of ['THREAD', 'FILLER', 'INTERLINING'] as const) {
      expect(
        getWorkshopNeedKind({
          sourceType: 'PATTERN_PARAMETER_NORM',
          calculationMethod: 'QTY_PER_UNIT',
          materialRole: role,
        }),
        `expected role=${role} to be MATERIAL`,
      ).toBe('MATERIAL');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Backend service mapper
// ---------------------------------------------------------------------------

describe('WorkshopNeedsService — include/toDto polish', () => {
  const src = read(
    'apps/api/src/modules/workshop-needs/workshop-needs.service.ts',
  );

  test('include подтягивает order.client и order.patternItem', () => {
    expect(src).toMatch(/order:\s*\{[\s\S]*?client:\s*\{\s*select/);
    expect(src).toMatch(
      /patternItem:\s*\{\s*select:\s*\{\s*id:\s*true,\s*name:\s*true,\s*article:\s*true,\s*previewImageUrl:\s*true/,
    );
    // Snapshot-поля заказа должны быть в селекте.
    expect(src).toMatch(/patternNameSnapshot:\s*true/);
    expect(src).toMatch(/patternArticleSnapshot:\s*true/);
    expect(src).toMatch(/patternPreviewSnapshotUrl:\s*true/);
    // dueDate / color / customer / clientId — для UI группировки.
    expect(src).toMatch(/dueDate:\s*true/);
    expect(src).toMatch(/color:\s*true/);
    expect(src).toMatch(/customer:\s*true/);
    expect(src).toMatch(/clientId:\s*true/);
  });

  test('toDto заполняет nomenclatureName/Article/Preview по resolver-у', () => {
    expect(src).toMatch(/nomenclatureName/);
    expect(src).toMatch(/nomenclatureArticle/);
    expect(src).toMatch(/nomenclaturePreviewImageUrl/);
    expect(src).toMatch(/nomenclatureSource/);
    // Resolver: snapshot имеет приоритет, productName — fallback.
    expect(src).toMatch(/snapshotName\s*=\s*order\?\.patternNameSnapshot/);
    expect(src).toMatch(/liveName\s*=\s*order\?\.patternItem\?\.name/);
    expect(src).toMatch(/legacyProductName\s*=/);
    // Source priorities в правильном порядке (snapshot → pattern → legacyProduct → none).
    const orderRegex =
      /if\s*\(snapshotName\)[\s\S]*?else\s+if\s*\(liveName\)[\s\S]*?else\s+if\s*\(legacyProductName\)[\s\S]*?else\s*\{[\s\S]*?nomenclatureSource\s*=\s*'none'/;
    expect(src).toMatch(orderRegex);
  });

  test('clientName: order.client.name → fallback на order.customer', () => {
    expect(src).toMatch(
      /clientName\s*=\s*\n?\s*order\?\.client\?\.name\s*\?\?\s*order\?\.customer/,
    );
  });

  test('toDto отдаёт orderDueDate (ISO) и orderColor', () => {
    expect(src).toMatch(/orderDueDate:\s*order\?\.dueDate/);
    expect(src).toMatch(/orderColor:\s*order\?\.color/);
  });

  test('calculateForOrder не менялся (защита от регрессии)', () => {
    // Всё ещё содержит ключевые куски расчёта.
    expect(src).toMatch(/async calculateForOrder\(/);
    expect(src).toMatch(/AREA_DENSITY/);
    expect(src).toMatch(/QTY_PER_UNIT/);
    expect(src).toMatch(/sourceType: 'PATTERN_PARAMETER_NORM'/);
    expect(src).toMatch(/sourceType: 'ORDER_APPLICATION'/);
  });
});

// ---------------------------------------------------------------------------
// 4. /admin/workshop-needs page
// ---------------------------------------------------------------------------

describe('/admin/workshop-needs — view toggle и группировка', () => {
  const src = read('apps/web/app/admin/workshop-needs/page.tsx');

  test('Единственный режим — группировка по заказам (переключатель убран)', () => {
    // Прежний построчный режим и переключатель «По заказам / Построчно»
    // удалены — осталась только группировка по заказу.
    expect(src).not.toMatch(/workshop-needs-view-toggle/);
    expect(src).not.toMatch(/Построчно/);
    expect(src).not.toMatch(/view:\s*'lines'/);
    expect(src).toMatch(/OrdersView/);
  });

  test('Параметр ?view и parseView удалены', () => {
    expect(src).not.toMatch(/parseView/);
    expect(src).not.toMatch(/ViewMode/);
  });

  test('Group view группирует по orderId и рисует OrderNeedGroupCard', () => {
    expect(src).toMatch(/groupByOrder/);
    expect(src).toMatch(/OrderNeedGroupCard/);
    // Использует map по orderId.
    expect(src).toMatch(/map\.get\(need\.orderId\)/);
  });

  test('Карточка заказа содержит секции Материалы / Фурнитура / Нанесение / Прочее', () => {
    expect(src).toMatch(/MATERIAL/);
    expect(src).toMatch(/HARDWARE/);
    expect(src).toMatch(/APPLICATION/);
    expect(src).toMatch(/OTHER/);
    expect(src).toMatch(/getWorkshopNeedKind/);
    expect(src).toMatch(/WORKSHOP_NEED_KIND_LABELS/);
  });

  test('В карточке заказа видны клиент / номенклатура / цвет / срок / статус', () => {
    expect(src).toMatch(/n\.clientName|sample\.clientName/);
    expect(src).toMatch(/nomenclatureName/);
    expect(src).toMatch(/orderColor/);
    expect(src).toMatch(/orderDueDate/);
    expect(src).toMatch(/orderStatus/);
    expect(src).toMatch(/getOrderStatusTone/);
  });

  test('Превью изделия: snapshot / pattern (через nomenclaturePreviewImageUrl)', () => {
    expect(src).toMatch(/nomenclaturePreviewImageUrl/);
    expect(src).toMatch(/workshop-order-preview/);
    // Lines view тоже показывает мини-превью + клиента.
    expect(src).toMatch(/workshop-order-preview--sm/);
    expect(src).toMatch(/workshop-order-preview--md/);
  });

  test('Построчный режим удалён, вход в карточку — ссылка «Подробности»', () => {
    // Прежний построчный вид (LinesView / NeedsLinesList) и проп
    // showOrderInfo удалены. Вход в полную карточку
    // /admin/workshop-needs/[id] — по ссылке «Подробности» прямо
    // в зональной строке потребности.
    expect(src).not.toMatch(/LinesView/);
    expect(src).not.toMatch(/NeedsLinesList/);
    expect(src).toMatch(/InlineEditWorkshopNeedRow/);
    const inline = readFileSync(
      path.join(repoRoot, 'apps/web/app/admin/workshop-needs/inline-edit-row.tsx'),
      'utf8',
    );
    expect(inline).toMatch(/Подробности/);
    expect(inline).toMatch(/wn-zrow__detail-link/);
    // Ссылка ведёт на карточку /admin/workshop-needs/[id].
    expect(inline).toMatch(
      /\/admin\/workshop-needs\/\$\{encodeURIComponent\(need\.id\)\}/,
    );
  });

  test('Empty states зависят от orderCalculationStatus', () => {
    // Итерация «Фильтр статуса расчёта»: тексты пустых состояний
    // подбираются из `EmptyOrdersState` по выбранному фильтру.
    expect(src).toMatch(/Нет заказов в расчёте/);
    expect(src).toMatch(/Нет завершённых расчётов/);
    expect(src).toMatch(/Потребностей пока нет/);
    // Подсказка про перевод заказа в «Расчёт» — для default-фильтра.
    expect(src).toMatch(/Переведите заказ в статус «Расчёт»/);
  });

  test('BulkCreatePo + фильтры (search / orderCalculationStatus / orderId)', () => {
    // BulkCreatePoProvider оборачивает сгруппированный по заказам
    // список (OrdersView), если включён feature-flag покупательских
    // заказов. BulkCreatePoCheckbox рендерится внутри строки
    // `InlineEditWorkshopNeedRow`, а не на верхнем уровне page.tsx.
    expect(src).toMatch(/BulkCreatePoProvider/);
    // search / orderCalculationStatus / orderId — параметры фильтра
    // верхнего уровня. Старый `status` (по `WorkshopNeed.status`)
    // страница НЕ использует — см. JSDoc файла, она его игнорирует.
    expect(src).toMatch(/searchParams\?\.search/);
    expect(src).toMatch(/searchParams\?\.orderId/);
    expect(src).toMatch(/orderCalculationStatus,/);
    expect(src).not.toMatch(/status:\s*status\s*\|\|\s*undefined/);
    // Bulk-чекбокс живёт внутри inline-edit-row.
    const inline = readFileSync(
      path.join(repoRoot, 'apps/web/app/admin/workshop-needs/inline-edit-row.tsx'),
      'utf8',
    );
    expect(inline).toMatch(/BulkCreatePoCheckbox/);
  });
});

// ---------------------------------------------------------------------------
// 5. CSS
// ---------------------------------------------------------------------------

describe('/admin/workshop-needs — CSS-классы polish', () => {
  const css = read('apps/web/app/globals.css');

  test('классы карточки заказа и секций добавлены в globals.css', () => {
    expect(css).toMatch(/\.workshop-order-group-card\b/);
    expect(css).toMatch(/\.workshop-order-group-card__header\b/);
    expect(css).toMatch(/\.workshop-order-preview\b/);
    expect(css).toMatch(/\.workshop-need-section\b/);
    expect(css).toMatch(/\.workshop-need-row\b/);
    expect(css).toMatch(/\.workshop-need-kind-badge\b/);
    // Тоны секций по 4 типам.
    expect(css).toMatch(/\.workshop-need-section--material\b/);
    expect(css).toMatch(/\.workshop-need-section--hardware\b/);
    expect(css).toMatch(/\.workshop-need-section--application\b/);
    expect(css).toMatch(/\.workshop-need-section--other\b/);
  });
});

// ---------------------------------------------------------------------------
// 6. SaaS-итерация «Карточка заказа» (`view=orders`)
// ---------------------------------------------------------------------------
//
// Проверяем требования к новому дизайну `view=orders`:
//   - карточка заказа имеет header с identity-блоком (preview +
//     orderNumber + клиент + nomenclature + цвет + срок + статус);
//   - в правом верхнем углу карточки — actions-блок
//     («Открыть заказ» + `<CompleteCalculationForm variant="compact">`),
//     никакого «footer» с большой кнопкой завершения расчёта;
//   - body карточки содержит до четырёх секций (Материалы /
//     Фурнитура / Нанесение / Прочее), каждая — со своей подписью
//     `workshop-need-section__label` и счётчиком; секция
//     рендерится только если в ней есть строки;
//   - строки потребности в `view=orders` — это
//     `<InlineEditWorkshopNeedRow showOrderInfo={false}>`, а в
//     `view=lines` — `<InlineEditWorkshopNeedRow showOrderInfo>`;
//   - комментарий по умолчанию скрыт, есть toggle-кнопка.
//
// Backend / Prisma / DTO / расчёт WorkshopNeed / OrderCostEstimate /
// PurchaseOrder / Supplier / Order / Pattern / Product не меняются —
// поэтому отдельных проверок для них здесь не нужно (см.
// уже существующие smoke-тесты: `workshop-needs-admin`,
// `order-cost-estimates`, `purchase-orders-admin`).

describe('/admin/workshop-needs?view=orders — SaaS-карточка заказа', () => {
  const page = read('apps/web/app/admin/workshop-needs/page.tsx');
  const inline = read('apps/web/app/admin/workshop-needs/inline-edit-row.tsx');
  const completeForm = read(
    'apps/web/app/admin/workshop-needs/complete-calculation-form.tsx',
  );
  const css = read('apps/web/app/globals.css');

  test('OrderNeedGroupCard рисует saas-header c identity и actions', () => {
    // Фича «Варианты просчёта»: сам `<article
    // className="workshop-order-group-card">` переехал в
    // `collapse.tsx::CollapsibleOrderCard` (карточка сворачивается),
    // а страница передаёт в неё шапку через проп `head`.
    const collapse = read('apps/web/app/admin/workshop-needs/collapse.tsx');
    expect(collapse).toMatch(/className="workshop-order-group-card"/);
    expect(page).toMatch(/<CollapsibleOrderCard/);
    expect(page).toMatch(/workshop-order-group-card__header\b/);
    expect(page).toMatch(/workshop-order-group-card__identity\b/);
    expect(page).toMatch(/workshop-order-group-card__preview\b/);
    expect(page).toMatch(/workshop-order-group-card__meta\b/);
    expect(page).toMatch(/workshop-order-group-card__stats\b/);
    expect(page).toMatch(/workshop-order-group-card__actions\b/);
    expect(page).toMatch(/workshop-order-group-card__body\b/);
    // header содержит orderNumber, статус, клиент, номенклатуру,
    // цвет, срок (см. саму карточку).
    expect(page).toMatch(/sample\.orderNumber/);
    expect(page).toMatch(/sample\.orderStatus/);
    expect(page).toMatch(/sample\.clientName/);
    expect(page).toMatch(/sample\.nomenclatureName/);
    expect(page).toMatch(/sample\.orderColor/);
    expect(page).toMatch(/sample\.orderDueDate/);
  });

  test('CompleteCalculationForm живёт в actions-блоке, не в footer/body', () => {
    // Никакого `__footer` в карточке нет — кнопка завершения
    // расчёта компактно живёт в actions-блоке.
    expect(page).not.toMatch(/workshop-order-group-card__footer/);
    // CompleteCalculationForm подключается с `variant="compact"`.
    expect(page).toMatch(/<CompleteCalculationForm[\s\S]*?variant="compact"/);
    // CompleteCalculationForm всё ещё ходит в server-action, и
    // показывается только для CALCULATION-заказов.
    expect(page).toMatch(/sample\.orderStatus === 'CALCULATION'/);
    expect(completeForm).toMatch(/completeOrderCalculationAction/);
    expect(completeForm).toMatch(/variant\s*[:=]\s*['"]?compact/);
  });

  test('Секции «Материалы / Фурнитура / Нанесение / Прочее» рендерятся только при наличии строк', () => {
    // Bucket-логика: для каждой из 4 секций проверка `length > 0`.
    expect(page).toMatch(/buckets\[k\]\.length\s*>\s*0/);
    // Секция использует label + count, и подписан тон-modifier.
    // Разметка секции переехала в `collapse.tsx::CollapsibleSection`
    // (секция сворачивается и показывает сумму), страница передаёт в
    // неё kind/label/count.
    const collapse = read('apps/web/app/admin/workshop-needs/collapse.tsx');
    expect(collapse).toMatch(
      /workshop-need-section--\$\{kind\.toLowerCase\(\)\}/,
    );
    expect(collapse).toMatch(/workshop-need-section__label/);
    expect(collapse).toMatch(/workshop-need-section__count/);
    expect(collapse).toMatch(/workshop-need-section__rows/);
    expect(page).toMatch(/<CollapsibleSection/);
  });

  test('строки группы рендерятся через InlineEditWorkshopNeedRow без showOrderInfo', () => {
    // Проп showOrderInfo удалён вместе с построчным режимом.
    expect(page).not.toMatch(/showOrderInfo/);
    expect(page).toMatch(/<InlineEditWorkshopNeedRow/);
  });

  test('inline-edit-row: зональная строка `.wn-zrow`, превью/клиент — в header карточки', () => {
    // Корневой зональный grid строки.
    expect(inline).toMatch(/wn-zrow workshop-need-inline-form/);
    expect(inline).toMatch(/data-variant="orders"/);
    expect(inline).toMatch(/wn-zone--calc/);
    expect(inline).toMatch(/wn-zone--buy/);
    expect(inline).toMatch(/wn-zone--log/);
    // showOrderInfo больше нет — единственный режим.
    expect(inline).not.toMatch(/showOrderInfo/);
    // order-info ячейки строкой не рендерятся (они в header карточки).
    expect(inline).not.toMatch(/data-cell="order"/);
    // Bulk-чекбокс пускается только при `bulkSelect`.
    expect(inline).toMatch(/bulkSelect\s*&&/);
  });

  test('inline-edit-row: комментарий скрыт по умолчанию, есть toggle', () => {
    // useState для collapse + кнопка-toggle.
    expect(inline).toMatch(/setCommentOpen/);
    expect(inline).toMatch(/workshop-order-need-row__comment-button\b/);
    // Закрытое состояние — hidden input с тем же `name="comment"`,
    // чтобы submit отправлял текущее значение.
    expect(inline).toMatch(
      /<input[\s\S]*?type="hidden"[\s\S]*?name="comment"/,
    );
    // Открытое состояние — textarea (collapse).
    expect(inline).toMatch(/<textarea[\s\S]*?name="comment"/);
    // Индикатор «комментарий есть» рядом с кнопкой-toggle.
    expect(inline).toMatch(/workshop-order-need-row__comment-dot\b/);
    expect(inline).toMatch(/Комментарий есть/);
  });

  test('CSS: зональная строка `.wn-zrow` + зоны / поля / save / подвал', () => {
    expect(css).toMatch(/\.wn-zrow\b/);
    expect(css).toMatch(/\.wn-zone\b/);
    expect(css).toMatch(/\.wn-field\b/);
    expect(css).toMatch(/\.wn-save\b/);
    expect(css).toMatch(/\.wn-zrow__foot\b/);
    // Ссылка «Подробности» в подвале строки.
    expect(css).toMatch(/\.wn-zrow__detail-link\b/);
  });

  test('CSS: section-label / rows + компактная save-кнопка зоны', () => {
    expect(css).toMatch(/\.workshop-need-section__label\b/);
    expect(css).toMatch(/\.workshop-need-section__rows\b/);
    expect(css).toMatch(/\.wn-save\b/);
  });

  test('CSS: SaaS-карточка заказа имеет identity / preview / actions / body', () => {
    expect(css).toMatch(/\.workshop-order-group-card__identity\b/);
    expect(css).toMatch(/\.workshop-order-group-card__preview\b/);
    expect(css).toMatch(/\.workshop-order-group-card__stats\b/);
    expect(css).toMatch(/\.workshop-order-group-card__actions\b/);
    expect(css).toMatch(/\.workshop-order-group-card__body\b/);
    // padding 16–20px, border-radius 12–14px.
    expect(css).toMatch(
      /\.workshop-order-group-card\s*\{[\s\S]*?padding:\s*1[0-9]px\s+\d+px/,
    );
    expect(css).toMatch(
      /\.workshop-order-group-card\s*\{[\s\S]*?border-radius:\s*1[0-4]px/,
    );
  });

  test('CSS: compact-вариант CompleteCalculationForm', () => {
    expect(css).toMatch(/\.workshop-need-complete-form--compact\b/);
  });

  test('CSS: responsive — 1199px и 720px breakpoints', () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*1199px\)\s*\{[\s\S]*?\.workshop-order-need-row/,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.workshop-order-need-row/,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Backend/Prisma защитный пояс
// ---------------------------------------------------------------------------

describe('SaaS-итерация view=orders — backend не менялся', () => {
  test('Prisma schema не упоминает новые workshop-need / order-cost модели', () => {
    // Меняли только UI/CSS/smoke. На уровне smoke просто сверяем,
    // что критичные сервисные сигнатуры остались на месте — это
    // защитный пояс от случайных правок backend.
    const service = read(
      'apps/api/src/modules/workshop-needs/workshop-needs.service.ts',
    );
    expect(service).toMatch(/async calculateForOrder\(/);
    expect(service).toMatch(/async update\(/);
    expect(service).toMatch(/AREA_DENSITY/);
    expect(service).toMatch(/QTY_PER_UNIT/);
  });

  test('Server-actions inline-update / complete-calculation на месте', () => {
    const actions = read('apps/web/app/admin/workshop-needs/actions.ts');
    expect(actions).toMatch(/updateWorkshopNeedAction/);
    const orderActions = read('apps/web/app/orders/actions.ts');
    expect(orderActions).toMatch(/completeOrderCalculationAction/);
  });
});
