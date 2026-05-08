# Modal Positioning RECON

## 1. Symptom

- В UI длинных страниц (например, `/admin/printers/[id]`,
  `/admin/warehouses/[id]`) модальные окна визуально проигрывают:
  пользователь нажимает «Печать» (массовая печать ячеек, печать
  линии, диалоги в карточке принтера), и кнопка действия в
  модалке оказывается ниже видимой области экрана.
- Симптом ощущается как «модалка центрируется относительно
  длинной страницы, а не относительно viewport»: на коротких
  экранах ноутбуков и смартфонах низ карточки уходит за фолд,
  пользователь скроллит «всю страницу», а не саму модалку.
- Не нажимается primary-action — `Печать`, `Отмена`, `Сохранить`.
  Это блокирует продакшн-flow массовой печати наклеек.

## 2. Modal inventory

В кодовой базе несколько групп overlay-модалок. Все они
позиционируются `position: fixed` (см. `apps/web/app/globals.css`),
но вёрстка карточки и поведение скролла различаются.

| Component / file | CSS classes | Overlay positioning | Content scroll | Risk |
|------------------|-------------|---------------------|----------------|------|
| `apps/web/components/employees/employee-qr-button.tsx` (EmployeeQrButton) | `.qr-modal` + `.qr-modal__card.employee-qr-modal__card` | `position: fixed; inset: 0; display: flex; align-items: stretch; justify-content: center; padding: 0;` | `.qr-modal__card { max-height: 100dvh; overflow: auto; margin: auto }` (внутренний скролл карточки) | **Низкий**. Контент короткий, но `align-items: stretch + padding: 0` означает, что на мобиле карточка прижата к верх-низ viewport без полей. |
| `apps/web/app/work/qr-scanner-modal.tsx` (QrScannerModal) | `.qr-modal` | как выше | как выше | **Низкий**. Контент короткий. |
| `apps/web/app/work/passport-confirm-modal.tsx` (PassportConfirmModal) | `.qr-modal.passport-confirm` + `.qr-modal__card.passport-confirm__card` | как `.qr-modal` | как `.qr-modal__card` (сама карточка скроллится `overflow: auto`) | **Средний**. На длинных паспортах с маршрутом и shift-info контент не помещается, footer-кнопки `passport-confirm__actions` уезжают вниз карточки — пользователь должен догадаться скроллить **внутри** карточки. |
| `apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx` (BulkPrintModal / LinePrintButton) | `.qr-modal` + `.qr-modal__card.bulk-print-modal__card` | как `.qr-modal` | `.qr-modal__card { overflow: auto; max-height: 100dvh }`, внутри ещё `.bulk-print-modal__preview-grid { max-height: 32vh; overflow-y: auto }` | **Высокий**. Это и есть главный кейс: на длинном `warehouse/[id]` карточка модалки заполняет почти весь viewport, форма содержит 3 поля настроек + summary + preview + status + footer-кнопки `Отмена/Печать`. Footer уходит ниже карточки, пользователь видит preview но не видит submit. |
| `apps/web/app/work/seamstress-active-panel.tsx` (WrongSizeModal) | `.modal-backdrop` + `.modal` | `position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 1rem;` | **нет** `max-height` и **нет** скролла на `.modal` | **Высокий**. Если контент окажется длиннее viewport, модалка тупо растёт за пределы экрана и `.modal__actions` оказывается ниже — нет ни overlay-скролла, ни внутреннего скролла. |
| `apps/web/app/master/passport-actions-sheet.tsx` (PassportActionsSheet) | `.master-actions-sheet` + `.master-actions-sheet__card` | `position: fixed; inset: 0; display: flex; align-items: flex-end; justify-content: center;` (bottom-sheet) | `.master-actions-sheet__card { max-height: 92vh; overflow-y: auto }` | **Низкий**. Bottom-sheet, скролл карточки уже есть, footer-кнопки уезжают только при экстремально длинном маршруте. |
| `apps/web/app/master/cut-release-policy-card.tsx` (PolicySheet) | `.master-actions-sheet` | как выше | как выше | **Низкий**. Тот же sheet. |
| `apps/web/app/admin/patterns/[id]/add-pattern-size-modal.tsx`, `create-size-modal.tsx`, `apps/web/app/admin/orders/new/size-plan-selector.tsx` | `.admin-size-plan-modal__backdrop` + `.admin-size-plan-modal` | `position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 1rem;` | `.admin-size-plan-modal { max-height: calc(100vh - 2rem); display: flex; flex-direction: column; overflow: hidden }`, body `overflow-y: auto`, footer flex-fixed | **Низкий**. Уже корректный паттерн «card-internal-scroll + footer flex». Из мелочей — `100vh` вместо `100dvh` (на iOS адресная строка съедает низ при появлении). |
| `apps/web/components/orders/material-issues/create-material-issue-dialog.tsx`, `apps/web/components/warehouses/stock/stock-adjustment-dialog.tsx`, `stock-transfer-dialog.tsx`, `apps/web/components/orders/finished-goods/create-finished-goods-shipment-dialog.tsx` | `.material-issue-dialog` / `.stock-adjustment-dialog` / `.stock-transfer-dialog` / `.admin-form` | **inline panel** (без overlay), `role="dialog"` стоит, но визуально это не модалка — это секция страницы | n/a — обычный page scroll | **Не модалки**, не нуждаются в фиксе. Из задания исключаем. |
| `apps/web/app/work/shelf-placement-panel.tsx` | `aria-modal="true"` без overlay | inline | n/a | **Не модалка**. |

