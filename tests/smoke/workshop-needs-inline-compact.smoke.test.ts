/**
 * Smoke-тесты «Компактное inline-редактирование потребности цеха»
 * (см. ТЗ §A `/admin/workshop-needs?view=lines` / `view=orders`,
 * `apps/web/app/admin/workshop-needs/inline-edit-row.tsx`,
 * `apps/web/app/admin/workshop-needs/page.tsx`,
 * `apps/web/app/admin/workshop-needs/[id]/edit-form.tsx`).
 *
 * Покрытие:
 *   1. inline-edit-row рисует строку через CSS-grid `.workshop-need-line`
 *      (а не через двумерный `admin-form-grid` — это и есть «не
 *      растянутая вертикальная форма»);
 *   2. в строке есть label «Цена за 1 <unit>» (через шаблон с
 *      `need.unit`) — `quotedPrice` остаётся ценой за единицу;
 *   3. UI считает line total (`finalQty × quotedPrice`) и
 *      показывает символ ₽/$ в зависимости от валюты;
 *   4. компонент `InlineEditWorkshopNeedRow` принимает
 *      `showOrderInfo`/`bulkSelect`-пропы и используется и в
 *      `view=lines`, и в `view=orders` (т.е. строки в группе
 *      заказа тоже редактируются inline);
 *   5. detail-карточка `/admin/workshop-needs/[id]` для валюты
 *      использует `<select>` по `MONEY_CURRENCIES`, а не свободный
 *      input (раньше валюта «не подтягивалась», потому что
 *      input оставался пустым при некорректном защёрданном
 *      значении);
 *   6. label цены в detail-карточке тоже «Цена за 1 <unit>».
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const INLINE = 'apps/web/app/admin/workshop-needs/inline-edit-row.tsx';
const PAGE = 'apps/web/app/admin/workshop-needs/page.tsx';
const DETAIL_FORM =
  'apps/web/app/admin/workshop-needs/[id]/edit-form.tsx';
const CSS = 'apps/web/app/globals.css';

describe('Workshop needs — компактное inline-редактирование', () => {
  test('inline-edit-row использует зональный grid `.wn-zrow`, а не вертикальный admin-form-grid', () => {
    const src = read(INLINE);
    // Зональный grid строки (className в JSX).
    expect(src).toMatch(/wn-zrow workshop-need-inline-form/);
    // Старый «двумерный» admin-form-grid layout полностью удалён из JSX.
    expect(src).not.toMatch(/className="admin-form-grid"/);
    expect(src).not.toMatch(/className=\{?"admin-form-grid/);
  });

  test('inline-edit-row подписывает поле цены как «Цена за 1 <unit>»', () => {
    const src = read(INLINE);
    // Helper-функция, которая собирает подпись.
    expect(src).toMatch(/formatPriceLabel/);
    expect(src).toMatch(/'Цена за 1 '|`Цена за 1 \$/);
  });

  test('inline-edit-row рисует select валюты по MONEY_CURRENCIES', () => {
    const src = read(INLINE);
    expect(src).toMatch(/MONEY_CURRENCIES/);
    expect(src).toMatch(/MONEY_CURRENCY_LABELS/);
    expect(src).toMatch(
      /<select[^>]*name="quotedCurrency"[\s\S]*?MONEY_CURRENCIES\.map/,
    );
  });

  test('inline-edit-row считает line total = finalQty × quotedPrice', () => {
    const src = read(INLINE);
    // Локальный preview суммы строки.
    expect(src).toMatch(/lineTotal/);
    expect(src).toMatch(/baseQtyNum/);
    // Показывает ₽ для RUB и $ для USD (или пусто, если не выбрана).
    expect(src).toMatch(/'₽'/);
    expect(src).toMatch(/'\$'/);
  });

  test('inline-edit-row принимает bulkSelect-проп (showOrderInfo удалён)', () => {
    const src = read(INLINE);
    expect(src).toMatch(/bulkSelect\?:\s*boolean/);
    // Bulk-чекбокс рендерится только при bulkSelect.
    expect(src).toMatch(/bulkSelect\s*&&/);
    // Проп showOrderInfo удалён вместе с построчным режимом.
    expect(src).not.toMatch(/showOrderInfo/);
  });

  test('page.tsx подключает InlineEditWorkshopNeedRow в группировке по заказу', () => {
    const src = read(PAGE);
    // Единственный режим — группировка по заказу (внутри NeedSection),
    // проп showOrderInfo удалён.
    expect(src).not.toMatch(/showOrderInfo/);
    expect(src).toMatch(/<InlineEditWorkshopNeedRow/);
    expect(src).toMatch(/NeedSection/);
  });

  test('CSS .workshop-need-line — горизонтальный grid с фиксированными колонками', () => {
    const src = read(CSS);
    expect(src).toMatch(/\.workshop-need-line\s*\{/);
    expect(src).toMatch(
      /\.workshop-need-line\s*\{[\s\S]*?display:\s*grid/,
    );
    expect(src).toMatch(
      /\.workshop-need-line\s*\{[\s\S]*?grid-template-columns:/,
    );
    // Список строк (`view=lines` обёртка).
    expect(src).toMatch(/\.workshop-need-line-list\b/);
  });

  test('CSS сворачивает строку в карточку на узком экране (@media)', () => {
    const src = read(CSS);
    // Узкий desktop / планшет — две колонки.
    expect(src).toMatch(
      /@media\s*\(max-width:\s*1199px\)\s*\{[\s\S]*?\.workshop-need-line/,
    );
    // Узкий мобильник — одна колонка.
    expect(src).toMatch(
      /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.workshop-need-line/,
    );
  });
});

// ---------------------------------------------------------------------------
// SaaS-итерация «Карточка заказа в view=orders»
// ---------------------------------------------------------------------------
//
// В `view=orders` строка потребности не должна выглядеть как
// длинная растянутая форма — это компактный 10-колоночный grid
// `.workshop-order-need-row` с inline-полями высотой 32–36px и
// маленькой icon-кнопкой save. Превью / orderNumber / клиент / тип
// строкой больше не рендерятся (они уже в header карточки заказа).
// Комментарий закупщика — collapse-блок, скрытый по умолчанию.

describe('Workshop needs — SaaS-карточка заказа (view=orders)', () => {
  test('inline-edit-row: корневой зональный grid `.wn-zrow`', () => {
    const src = read(INLINE);
    expect(src).toMatch(/wn-zrow workshop-need-inline-form/);
    expect(src).toMatch(/data-variant="orders"/);
    // Превью / orderNumber / клиент строкой не рендерятся — они в
    // header карточки заказа (page.tsx), а не в самой строке.
    expect(src).not.toMatch(/data-cell="order"/);
  });

  test('inline-edit-row: order info / kind badge убраны, detail-link «Подробности» всегда виден', () => {
    const src = read(INLINE);
    // Order-info ячейка и бейдж типа жили только в построчном режиме —
    // удалены вместе с ним.
    expect(src).not.toMatch(/data-cell="order"/);
    expect(src).not.toMatch(/workshop-need-kind-badge/);
    // Ссылка «Подробности» → карточка [id] теперь в подвале строки.
    expect(src).toMatch(/wn-zrow__detail-link/);
    expect(src).toMatch(/Подробности/);
  });

  test('inline-edit-row: комментарий — collapse через client state', () => {
    const src = read(INLINE);
    // Состояние раскрытия.
    expect(src).toMatch(/const\s+\[commentOpen,\s*setCommentOpen\]/);
    // Кнопка-toggle — `aria-expanded`, переключение по onClick.
    expect(src).toMatch(/aria-expanded=\{commentOpen\}/);
    // Когда commentOpen=false, comment приходит на backend через
    // <input type="hidden" name="comment">.
    expect(src).toMatch(
      /<input[\s\S]*?type="hidden"[\s\S]*?name="comment"/,
    );
    // Когда commentOpen=true, рендерится textarea (а не маленький
    // input — это и есть «не растягивает строку по высоте, пока
    // закупщик сам не открыл»).
    expect(src).toMatch(/<textarea[\s\S]*?name="comment"/);
    // Индикатор «Комментарий есть» / dot — для уже сохранённого
    // комментария.
    expect(src).toMatch(/Комментарий есть/);
    expect(src).toMatch(/workshop-order-need-row__comment-dot/);
  });

  test('inline-edit-row: save-кнопка зоны «Логистика» — компактная icon-кнопка ZoneSaveButton', () => {
    const src = read(INLINE);
    expect(src).toMatch(/ZoneSaveButton/);
    expect(src).toMatch(/wn-save/);
  });

  test('CSS: `.wn-zrow` — зональный grid строки (зоны / поля / save)', () => {
    const src = read(CSS);
    expect(src).toMatch(/\.wn-zrow\b/);
    expect(src).toMatch(/\.wn-zone\b/);
    expect(src).toMatch(/\.wn-field\b/);
    expect(src).toMatch(/\.wn-save\b/);
  });

  test('CSS: comment-toggle / comment / responsive 1199px и 720px для orders-row', () => {
    const src = read(CSS);
    expect(src).toMatch(/\.workshop-order-need-row__comment-toggle\b/);
    expect(src).toMatch(/\.workshop-order-need-row__comment\b/);
    expect(src).toMatch(/\.workshop-order-need-row__comment-button\b/);
    // Adaptive grid.
    expect(src).toMatch(
      /@media\s*\(max-width:\s*1199px\)\s*\{[\s\S]*?\.workshop-order-need-row/,
    );
    expect(src).toMatch(
      /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.workshop-order-need-row/,
    );
  });
});

// ---------------------------------------------------------------------------
// CompleteCalculationForm — compact-вариант для header карточки
// ---------------------------------------------------------------------------

describe('CompleteCalculationForm — variant=compact', () => {
  const PATH =
    'apps/web/app/admin/workshop-needs/complete-calculation-form.tsx';

  test('Компонент принимает variant=compact и рисует компактную форму', () => {
    const src = read(PATH);
    expect(src).toMatch(/variant\?:\s*CompleteCalculationFormVariant/);
    expect(src).toMatch(/workshop-need-complete-form--compact/);
  });

  test('page.tsx использует variant="compact" в actions карточки заказа', () => {
    const src = read(PAGE);
    expect(src).toMatch(/<CompleteCalculationForm[\s\S]*?variant="compact"/);
    expect(src).toMatch(/workshop-order-group-card__actions/);
  });

  test('CSS объявляет `.workshop-need-complete-form--compact`', () => {
    const src = read(CSS);
    expect(src).toMatch(/\.workshop-need-complete-form--compact\b/);
  });
});

describe('Workshop need detail — quotedCurrency через select', () => {
  test('detail-form использует <select> с MONEY_CURRENCIES вместо свободного input', () => {
    const src = read(DETAIL_FORM);
    expect(src).toMatch(/MONEY_CURRENCIES/);
    expect(src).toMatch(/MONEY_CURRENCY_LABELS/);
    expect(src).toMatch(
      /<select[^>]*name="quotedCurrency"[\s\S]*?MONEY_CURRENCIES\.map/,
    );
    // Старый text-input для валюты удалён.
    expect(src).not.toMatch(
      /<input[^>]*name="quotedCurrency"/,
    );
  });

  test('detail-form подтягивает текущую валюту в defaultValue', () => {
    const src = read(DETAIL_FORM);
    expect(src).toMatch(/need\.quotedCurrency/);
    // Опция «не выбрана» позволяет очистить валюту.
    expect(src).toMatch(/value=""/);
    expect(src).toMatch(/— не выбрана —/);
  });

  test('detail-form подписывает поле цены как «Цена за 1 <unit>»', () => {
    const src = read(DETAIL_FORM);
    expect(src).toMatch(/Цена за 1 \$\{need\.unit\}/);
  });
});
