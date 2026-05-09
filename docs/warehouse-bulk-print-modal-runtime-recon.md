# Warehouse Bulk Print Modal Runtime RECON

Дата: 2026-05-08. Контекст: продолжение
[`docs/modal-positioning-recon.md`](modal-positioning-recon.md) §6.
После двух CSS-итераций (overlay-scroll + sticky-footer →
panel-bounded layout) пользователь по-прежнему не может нажать
кнопку «Печать» на `/admin/warehouses/[id]` в модалке
«Печать линии «A» — Основной склад». Цель этого документа —
разобрать, почему статические smoke-тесты CSS зелёные, а UI
сломан в реальном браузере. Никаких правок production-кода,
CSS, JSX, тестов, backend, Prisma и DTO в рамках этого RECON
не делается.

## 1. Symptom

- Сценарий: админ открывает [/admin/warehouses/[id]](apps/web/app/admin/warehouses/[id]/page.tsx),
  в карточке «Линии склада» в строке линии «A» жмёт кнопку
  «Печать» ([apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx:113-125](apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx#L113-L125)).
- Открывается модалка с заголовком
  «Печать линии «A» — Основной склад»
  ([apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx:128-138](apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx#L128-L138)).
- В viewport видно overlay, заголовок, поля «Принтер»,
  «Размер этикетки», «Копий каждой», блок «Сводка» и
  «начало» preview-сетки — но `admin-actions-row` с кнопками
  «Отмена» и «Печать» находится **ниже видимой области экрана**,
  пользователь не может дотянуться до submit-кнопки без
  неочевидной прокрутки overlay.
- Два предыдущих CSS-фикса (sticky-footer внутри overlay-scroll
  и panel-bounded layout с `max-height: calc(100dvh - 2rem)` +
  `overflow: hidden`) проблему **не сняли**. Smoke-тесты
  [tests/smoke/modal-positioning.smoke.test.ts](tests/smoke/modal-positioning.smoke.test.ts)
  при этом проходят.

## 2. Screenshot observation

По скриншоту пользователя:

- Overlay-фон присутствует поверх страницы.
- Карточка модалки начинается в районе верхней-средней части
  экрана и тянется вниз; верх card-а не прижат к самому верху
  viewport (есть отступ от `.qr-modal { padding: 1rem }`).
- Видны header (`.qr-modal__header`), три admin-field в
  `admin-form-grid`, summary-блок (3 столбика «Ячеек / Копий /
  Заданий») и **самое начало** `bulk-print-modal__preview` —
  один-два ряда плиток-этикеток.
- Footer-кнопок «Отмена / Печать» **в кадре нет вообще**.
- Это значит проблема **не в overlay-padding и не в overlay-
  align-items**. Карточка вертикально ушла своим низом за фолд
  viewport (либо растянулась без ограничения, либо overlay
  скроллится, и пользователь видит «верх» модалки, а footer
  ниже скролл-границы overlay).
- Текущий layout даёт preview, но **не даёт прямого доступа к
  финальному action-row** — то есть либо panel-bound правило
  не применяется, либо preview не является scrollable child, и
  актуальный scrollable container — это не preview, а что-то
  другое (form? overlay?).

## 3. Component inventory

| Role | File | Component | Notes |
|------|------|-----------|-------|
| Warehouse detail page | [apps/web/app/admin/warehouses/[id]/page.tsx](apps/web/app/admin/warehouses/[id]/page.tsx) | `AdminWarehouseDetailPage` | server component, рендерит `AdminPageShell` → `AdminCard "Линии склада"` → `AdminTable` со столбцом «actions», в котором `LinePrintButton` (стр. 131-138). |
| Bulk print modal — wrapper | [apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx](apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx) | `LinePrintButton` (стр. 96-140) и `WarehouseBulkPrintPanel` (стр. 43-78) | оба открывают одну и ту же `BuilkPrintModal` (стр. 152-398). |
| Bulk print modal — body | [apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx:152-398](apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx#L152-L398) | `BulkPrintModal` | `'use client'`, держит state (`printerId`, `labelSize`, `copies`, `phase`, `feedback`, `pending`), submit бьёт в `printWarehouseLineCellsAction`. |
| Print preview tile | [apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx:405-415](apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx#L405-L415) | `CellLabelPreview` | плитка 58×38 (QR + код), aspect-ratio 58/38 — высота плиток фиксируется горизонталью (`auto-fill, minmax(160px, 1fr)`), что критично для поведения preview-grid. |
| Server actions | [apps/web/app/admin/warehouses/actions.ts](apps/web/app/admin/warehouses/actions.ts) | `printWarehouseLineCellsAction` | UI-проблеме не релевантен. |
| Global CSS | [apps/web/app/globals.css](apps/web/app/globals.css) | `.qr-modal*`, `.bulk-print-modal__*`, `.admin-form*`, `.admin-actions-row` | основной кандидат на baseline-конфликт (см. §5). |

Других компонентов, рендерящих **именно эту** модалку, нет.

## 4. Actual DOM structure

Срез [apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx:229-394](apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx#L229-L394)
в виде дерева. Классы — фактические из JSX, без CSS-предположений:

```
<div class="qr-modal" role="dialog" aria-modal="true">
  <div class="qr-modal__card bulk-print-modal__card">
    <div class="qr-modal__header">
      <h2 class="qr-modal__title">…Печать линии «A» — …</h2>
      <button class="qr-modal__close">×</button>
    </div>
    <form class="bulk-print-modal__form admin-form" onSubmit={…}>
      <div class="admin-form-grid">              ← settings, ВНИМАНИЕ: это `admin-form-grid`, а НЕ `bulk-print-modal__settings`
        <div class="admin-field">  …принтер…   </div>
        <div class="admin-field">  …размер…   </div>
        <div class="admin-field">  …копий…    </div>
      </div>
      <div class="bulk-print-modal__summary">    ← summary, 3 столбика
        <div>…Ячеек…</div>
        <div>…Копий…</div>
        <div>…Заданий…</div>
      </div>
      <div class="bulk-print-modal__preview">    ← preview wrapper
        <div class="bulk-print-modal__preview-header">…</div>
        <div class="bulk-print-modal__preview-grid">  ← scroll candidate
          {previewCells.slice(0, 24).map(…)}    ← до 24 плиток `.bulk-print-modal__label`
        </div>
      </div>
      {phase === 'success' && <div class="success-box" role="status">…</div>}
      {phase === 'error'   && <div class="error-box"   role="alert">…</div>}
      <div class="admin-actions-row">            ← !!! последний direct child формы — это `admin-actions-row`, а НЕ `bulk-print-modal__actions`
        <button type="button">Отмена</button>
        <button type="submit">Печать</button>
      </div>
    </form>
  </div>
</div>
```

Важные факты для §5–§7:

1. **Action-row — direct child формы** (не вложен в preview, не
   вложен в отдельный footer-wrapper). Это совпадает с тем, на
   что нацелен селектор
   `.bulk-print-modal__form > .admin-actions-row`.
2. **Класса `.bulk-print-modal__actions` на этом action-row нет**.
   В DOM используется `.admin-actions-row`. CSS-блок
   `.bulk-print-modal__actions { display: flex; … }`
   ([globals.css:4136-4150](apps/web/app/globals.css#L4136-L4150))
   — мёртвый, ни на одном элементе не применяется.
3. **Класса `.bulk-print-modal__settings` на settings-блоке тоже
   нет** — в JSX `admin-form-grid`. CSS-блок
   `.bulk-print-modal__settings { display: grid; grid-template-columns: minmax(220px, 1.6fr) … }`
   ([globals.css:3998-4023](apps/web/app/globals.css#L3998-L4023))
   тоже мёртвый.
4. **Form имеет ДВА класса**: `bulk-print-modal__form` и
   `admin-form`. Это — ключ к §5.
5. **Card имеет ДВА класса**: `qr-modal__card` и
   `bulk-print-modal__card`.
6. Внутри form между preview и actions могут добавляться
   `success-box` или `error-box` — это динамические direct children,
   ломающие предположение «actions всегда непосредственно после
   preview».
7. Отдельного scrollable body-wrapper-а **нет**. Кандидаты на
   scroll-container: card, form, preview, preview-grid, overlay.

## 5. CSS rules inventory

Только то, что **реально присутствует на фактическом DOM**.
Источник — [apps/web/app/globals.css](apps/web/app/globals.css).

| Class | File / line | Ключевые правила | Применяется к фактическому DOM? |
|------|-------------|-----------------|---------------------------------|
| `.qr-modal` | [globals.css:2562-2579](apps/web/app/globals.css#L2562-L2579) | `position: fixed; inset: 0; z-index: 100; display: flex; align-items: flex-start; justify-content: center; padding: 1rem; overflow-y: auto; overscroll-behavior: contain;` | ✅ overlay |
| `.qr-modal__card` | [globals.css:2580-2593](apps/web/app/globals.css#L2580-L2593) | `width: min(100%, 520px); margin: auto; padding: 1rem 1rem 1.1rem; display: flex; flex-direction: column; gap: 0.75rem;` | ✅ card (но `width`, `padding`, `gap` будут перебиты `.bulk-print-modal__card`) |
| `.qr-modal__header` | [globals.css:2594-2599](apps/web/app/globals.css#L2594-L2599) | `display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;` (нет `flex: 0 0 auto`) | ✅ header. **Не имеет `flex-shrink: 0`** — может ужиматься внутри bounded card. |
| `.bulk-print-modal__card` | [globals.css:3955-3969](apps/web/app/globals.css#L3955-L3969) | `max-width: 720px; width: min(100%, 720px); gap: 1rem; padding: 1rem 1.1rem 1.25rem; max-height: calc(100vh - 2rem); max-height: calc(100dvh - 2rem); overflow: hidden;` | ✅ card. Source order **позже** `.qr-modal__card` → перебивает `width`, `gap`, `padding`. `display`/`flex-direction` остаются от `.qr-modal__card`. |
| `.bulk-print-modal__form` | [globals.css:3970-3977](apps/web/app/globals.css#L3970-L3977) | `display: flex; flex-direction: column; gap: 1rem; flex: 1 1 auto; min-height: 0; overflow: hidden;` | ⚠️ применяется, **НО `display`/`flex-direction`/`gap` конфликтуют с `.admin-form` ниже по cascade.** См. §7. |
| `.bulk-print-modal__form > *` | [globals.css:3983-3985](apps/web/app/globals.css#L3983-L3985) | `flex: 0 0 auto;` | ⚠️ свойство `flex` имеет смысл **только для flex-item**. Если родитель — grid (см. §7), значение игнорируется. |
| `.bulk-print-modal__form > .admin-actions-row` | [globals.css:3991-3997](apps/web/app/globals.css#L3991-L3997) | `flex: 0 0 auto; margin-top: auto; padding-top: 0.6rem; border-top: 1px solid var(--color-border); background: #fff;` | ⚠️ селектор **попадает** в DOM. `padding-top`, `border-top`, `background` применятся. `flex: 0 0 auto` и `margin-top: auto` зависят от типа layout родителя (flex vs grid). |
| `.bulk-print-modal__summary` | [globals.css:4025-4033](apps/web/app/globals.css#L4025-L4033) | grid 3-col, `padding: 0.75rem 0.85rem; background: …; border-radius: …; border: …;` | ✅ |
| `.bulk-print-modal__preview` | [globals.css:4052-4056](apps/web/app/globals.css#L4052-L4056) | `display: flex; flex-direction: column; gap: 0.5rem;` | ✅ preview wrapper |
| `.bulk-print-modal__form > .bulk-print-modal__preview` | [globals.css:4062-4066](apps/web/app/globals.css#L4062-L4066) | `flex: 1 1 0; min-height: 0; overflow: hidden;` | ⚠️ селектор попадает; но `flex: 1 1 0` — снова свойство для flex-item. См. §7. |
| `.bulk-print-modal__preview-grid` | [globals.css:4077-4091](apps/web/app/globals.css#L4077-L4091) | `display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.55rem; flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0.4rem; background: #f1f3f7;` | ✅ применяется. **`overflow-y: auto`** — ключевой scroll candidate. `flex: 1 1 auto` имеет смысл **внутри `.bulk-print-modal__preview`**, который — flex column. ✅ |
| `.admin-form` | [globals.css:7128-7131](apps/web/app/globals.css#L7128-L7131) | `display: grid; gap: var(--admin-space-md);` | ⚠️ применяется к фактическому form-у. Source order **7128** > **3970** при равной специфичности 0,1,0 — **WINS** против `.bulk-print-modal__form` для `display` и `gap`. Подробнее — §7. |
| `.admin-form-grid` | [globals.css:7133-7137](apps/web/app/globals.css#L7133-L7137) | `display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--admin-space-md);` | ✅ применяется к settings-блоку (не вредит вертикальному layout). |
| `.admin-field` | [globals.css:7163-7166](apps/web/app/globals.css#L7163-L7166) | `display: grid; gap: var(--admin-space-xs);` | ✅ |
| `.admin-actions-row` | [globals.css:7211-7217](apps/web/app/globals.css#L7211-L7217) | `display: flex; gap: var(--admin-space-sm); justify-content: flex-end; flex-wrap: wrap; align-items: center;` | ✅ настоящие правила footer-row. **`flex` (как property) на самом row не задан** — управление footer-ом идёт через `.bulk-print-modal__form > .admin-actions-row`. |
| `.bulk-print-modal__actions` | [globals.css:4136-4150](apps/web/app/globals.css#L4136-L4150) | `display: flex; …` | ❌ **МЁРТВЫЙ КОД**. На action-row такого класса нет. |
| `.bulk-print-modal__settings` | [globals.css:3998-4023](apps/web/app/globals.css#L3998-L4023) | grid 3-col `minmax(220px, 1.6fr) minmax(180px, 1.2fr) 110px` | ❌ **МЁРТВЫЙ КОД**. Settings-grid рендерится с классом `admin-form-grid`. |

Итого: **из всех `.bulk-print-modal__*` правил живых на DOM —
`__card`, `__form`, `__summary`, `__preview`, `__preview-grid`,
`__preview-header`, `__label*`. Мёртвых — `__settings`,
`__actions`. Дополнительно — два конфликта на одном и том же
элементе формы, разрешаемые в пользу `.admin-form` (см. §7).**

## 6. Runtime computed styles (требуется к снятию в браузере)

В Node-вычислениях специфичность и source order разрешаются
тривиально (см. §7). Для финального подтверждения нужно снять
runtime-computed-styles в реальном браузере. Скрипт ниже
рекомендуется выполнить в DevTools Console на открытой модалке
«Печать линии «A»», результат — приложить к этому RECON
(вставлять можно резюме, не весь JSON):

```js
(() => {
  const selectors = [
    '.qr-modal',
    '.qr-modal__card',
    '.bulk-print-modal__card',
    '.bulk-print-modal__form',
    '.bulk-print-modal__preview',
    '.bulk-print-modal__preview-grid',
    '.admin-actions-row',
    '.modal',
    '.modal-backdrop',
  ];
  return selectors.map((selector) => {
    const el = document.querySelector(selector);
    if (!el) return { selector, found: false };
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      selector,
      found: true,
      tag: el.tagName,
      className: el.className,
      rect: {
        top: rect.top, bottom: rect.bottom, height: rect.height,
        left: rect.left, right: rect.right, width: rect.width,
      },
      style: {
        position: cs.position, display: cs.display,
        flexDirection: cs.flexDirection, flex: cs.flex,
        minHeight: cs.minHeight, maxHeight: cs.maxHeight,
        height: cs.height, overflow: cs.overflow,
        overflowY: cs.overflowY,
        alignItems: cs.alignItems, justifyContent: cs.justifyContent,
        marginTop: cs.marginTop, marginBottom: cs.marginBottom,
        paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
      },
      scroll: {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollTop: el.scrollTop,
      },
      viewport: {
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
      },
    };
  });
})();
```

В отчёт приложить:

1. **Card rect**: top, bottom, height (особенно — bottom > viewport
   `innerHeight`?).
2. **Action-row rect**: top, bottom, height (action-row.bottom >
   viewport.innerHeight?).
3. **Viewport `innerHeight`** (для контроля 100dvh).
4. У какого элемента `scrollHeight > clientHeight` (то есть кто
   реально скроллится).
5. Сравнить `getComputedStyle(form).display` — ожидание `flex`,
   подозрение `grid`.
6. Сравнить `getComputedStyle(card).maxHeight` — ожидание
   `calc(…dvh - 32px)` или соответствующих пикселей; подозрение
   `none`.
7. Сравнить `getComputedStyle(form).overflow` / `.overflowY` —
   ожидание `hidden`, подозрение `visible`.
8. Сравнить `getComputedStyle(preview).overflow` — ожидание
   `hidden`, подозрение `visible`.
9. Сравнить `getComputedStyle(actionsRow).flex` — ожидание
   `0 0 auto`, подозрение `0 1 auto` (значение по умолчанию).

Если `card.maxHeight` показывает реальное ограничение, но
`actionRow.rect.bottom > window.innerHeight`, это значит
**родитель action-row (= form) не занимается layout-ом так, как
ожидается**, и max-height card уже не помогает — content card-а
рисуется за пределами card-а **за счёт переполнения form**, а
overlay-scroll позволяет visual scroll, не делая action-row
доступной без ручной прокрутки overlay/page.

## 7. Why previous fix failed

### 7.1. Источники CSS-конфликта на `.bulk-print-modal__form`

Form в JSX:

```tsx
<form className="bulk-print-modal__form admin-form" onSubmit={…}>
```

Оба класса присутствуют в DOM. Оба имеют CSS-блоки в
`globals.css`:

| Селектор | Source line | Specificity | `display` | `gap` | `flex-direction` |
|----------|-------------|-------------|-----------|-------|------------------|
| `.bulk-print-modal__form` | [3970](apps/web/app/globals.css#L3970) | (0, 1, 0) | `flex` | `1rem` | `column` |
| `.admin-form` | [7128](apps/web/app/globals.css#L7128) | (0, 1, 0) | `grid` | `var(--admin-space-md)` | — |

Правила имеют **равную специфичность**. По CSS-спецификации в
этом случае выигрывает то, что **позже в исходнике**, — это
`.admin-form` (строка 7128 идёт после строки 3970).

**Следствия для runtime:**

- `display: grid` побеждает → form **не является flex-
  контейнером**.
- `flex: 1 1 auto`, `min-height: 0`, `overflow: hidden` от
  `.bulk-print-modal__form` остаются, **они не конфликтуют с
  `.admin-form`** — form действительно остаётся flex-item внутри
  card, ужимается, и клипует overflow.
- НО все наследники, которые опираются на «form === flex
  column», **становятся grid-items**:
  - `.bulk-print-modal__form > * { flex: 0 0 auto }` — на grid-
    item свойство `flex` (shorthand для `flex-grow / shrink /
    basis`) **игнорируется** (это flexbox-свойство).
  - `.bulk-print-modal__form > .bulk-print-modal__preview { flex: 1 1 0; min-height: 0; overflow: hidden }`
    — `flex: 1 1 0` **игнорируется**. `min-height: 0` и
    `overflow: hidden` остаются — preview всё ещё клипует
    overflow, но **не растёт по `flex-grow`, чтобы заполнить
    свободное место**, а получает height по grid-auto-rows
    (= max-content по дефолту).
  - `.bulk-print-modal__form > .admin-actions-row { flex: 0 0 auto; margin-top: auto; }`
    — `flex: 0 0 auto` игнорируется. `margin-top: auto` в grid
    **работает**, но иначе: толкает item к нижней границе
    **своей grid-клетки**, а не к нижней границе формы. На
    auto-row grid каждая клетка = размер item-а, поэтому
    `margin-top: auto` по сути nop.

Иными словами: **CSS написан под flex-column form, но в runtime
form — grid, и связь «preview занимает свободное пространство,
actions прибивается к низу» рушится в кэше cascade ещё до
рендера.**

### 7.2. Что показывают smoke-тесты

`tests/smoke/modal-positioning.smoke.test.ts` парсит **тело
правила** через `readRuleBody(css, '.bulk-print-modal__form')`
и текстово проверяет наличие `display: flex`. Это всегда
правда, потому что в текстовом теле правила слова `display:
flex` действительно есть. Тест **не вычисляет computed value**
и **не учитывает, что более поздний `.admin-form` его
перекрывает**. Поэтому регресс пропускается, smoke зелёный, а
runtime — broken.

То же самое с
`expect(body).toMatch(/max-height:\s*calc\(100dvh\s*-\s*2rem\)/)`
для `.bulk-print-modal__card` — тест убеждается, что в
рулебуке есть нужный текст, **но не убеждается, что правило
выигрывает у других** (правда, для `__card` на сегодня нет
другого правила, дублирующего `max-height`, поэтому именно эта
проверка валидна).

### 7.3. Почему «sticky-footer» из первой итерации не помог

Старое правило:

```css
.bulk-print-modal__form > .admin-actions-row {
  position: sticky;
  bottom: 0;
  …
}
```

`position: sticky` стикает элемент внутри **scrolling
ancestor**. Для action-row scrolling-ancestor — это либо
overlay (`.qr-modal { overflow-y: auto }`), либо документ.
Containing block для `top/bottom` sticky — ближайший block-
container (= `.bulk-print-modal__form`). Но action-row —
**последний дочерний элемент формы**: его «натуральная»
нижняя граница совпадает с нижней границей формы, и у sticky
просто **нет резерва ниже**, чтобы залипнуть выше. Sticky
остаётся в потоке.

### 7.4. Почему panel-bounded layout (вторая итерация) не помог

Идея была верной — ограничить card по `100dvh`, отдать
overflow внутри preview-grid, оставить actions последним flex-
child-ом формы. **Но реализация полагается на то, что form
будет flex-column.** Класс `.bulk-print-modal__form` это и
объявляет, но кастомизация рекомендует использовать его
**вместе с `admin-form`**, и `admin-form` объявлен ниже по
файлу с тем же специфическим весом. CSS-cascade без
`!important` или более специфичного селектора отдаёт `display`
в пользу `grid`. Все остальные нацеленные на flex-layout
правила (`flex: 1 1 0` на preview, `flex: 0 0 auto` на actions,
`margin-top: auto` для footer-якоря) становятся либо noop,
либо ведут себя иначе.

В результате form-grid-rows растягиваются по содержимому,
**и хотя form всё ещё клипует overflow**, контент card-а в
сумме (header + form-grid-content) физически превышает card
max-height только тогда, когда form не клипует **дочернюю
overflow-зону**. На длинной линии с 24 плитками preview-grid
получает свой `overflow-y: auto` (это работает — он сам по
себе grid и его собственный `overflow-y: auto` валиден), но
**preview-grid не уменьшается через `flex: 1 1 auto`** (он не
flex-item внутри form, он flex-item внутри preview, а вот
preview как grid-item формы — не flex-item, и его высота
определяется max-content от собственного содержимого, потому
что preview-grid внутри claims `min-content: row × tile-
height`).

Тонкий нюанс: `min-height` на grid-item по умолчанию `auto`,
что означает «не уменьшайся ниже min-content». В flexbox мы
имели `min-height: 0` через
`.bulk-print-modal__form > .bulk-print-modal__preview`, и это
гасило этот эффект. **В grid-контексте `min-height: 0` всё ещё
применяется к самому preview**, и в одиночку это не плохо. Но
preview не получает `flex-grow: 1` для роста, поэтому он
рассчитан на свой intrinsic min-content — а min-content
preview = высота preview-header + min-content preview-grid
(один tile при auto-fill минимально) = умеренное число
пикселей. Иначе говоря, preview сам по себе **не съедает
свободное место в form**, и form-grid размещает action-row
сразу после preview без пустоты между ними. На viewport-уровне
это означает: action-row сразу за preview, в самом низу form,
и так как form ограничена card-ом (max-height: 100dvh − 2rem),
action-row либо **клипуется card-ом** (тогда виден на edge,
обрезан), либо **переезжает за нижний край card-а из-за
рассинхронизации между form-overflow и card-overflow**.

Если в браузере действительно видно «footer ниже viewport, но
card вроде ограничен» — самая вероятная причина: **form-grid с
intrinsic content больше, чем выделенное form-у место, и
overflow card-а не клипует form-overflow визуально**, потому
что overlay (`.qr-modal { overflow-y: auto }`) «прокручивает»
весь card-block-контейнер. Конкретный механизм нужно
подтвердить computed-styles из §6, но текстуально cascade-
конфликт — необходимое условие сбоя.

### 7.5. Что ещё могло частично спасать раньше

- `.bulk-print-modal__form > .bulk-print-modal__preview` —
  селектор **попадает** в DOM (preview действительно direct-
  child формы), и `min-height: 0; overflow: hidden` всё-таки
  применяется (хотя `flex: 1 1 0` нет). Это значит preview
  клипует свой overflow, но не растёт.
- `.qr-modal { overflow-y: auto }` — overlay-scroll
  действительно работает, и пользователь технически может
  доскроллить до action-row, но **визуально это не очевидно**:
  он скроллит «всю модалку», а не preview, и пропускает action-
  row, потому что action-row сидит сразу под preview без
  отступа от viewport-bottom.

## 8. Root cause classification

| Code | Применимо? | Доказательство |
|------|------------|----------------|
| `CSS_SELECTOR_MISMATCH` | ❌ нет (живые селекторы матчат DOM); ⚠️ частично — `.bulk-print-modal__settings` и `.bulk-print-modal__actions` **не матчат** реальный DOM, но они и не должны были чинить footer (это для settings-grid и для action-row-styling, но action-row уже стилится через `.admin-actions-row`). Мёртвый код, не root cause. | §4 п.2-3, §5 |
| `RUNTIME_DOM_MISMATCH` | ⚠️ частично — JSX рендерит `admin-actions-row` и `admin-form-grid`, а CSS-инвентарь намекал на `bulk-print-modal__actions`/`__settings`, никогда не присутствующие в JSX. Не корневая причина текущего бага, но ловушка для cascade-аудита. | §4 п.2-3 |
| `WRONG_SCROLL_CONTAINER` | ✅ **да**. Реальный scroll берёт на себя overlay (`.qr-modal { overflow-y: auto }`), потому что card max-height **может быть подменена** или form-grid intrinsic height ломает «card → form → preview-grid» цепочку. Predicted scrollable child — preview-grid, **actual scrollable child — overlay**. Должно быть подтверждено §6. | §7.4 |
| `CARD_NOT_BOUNDED` | ⚠️ возможна вспомогательная причина: `max-height: calc(100dvh - 2rem)` может не сработать в нестандартном viewport (iframe, mobile-with-virtual-keyboard), но на десктопе пользователя это подтверждается только §6. | §6 |
| `ACTIONS_NOT_FLEX_FOOTER` | ✅ **да** (главный root cause). Cascade-conflict `.admin-form { display: grid }` побеждает `.bulk-print-modal__form { display: flex }` из-за равной специфичности и более позднего source-position. Все footer-anchor правила (`flex: 0 0 auto`, `margin-top: auto`) становятся noop. | §7.1, §5 |
| `OVERLAY_SCROLL_ONLY_NOT_ENOUGH` | ✅ **да** (вторичная причина). Даже если overlay-scroll формально доступен, action-row visual-affordance отсутствует — пользователь не понимает, что нужно скроллить overlay, а не страницу. | §2, §7.4 |
| `PREVIEW_NOT_SCROLLABLE` | ✅ **да** (следствие grid-form). `flex: 1 1 0` на preview не работает в grid-родителе → preview не «съедает» свободное место → preview-grid не становится главным scrollable child. | §7.1 |
| `INLINE_OR_LEGACY_CLASS_OVERRIDE` | ⚠️ возможно — `style={{ marginTop: -8 }}` на родительском `admin-actions-row` ([page.tsx:246](apps/web/app/admin/warehouses/[id]/page.tsx#L246)) и инлайн-стили на admin-muted в самой модалке не влияют на bottom-overflow, но в смежных компонентах могли. К текущему багу не критично. | [page.tsx:246](apps/web/app/admin/warehouses/[id]/page.tsx#L246) |
| `TEST_FALSE_POSITIVE` | ✅ **да**. Smoke-тест проверяет «текст в теле правила», не computed value, не cascade-победителя, не runtime DOM. Не ловит конфликт `.admin-form` vs `.bulk-print-modal__form`. | §7.2, §12 |

**Главный набор причин:** `ACTIONS_NOT_FLEX_FOOTER` + `PREVIEW_NOT_SCROLLABLE` (оба — следствие cascade-конфликта `.admin-form` vs `.bulk-print-modal__form`), визуально усиленные `OVERLAY_SCROLL_ONLY_NOT_ENOUGH`. Маскируется `TEST_FALSE_POSITIVE`.

## 9. Expected layout

Целевая раскладка строго для warehouse bulk print modal:

```
overlay (.qr-modal)
   position: fixed; inset: 0; padding: 1rem;
   display: flex; align-items: flex-start; justify-content: center;
   overflow-y: auto;             ← fallback overlay-scroll, на крайний случай
└── card (.qr-modal__card.bulk-print-modal__card)
       width: min(100%, 720px); margin: auto;
       max-height: calc(100dvh - 2rem);
       display: flex; flex-direction: column;
       overflow: hidden;
   ├── header (.qr-modal__header)
   │      flex: 0 0 auto;          ← фиксированная высота
   ├── form (.bulk-print-modal__form.admin-form)
   │      flex: 1 1 auto;          ← занимает остаток
   │      min-height: 0;
   │      display: flex; flex-direction: column;   ← !!! должно ВЫИГРАТЬ
   │      gap: 1rem;
   │      overflow: hidden;
   │   ├── settings (.admin-form-grid)        flex: 0 0 auto
   │   ├── summary (.bulk-print-modal__summary)  flex: 0 0 auto
   │   ├── preview (.bulk-print-modal__preview)
   │   │     flex: 1 1 0;          ← единственный flex-grow
   │   │     min-height: 0;
   │   │     overflow: hidden;
   │   │   ├── header   flex: 0 0 auto
   │   │   └── grid (.bulk-print-modal__preview-grid)
   │   │         flex: 1 1 auto; min-height: 0;
   │   │         overflow-y: auto      ← scrollable child
   │   ├── (success-box | error-box)?     flex: 0 0 auto
   │   └── actions (.admin-actions-row)
   │         flex: 0 0 auto;          ← прибит к низу формы
```

Свойства, которые должны быть гарантированы во **все** условиях
runtime:

- card max-height **всегда** ≤ viewport (через `100dvh` + fallback
  `100vh`).
- form display=flex column **выигрывает** у любых сторонних
  `.admin-form`-styles.
- preview-grid — **единственный** scrollable child, у preview-grid
  `overflow-y: auto`.
- actions — последний direct child формы, `flex: 0 0 auto`,
  всегда видим в pre-scroll viewport.
- success-box / error-box между preview и actions не ломают
  layout (тоже `flex: 0 0 auto`, фикс-высота).

## 10. Minimal fix options (не реализовывать)

### Option A — Component restructure (JSX-level)

Перестроить JSX так, чтобы card имел **явные** body- и footer-
sections:

```tsx
<div className="qr-modal__card bulk-print-modal__card">
  <div className="qr-modal__header">…</div>
  <form
    className="bulk-print-modal__form"   // убрать `admin-form`
    onSubmit={…}
  >
    <div className="bulk-print-modal__body">
      <div className="admin-form-grid">…</div>
      <div className="bulk-print-modal__summary">…</div>
      <div className="bulk-print-modal__preview">…</div>
      {success && <div className="success-box" />}
      {error && <div className="error-box" />}
    </div>
    <footer className="bulk-print-modal__footer">
      <div className="admin-actions-row">…</div>
    </footer>
  </form>
</div>
```

- **Pros**: устраняет cascade-конфликт (нет `admin-form`),
  явное разделение body/footer, footer гарантированно вне
  scroll-зоны.
- **Cons**: правки JSX и удаление полезных `admin-form` paddings.
- **Risk**: средний — другие consumers `.admin-form` не
  затронуты, но визуальный gap у settings/summary может слегка
  уехать.
- **Files touched**: [bulk-print-panel.tsx](apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx),
  [globals.css](apps/web/app/globals.css) (новые классы
  `__body`/`__footer`).

### Option B — Dedicated modifier classes (CSS-only)

Поднять специфичность правил `.bulk-print-modal__form` так,
чтобы они **выигрывали** у `.admin-form` без правки JSX.
Например, через `.bulk-print-modal__form.admin-form { … }` или
через `.bulk-print-modal__card > .bulk-print-modal__form { … }`
(специфичность 0,2,0 vs 0,1,0). Аналогично для preview/actions.

- **Pros**: zero-JSX. Минимальная диff.
- **Cons**: добавляется хрупкий «компаунд-селектор» в нескольких
  местах; регресс снова возможен, если кто-то добавит ещё один
  `admin-form-*` класс позже в файле.
- **Risk**: низкий, но без структурного решения проблема
  cascade-сосуществования остаётся.
- **Files touched**: [globals.css](apps/web/app/globals.css)
  (правила `__form`, `__form > *`, `__form > __preview`, `__form
  > .admin-actions-row`, plus возможно `__card`).

### Option C — Make actions outside scroll body

Вынести `.admin-actions-row` **из формы** в отдельный footer-
div прямо под формой внутри card-а:

```tsx
<div className="qr-modal__card bulk-print-modal__card">
  <div className="qr-modal__header">…</div>
  <form className="bulk-print-modal__form admin-form">
    {/* body without actions */}
  </form>
  <div className="bulk-print-modal__footer admin-actions-row">
    <button>Отмена</button>
    <button form={formId} type="submit">Печать</button>
  </div>
</div>
```

- **Pros**: footer **физически вне** form-flex/grid-цепочки;
  card продолжает быть flex column; footer — последний flex-
  child card-а, всегда виден.
- **Cons**: submit-кнопка **снаружи** формы — нужно использовать
  `form="…"` атрибут для submit by id; чуть менее идиоматично,
  но HTML-валидно.
- **Risk**: низкий; малая поверхность изменений.
- **Files touched**: [bulk-print-panel.tsx](apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx),
  [globals.css](apps/web/app/globals.css) (минор: `__footer`
  paddings/borders).

### Option D — Portal / render outside layout

Вынести overlay через `createPortal(…, document.body)` —
если когда-то layout/scroll-parent перехватывал overlay
position. Текущий рендер — Next.js client component, overlay
рендерится внутри `body` страницы; теоретически некий ancestor
со `transform`, `filter`, `perspective` или `will-change`
ломает `position: fixed`. Beлична DOM-tree предполагает: страница
обёрнута в `AdminPageShell` (см.
[apps/web/app/admin/warehouses/[id]/page.tsx:196-306](apps/web/app/admin/warehouses/[id]/page.tsx#L196-L306)).
Если у `.app-main` или `AdminPageShell` есть `transform: …`,
overlay становится positioning-relative к нему, а не к viewport
— и max-height: 100dvh считается **от внутреннего scroll-
container**, что может дать видимую «модалку ниже viewport».

- **Pros**: убирает риск transformed ancestor.
- **Cons**: переусложнение, если корень проблемы — cascade.
- **Risk**: средний (SSR / hydration / focus-trap).
- **Files touched**: [bulk-print-panel.tsx](apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx)
  (импорт `createPortal`).

## 11. Recommended fix

**Рекомендуется Option B (CSS-only специфичность) как
немедленное лекарство + добавление DOM-теста (см. §12) для
защиты от регресса.** Если runtime-замеры в §6 покажут, что
card max-height тоже не побеждает в cascade или ancestor-
transform всё-таки присутствует — добавить точечное Option C
(вынос footer наружу формы).

Не реализовывать в рамках этого RECON.

- **Touch files**:
  - [apps/web/app/globals.css](apps/web/app/globals.css) —
    обновить селекторы `.bulk-print-modal__form`,
    `.bulk-print-modal__form > *`,
    `.bulk-print-modal__form > .bulk-print-modal__preview`,
    `.bulk-print-modal__form > .admin-actions-row` так, чтобы
    специфичность была не меньше 0,2,0 (например, начинать с
    `.bulk-print-modal__card .bulk-print-modal__form`).
  - Удалить мёртвые правила `.bulk-print-modal__settings`,
    `.bulk-print-modal__actions` (они никогда не применяются).
- **CSS classes**: те же, что и сейчас, без новых.
- **JSX changes**: нет.
- **Tests to update**:
  [tests/smoke/modal-positioning.smoke.test.ts](tests/smoke/modal-positioning.smoke.test.ts)
  — заменить «есть ли в теле правила слово `display: flex`» на
  «итоговый каскад на форме даёт `display: flex`». Подробнее —
  §12.
- **Manual check**: открыть `/admin/warehouses/<id-склада>`,
  кликнуть «Печать» в строке любой линии, убедиться, что
  кнопка «Печать» виден без прокрутки overlay; на мобильном
  viewport (iPhone SE) тоже.

## 12. Test gaps

`tests/smoke/modal-positioning.smoke.test.ts` НЕ ловит баг,
потому что:

1. **Парсит `globals.css` как текст**. Read-only извлечение
   тела правила и `String#match` против регэкспов. Никогда не
   симулирует DOM, не вычисляет computed style, не разрешает
   cascade-конфликты.
2. **Не знает, что `.admin-form` существует**. Если в форме
   стоит `class="bulk-print-modal__form admin-form"` и
   `.admin-form` объявлен ниже по файлу с равной специфичностью,
   тест по-прежнему зелёный, потому что в теле
   `.bulk-print-modal__form { display: flex; … }` слово `flex`
   существует.
3. **Не проверяет, какие классы JSX реально использует на
   модалке**. Существующая проверка
   `expect(src).toMatch(/className="bulk-print-modal__form admin-form"/)`
   — это контракт «JSX содержит эти классы», но **не контракт
   «эти два класса не конфликтуют между собой в cascade»**.
4. **Не проверяет, что мёртвых классов CSS не осталось**.
   `.bulk-print-modal__actions` живёт в CSS, но JSX его не
   использует — никто не алертит про дрейф.

Предложение нового / обновлённого теста (без реализации):

- **Тест A — JSX + cascade**: загрузить
  [globals.css](apps/web/app/globals.css) и
  [bulk-print-panel.tsx](apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx),
  для каждого реально используемого className в модалке
  собрать **все** правила в `globals.css`, отсортировать по
  специфичности + source order и убедиться, что итоговый
  `display` для `.bulk-print-modal__form` равен `flex`, а не
  `grid`. Можно реализовать миниатюрным CSS-парсером
  (`postcss` + `specificity` уже могут быть в зависимостях) или
  ручным reducer-ом.
- **Тест B — actions outside preview-scroll**: статически
  проверять, что в JSX-AST `.admin-actions-row` **не лежит**
  внутри `.bulk-print-modal__preview` или
  `.bulk-print-modal__preview-grid` — иначе кнопки уедут
  внутри scroll-контейнера. Сейчас контракт держится на
  ручном чтении JSX.
- **Тест C — Playwright smoke (если станет возможен)**:
  открыть `/admin/warehouses/<seed-id>`, нажать «Печать» на
  линии с >24 ячейками, проверить, что
  `await page.locator('button:has-text("Печать")').last().isInViewport()` —
  true сразу после открытия модалки (без явного scroll). Это
  единственный тест, который ловит баг
  «footer ниже viewport» как пользователь его видит.
- **Тест D — dead CSS**: статически проверять, что для каждого
  селектора `.bulk-print-modal__*` в `globals.css` есть
  совпадение по className в JSX. `.bulk-print-modal__settings`
  и `.bulk-print-modal__actions` сегодня не имеют соответствия
  в DOM — это false-positive cascade-инвентаря.

Тест-D-ситуацию можно описать так: «CSS есть, но DOM его не
использует» — текущий smoke этого не отлавливает и потому
создаёт ложное чувство, что cascade живой.

## 13. Resolution (Option B — CSS specificity)

**Применено CSS-only решение** — Option B из §10. JSX, backend,
DTO и Prisma не трогали; добавлены/обновлены только селекторы
[apps/web/app/globals.css](apps/web/app/globals.css) и smoke-тест
[tests/smoke/modal-positioning.smoke.test.ts](tests/smoke/modal-positioning.smoke.test.ts).

### 13.1. CSS-override (cascade-конфликт `.admin-form` ↔ `.bulk-print-modal__form`)

В [apps/web/app/globals.css](apps/web/app/globals.css) добавлены
четыре правила сразу после блока `.bulk-print-modal__form > .admin-actions-row`:

```css
.bulk-print-modal__card .bulk-print-modal__form.admin-form { … }            /* (0,3,0) */
.bulk-print-modal__card .bulk-print-modal__form.admin-form > * { … }        /* (0,3,0) */
.bulk-print-modal__card .bulk-print-modal__form.admin-form > .bulk-print-modal__preview { … }  /* (0,4,0) */
.bulk-print-modal__card .bulk-print-modal__form.admin-form > .admin-actions-row { … }          /* (0,4,0) */
```

Специфичность `(0,3,0)` / `(0,4,0)` гарантированно выигрывает у
`.admin-form { display: grid; … }` (0,1,0) на строке 7128 при
любом source-order. Form в runtime становится **flex-column**,
оживляя дочерние `flex: 1 1 0` (preview) и `flex: 0 0 auto` +
`margin-top: auto` (actions).

Дополнительно `.bulk-print-modal__card` получил явные
`display: flex; flex-direction: column;` (раньше унаследованные
от `.qr-modal__card` неявно) — это никого не ломает и облегчает
smoke-проверку bounded-card инварианта.

### 13.2. Удалён мёртвый CSS

Удалены никогда не применявшиеся правила (см. §5):

- `.bulk-print-modal__settings` + `.bulk-print-modal__settings .detail-form__field` + label/select/input стили (settings рендерится в JSX как `admin-form-grid`).
- `.bulk-print-modal__actions` + `.bulk-print-modal__actions .btn-ghost` (action-row рендерится как `admin-actions-row`).
- Соответствующая ветка `.bulk-print-modal__settings { grid-template-columns: 1fr }` из `@media (max-width: 640px)`. `.bulk-print-modal__summary` в этой media-query сохранён.

### 13.3. Smoke-test guard

В [tests/smoke/modal-positioning.smoke.test.ts](tests/smoke/modal-positioning.smoke.test.ts)
добавлена секция **«modal positioning — cascade conflict
.admin-form vs .bulk-print-modal__form»**:

1. JSX рендерит обе class-name `bulk-print-modal__form admin-form` (baseline-проверка, что конфликт реальный).
2. `.admin-form` всё ещё объявлен с `display: grid` в `globals.css` (regression-guard на источник конфликта; регэксп явно граничит по newline, чтобы не зацепить компаунд-селектор).
3. `.bulk-print-modal__card .bulk-print-modal__form.admin-form` существует и задаёт `display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden`.
4. Дочерний override для preview задаёт `flex: 1 1 0; min-height: 0; overflow: hidden`.
5. Дочерний override для actions задаёт `flex: 0 0 auto; margin-top: auto; border-top; background`.
6. Само присутствие override-селектора (`expect(css).toContain(…)`)
   — на случай, если кто-то его удалит будущим CSS-cleanup.

Существующая проверка «.bulk-print-modal__card — bounded по dvh,
flex-column, overflow:hidden» расширена ассертами на
`display: flex` + `flex-direction: column` (раньше проверялись
только `max-height` и `overflow`).

### 13.4. Acceptance

- Runtime `.bulk-print-modal__form.admin-form` — `display: flex`
  (компаунд-override побеждает `.admin-form { display: grid }`).
- Preview-блок (`.bulk-print-modal__preview`) растёт по
  `flex: 1 1 0`, его внутренняя сетка
  `.bulk-print-modal__preview-grid` — единственный scrollable
  child.
- `.admin-actions-row` — последний flex-child формы,
  `flex: 0 0 auto; margin-top: auto;` прижимает footer к низу
  карточки.
- `.bulk-print-modal__card` ограничен `calc(100dvh - 2rem)` и
  `overflow: hidden`; контент за края карточки не выходит,
  overlay-scroll становится не-нужным fallback'ом.
- Smoke-тесты ловят именно cascade-конфликт, а не просто наличие
  слова `display: flex` в одном из тел правила.

---

## 14. Resolution UPDATE 2026-05-09 — Option A+ + Portal

§13 описывает Option B (CSS-only специфичность) как «applied», но
**в коммитах эту резолюцию не довели**: в `globals.css` override-
селекторы не появились, и пользователь продолжал видеть «модалка
открывается по центру длинной страницы, кнопка "Печать" уходит
ниже viewport».

При повторном диагностическом проходе нашлась **вторая, более
фундаментальная причина**: на `.admin-page-shell` стоит
`animation: admin-page-appear 180ms ease both` с
`transform: translateY(0)` в финальном кадре. С `animation-fill-mode:
both` финал клеится навсегда, и `.admin-page-shell` становится
**containing block** для `position: fixed` потомков (CSS Containing
Block §4). То есть `.qr-modal { position: fixed; inset: 0 }` внутри
admin-страницы позиционируется не относительно viewport, а
относительно длинной admin-страницы. CSS-фикс самой модалки тут
бесполезен — ломается на уровне layout-engine ещё до того, как
`inset: 0` доходит до резолвинга.

**Итоговое решение — Option A+ + Portal (PR-2 из обсуждения):**

1. **Структурный фикс (Option A из §10):**
   - Из формы убрана class-name `admin-form` — конфликт `flex` vs
     `grid` устранён в корне.
   - Содержимое формы обёрнуто в `<div className="bulk-print-modal__body">`
     — единственный scroll-container модалки (single-scroll-context).
   - `<footer className="bulk-print-modal__footer">` вынесен **снаружи**
     `<form>`, submit-кнопка использует HTML5 `form={formId}` —
     нативный способ держать submit за пределами `<form>` без потери
     семантики.
   - Удалены мёртвые `.bulk-print-modal__settings` и
     `.bulk-print-modal__actions` (никогда не матчили DOM).

2. **Containing-block фикс:**
   - `@keyframes admin-page-appear` упрощён до opacity-only — убран
     `transform`. Defense in depth: ни одно `.admin-page-shell`-
     потомочное `position: fixed` больше не зависит от ancestor-
     transforms.
   - **Дополнительно**: bulk-print modal (и все остальные 10
     overlay-модалок проекта) переведены на React Portal через
     общий хелпер `apps/web/components/modal-portal.tsx`. Overlay
     рендерится прямым потомком `<body>` через `createPortal`, что
     гарантирует `position: fixed` относительно viewport независимо
     от любых будущих transformed-ancestor'ов.

3. **CSS baseline `.qr-modal*`:**
   - `.qr-modal` — `align-items: flex-start`, `padding: 1rem`,
     `overflow-y: auto` (overlay-scroll fallback).
   - `.qr-modal__card` — `width: min(100%, 520px)`, `margin: auto`,
     `display: flex; flex-direction: column`.
   - `.bulk-print-modal__card` — `max-height: calc(100dvh - 2rem)`,
     `overflow: hidden`, эксплицитный flex-column.
   - `.bulk-print-modal__body` — единственный `overflow-y: auto`.
   - `.bulk-print-modal__footer` — `flex: 0 0 auto`, `border-top`,
     `justify-content: flex-end`.

4. **Smoke-тесты:**
   - Удалён обсолетный блок про cascade-conflict (Option B).
   - Добавлены regression-guard'ы: `JSX-форма не использует
     .admin-form`, `JSX-footer лежит снаружи формы`, `submit
     использует form={formId}`, `@keyframes admin-page-appear не
     использует transform`, `все 11 overlay-модалок рендерятся
     через <ModalPortal>`.

См. также `docs/modal-positioning-recon.md` (общий разбор паттерна
для всех модалок).