## 3. Root cause

1. **`.qr-modal` overlay использует `align-items: stretch` + `padding: 0`** (`apps/web/app/globals.css` ≈ строка 2562). Из-за `stretch` flex-карточка тянется на всю высоту, `margin: auto` спасает, но карточка всё равно прижата к верхнему/нижнему краю viewport без полей. На мобильном выглядит как «модалка во весь экран», и **внутренний скролл карточки пользователь не находит интуитивно** — ожидаемо, что скролл идёт страницы.
2. **`.qr-modal__card` имеет `max-height: 100dvh; overflow: auto`** — это card-internal-scroll, но без выделенного header/body/footer-flex: footer-кнопки (`Отмена/Печать`) лежат _внутри_ scrollable-области и могут оказаться за фолдом. На overlay уровне `.qr-modal` нет `overflow-y: auto`, значит overlay-scroll тоже не выручает.
3. **`.modal` (wrong-size)** не имеет `max-height` и не имеет `overflow`. Если контент перерастёт viewport, модалка просто выходит за границы экрана; ни overlay, ни карточка не скроллятся → footer-кнопки **физически недоступны**.
4. **`.bulk-print-modal__card`** (используется на `/admin/warehouses/[id]`) собирает много вертикали (settings 3-col → summary 3-col → preview-grid → status → actions) и в худшем случае требует, чтобы пользователь догадался скроллить внутри карточки. На длинной странице склада это и есть тот кейс, когда «нажал Печать → не вижу кнопку Печать».
5. Меньшие проблемы: `100vh` вместо `100dvh` (`.master-actions-sheet__card`, `.admin-size-plan-modal`) — на iOS Safari адресная строка ест низ.

## 4. Target behavior

- **Overlay** (`.qr-modal`, `.modal-backdrop`, `.master-actions-sheet`,
  `.admin-size-plan-modal__backdrop`):
  - `position: fixed; inset: 0;`
  - `z-index` поверх `.app-main` (≥ 80, у нас сейчас `100`);
  - `display: flex` или `grid` с центрированием по обеим осям;
  - `padding` 16px (рамка от viewport);
  - `overflow-y: auto` — overlay сам скроллится, если карточка
    выше viewport;
  - `overscroll-behavior: contain` — скролл не «пробивается» в
    подложку.
- **Modal panel / card** (`.qr-modal__card`, `.modal`,
  `.admin-size-plan-modal`):
  - `width: min(100%, max-width)` — карточка не уходит за
    overlay-padding;
  - `max-height: calc(100dvh - 32px)` (с fallback `100vh`);
  - `display: flex; flex-direction: column;`
  - `overflow: hidden` (внутренние секции отвечают за скролл).
- **Modal body** (форма, контент карточки):
  - `min-height: 0` (важно для flex-child со скроллом);
  - `overflow-y: auto;` — длинный контент скроллится **внутри**
    карточки.
- **Modal footer / actions**:
  - `flex: 0 0 auto;` — не сжимается, всегда на дне карточки;
  - не зависит от внутреннего скролла body;
  - на странице принтеров кнопка `Печать` остаётся в видимой
    области без прокрутки всей страницы.

## 5. Fix plan (минимальный, без redesign)

1. **`apps/web/app/globals.css`** — общий CSS для всех overlay-
   модалок:
   - `.qr-modal`: `align-items: center` + `padding: 1rem` +
     `overflow-y: auto` + `overscroll-behavior: contain`. На
     `min-width: 600px` оставляем существующий `padding: 1.5rem`.
   - `.qr-modal__card`: переезжаем на flex-column + `max-height`
     от `100dvh`, отдавая внутренний скролл выделенной body-
     секции. Для модалок, где card сам уже flex-column (employee-
     qr, scanner, passport-confirm, bulk-print), это no-op по
     визуалу — body просто получает `min-height: 0; overflow: auto`.
   - `.qr-modal__cancel`, `passport-confirm__actions`,
     `.bulk-print-modal__actions` — `flex: 0 0 auto`, footer
     прибит в низ карточки.
   - `.modal-backdrop`: добавить `overflow-y: auto;
     overscroll-behavior: contain` (overlay-scroll fallback на
     случай мобильного wrong-size диалога с длинным текстом).
   - `.modal`: `max-height: calc(100dvh - 2rem)`,
     `display: flex; flex-direction: column; overflow: hidden`;
     `.modal__actions` остаётся flex-row, `flex: 0 0 auto`.
   - `.admin-size-plan-modal`: `100vh` → `100dvh` (с fallback).
   - `.master-actions-sheet__card`: `92vh` → `92dvh` (fallback).
2. **Bulk print**: `apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx`
   и общий CSS — структура «header → form (scroll) → actions
   (flex: 0)». Без изменения JSX добиваемся этого через CSS:
   `.bulk-print-modal__form { display: flex; flex-direction:
   column; overflow: hidden; min-height: 0; }`, форму делаем
   flex-child с `overflow-y: auto`, footer-actions выводим
   через CSS-grid trick (последний `.admin-actions-row` внутри
   `.bulk-print-modal__form` получает `margin-top: auto` и
   `flex-shrink: 0`). Дополнительно ограничиваем тело формы
   через scrollable-wrapper.
3. **Тесты**: `tests/smoke/modal-positioning.smoke.test.ts` —
   статически проверяем CSS-правила и наличие footer-actions
   в bulk-print/qr-modal без `position: fixed` на отдельных
   кнопках.
4. **Документация**: обновить `docs/screens.md §«Печать всех
   ячеек»` коротким уточнением «overlay скроллится, footer
   sticky».

После фикса:

- Все overlay-модалки центрируются по viewport и не зависят от
  длины страницы.
- На страницах принтеров и складов кнопка `Печать` остаётся в
  пределах видимой области без скролла всей страницы.
- Длинные модалки скроллят свой body, footer-кнопки
  доступны.
- Backend, Prisma, auth, packing, payroll и QR не затронуты.

## 6. Warehouse bulk print modal — unresolved footer visibility

**Симптом после первого фикса.** На `/admin/warehouses/:id` модалка
«Печать линии «A» — Основной склад» рендерит content (заголовок,
выбор принтера, размер этикетки, копии, summary, preview), но
footer `Отмена / Печать` оказывается **ниже viewport** и нажать
`Печать` без скролла невозможно. Скриншот пользователя
подтверждает: внутри overlay видно form, но action-row уехал.

**Фактические классы (из
`apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx`):**

| Слой | Класс | Где |
|------|-------|-----|
| Overlay | `qr-modal` | `<div className="qr-modal" role="dialog">` |
| Card | `qr-modal__card bulk-print-modal__card` | внутри overlay |
| Header | `qr-modal__header` | первый ребёнок card |
| Form | `bulk-print-modal__form admin-form` | второй ребёнок card |
| Settings | `admin-form-grid` → `admin-field` × 3 | внутри form |
| Summary | `bulk-print-modal__summary` | внутри form |
| Preview | `bulk-print-modal__preview` → `bulk-print-modal__preview-grid` | внутри form |
| Actions | `admin-actions-row` (последний ребёнок form) | внутри form |

**Почему предыдущий fix не помог.** В `globals.css` было правило:

```css
.bulk-print-modal__form > .admin-actions-row {
  position: sticky;
  bottom: 0;
  background: #fff;
  margin-top: auto;
  padding-top: 0.5rem;
  z-index: 1;
  flex: 0 0 auto;
}
```

Оно опирается на overlay-scroll внутри `.qr-modal`
(`overflow-y: auto`). Но `position: sticky` стикается только
внутри своего **containing block** — то есть
`.bulk-print-modal__form`. Containing block имеет высоту,
равную сумме высот детей формы; `actions-row` — последний
ребёнок, его натуральная нижняя граница совпадает с нижней
границей формы. У sticky нет «лишнего пространства» ниже
себя, чтобы залипнуть выше — он остаётся в потоке. На длинной
карточке overlay проскролливает форму вместе с footer'ом ниже
видимой области.

К этому добавляется то, что `.bulk-print-modal__card`
**не ограничен по высоте** — нет ни `max-height`, ни внутреннего
flex-scroll. Карточка растёт под весь контент, оверлей
скроллится, но footer уезжает вместе с карточкой.

**Корректный fix (panel-bounded layout).**

Вместо overlay-scroll закрепляем footer тем, что ограничиваем
саму карточку и отдаём scroll выделенному body внутри карточки:

```css
.bulk-print-modal__card {
  max-height: calc(100dvh - 2rem); /* fallback 100vh ниже */
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.bulk-print-modal__form {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.bulk-print-modal__preview {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
.bulk-print-modal__preview-grid {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* убираем max-height: 32vh — теперь верхний лимит задаёт сама карточка */
}
.bulk-print-modal__form > .admin-actions-row {
  flex: 0 0 auto;
  /* sticky больше не нужен — actions последний flex-child формы */
  border-top: 1px solid var(--color-border);
  padding-top: 0.6rem;
  background: #fff;
}
```

Что это даёт:

1. Card никогда не выше viewport, всегда умещается целиком.
2. Settings, summary, success/error и actions — фиксированные
   по высоте flex-children.
3. Preview-grid (длинный список ячеек) — единственный
   scrollable child, занимает всё оставшееся место и скроллится
   внутри.
4. Actions всегда видны на дне карточки, без оглядки на overlay.

Это не ломает Employee QR / scanner / passport-confirm, потому
что max-height добавляется только на modifier `.bulk-print-modal__card`.

## 7. Final fix (cascade-конфликт `.admin-form` ↔ `.bulk-print-modal__form`)

После двух CSS-итераций (sticky-footer и panel-bounded layout
из §6) пользователь по-прежнему не мог нажать `Печать` в модалке
«Печать линии «A» — Основной склад». Полный разбор —
[`docs/warehouse-bulk-print-modal-runtime-recon.md`](warehouse-bulk-print-modal-runtime-recon.md).

**Корень.** JSX формы — `<form className="bulk-print-modal__form admin-form">`.
В [`apps/web/app/globals.css`](../apps/web/app/globals.css)
`.admin-form { display: grid }` объявлен ниже `.bulk-print-modal__form { display: flex }`
с равной специфичностью (0,1,0). По CSS cascade `.admin-form` побеждает
по source-order — form становится **grid**-контейнером, и все
flex-зависимые правила (`flex: 1 1 0` на preview,
`flex: 0 0 auto`/`margin-top: auto` на actions) превращаются в
noop. Footer уезжает ниже viewport.

**Final fix — Option B (CSS-only, специфичность).** В
[`apps/web/app/globals.css`](../apps/web/app/globals.css)
добавлены компаунд-селекторы
`.bulk-print-modal__card .bulk-print-modal__form.admin-form`
(специфичность 0,3,0–0,4,0) — гарантированно выигрывают у
`.admin-form` независимо от source-order:

```css
.bulk-print-modal__card .bulk-print-modal__form.admin-form { display: flex; flex-direction: column; … }
.bulk-print-modal__card .bulk-print-modal__form.admin-form > * { flex: 0 0 auto; }
.bulk-print-modal__card .bulk-print-modal__form.admin-form > .bulk-print-modal__preview { flex: 1 1 0; … }
.bulk-print-modal__card .bulk-print-modal__form.admin-form > .admin-actions-row { flex: 0 0 auto; margin-top: auto; … }
```

Дополнительно:

- `.bulk-print-modal__card` получил явные `display: flex;
  flex-direction: column;` (для smoke-теста и для самостоятельного
  чтения файла).
- Удалены никогда не применявшиеся `.bulk-print-modal__settings*`
  и `.bulk-print-modal__actions*` (DOM рендерит их как
  `admin-form-grid` и `admin-actions-row`).
- Smoke-test
  [`tests/smoke/modal-positioning.smoke.test.ts`](../tests/smoke/modal-positioning.smoke.test.ts)
  расширен секцией «cascade conflict .admin-form vs
  .bulk-print-modal__form» — раньше проверка наличия
  `display: flex` в теле `.bulk-print-modal__form` была
  false-positive, потому что cascade выигрывал
  `.admin-form { display: grid }`.

JSX, backend, DTO, Prisma и печатная бизнес-логика **не
изменены**.
