# Prelaunch cleanup recon

> Read-only обзор перед запуском. Цель — найти старый дизайн, мёртвые
> файлы, дублирующие компоненты и legacy, который можно безопасно
> удалить или изолировать. **Ничего не удалено и не переименовано.**
>
> Источник правды по принятым архитектурным решениям —
> `docs/recon-soft-integration.md` (особенно §«Номенклатура = Лекала»),
> ADR-0022 (snapshot техкарт) и комментарии в `apps/web/app/orders/*` /
> `apps/web/app/admin/orders/*`.
>
> Recon делался прямым осмотром исходников + `rg`. Все «мёртвые»
> утверждения подтверждены отсутствием совпадений `from
> '<path>'` / `<ComponentName>` в `apps/`. Smoke-тесты, которые
> охраняют те или иные файлы / классы, перечислены явно.

---

## 1. Краткий вывод

**Что можно почистить сразу (Safe to delete):**

- `apps/web/components/detail-page-header.tsx` — компонент
  **не импортируется ни в одной странице приложения**
  (`rg "DetailPageHeader" apps/` находит только сам файл). Был
  заменён `AdminPageShell` (`@/components/admin/admin-page-shell.tsx`)
  в Admin UI 2.5–2.7. Smoke-тесты явно гарантируют его отсутствие
  в admin-страницах:
  `tests/smoke/admin-final-cleanup.smoke.test.ts`,
  `admin-ui-consistency.smoke.test.ts`, `admin-ui-polish.smoke.test.ts`,
  `admin-orders-create.smoke.test.ts`, `admin-order-edit.smoke.test.ts`,
  `display-screens-admin.smoke.test.ts`,
  `employees-admin.smoke.test.ts`, `operations-admin.smoke.test.ts`,
  `warehouses-admin.smoke.test.ts`. **Важно:** связанные CSS-классы
  `.detail-header*` (`globals.css` lines 1894–1946) **НЕ удаляем** —
  они напрямую используются `apps/web/app/passports/[id]/page.tsx`
  (см. §7).
- `apps/web/components/status-pill.tsx` — компонент **не
  импортируется ни в одной странице**
  (`rg "StatusPill|status-pill" apps/` находит только сам файл).
  Сохранился как «исторический» виджет mobile-design-system,
  упоминается только в `docs/ui-mobile.md` и `README.md`.
  **Важно:** связанные CSS-классы `.pill*` (`globals.css`
  lines 452–467) **НЕ удаляем** — они напрямую используются
  `apps/web/app/passports/[id]/page.tsx` (см. §7).

**Что нужно ОСТАВИТЬ как legacy bridge (см. §7 ниже):**

- `Product` / `productId` / `/api/products` / `listProducts`
  (`apps/web/lib/orders-api.ts:110`,
  `apps/api/src/modules/catalog/catalog.controller.ts`,
  `apps/web/app/orders/new/page.tsx`,
  `apps/web/app/orders/[id]/edit/page.tsx`).
  В `OrderItem.productId`, `Passport.productName`, payroll и
  legacy-формах `/orders/new` ещё нужны (см.
  `docs/recon-soft-integration.md §«Номенклатура = Лекала»` и
  helper `OrdersService.ensureLegacyProductForPattern()`,
  `apps/api/src/modules/orders/orders.service.ts:304`).
- Каталог `apps/web/app/orders/*` целиком — старый layout заказа.
  На него ссылаются `app-header` (`app/layout.tsx:94`),
  `home page` (`app/page.tsx:154`),
  `production-dashboard` (`app/admin/production-dashboard/page.tsx:353`).
  `/orders/[id]/passports/new` — единственная точка выпуска
  паспорта для роли `CUTTER_ASSISTANT`. Smoke-тест
  `admin-order-edit.smoke.test.ts §«legacy /orders/[id]/edit —
  НЕ удалён»` (line 167) и `admin-orders-create.smoke.test.ts
  §«legacy /orders/new — НЕ удалён»` (line 259) явно охраняют
  файлы от удаления.
- `apps/web/components/orders/pattern-preview-card.tsx` с
  `variant: 'admin' | 'legacy'` (line 49) — один и тот же DTO,
  два рендера. Оба используются (admin —
  `/admin/orders/[id]/page.tsx:405`, legacy —
  `/orders/[id]/page.tsx:156`). Файл нельзя дробить.

**Где основные дубли (потенциал на следующий этап):**

- **Создание заказа: две формы поверх одного `createOrderAction`** —
  `apps/web/app/orders/new/new-order-form.tsx` (legacy «голая»
  форма с `productId`-select) **и**
  `apps/web/app/admin/orders/new/admin-create-order-form.tsx`
  (новая admin-форма с `patternItemId`). Обе шлют ту же
  Zod-схему `CreateOrderSchema` (`packages/shared/src/orders.ts`
  принимает оба поля как опциональные, `superRefine` требует
  «хотя бы одно из двух»). Кандидат на schedule «Этап 3 —
  redirect/deprecate legacy», но требует подтверждения, что
  `CUTTER_ASSISTANT` не использует страницу — RBAC внутри страницы
  редиректит CUTTER_ASSISTANT (`apps/web/app/orders/new/page.tsx:20`).
  См. §8.1.
- **Редактирование заказа**: `apps/web/app/orders/[id]/edit/`
  (legacy) vs `apps/web/app/admin/orders/[id]/edit/` (admin) —
  та же ситуация. Smoke явно фиксирует, что обе должны
  существовать.
- **Карточка заказа**: `apps/web/app/orders/[id]/page.tsx`
  (legacy — управляющие действия Start/Complete/Cancel живут
  только здесь) vs `apps/web/app/admin/orders/[id]/page.tsx`
  (admin pretty-wrapper). Кнопка «Открыть старую карточку» из
  admin → legacy явно есть (`page.tsx:182`).
- **Список заказов**: `apps/web/app/orders/page.tsx` (legacy
  таблица) vs `apps/web/app/admin/orders/page.tsx` (admin shell
  с deadline-фильтрами, KPI-табами). На момент recon у обоих
  одинаковый backend (`listOrders`).
- **Текстовые названия колонок «Изделие»** в 13 разных pages —
  все показывают `productName` (legacy concept). После
  «Номенклатура = Лекала» бизнес-сущность называется «Лекало»,
  но менять подпись в паспорте/ОТК/ВТО/упаковке нужно только
  когда на бэке точно поедет `patternName` (а не `productName`)
  — задача за пределами этого recon.

---

## 2. Текущие активные пользовательские маршруты

| Route | Назначение | Оставить? | Комментарий |
|---|---|---|---|
| `/` | Корневая landing-страница (ролевая плитка для админа/менеджера, авторедирект для производственных ролей). | Да | `app/page.tsx`. |
| `/login` | Логин. | Да | Единственная public-страница. |
| `/admin` | Admin home: KPI «Контроль сроков» + dashboard разделов. | Да | Уже Admin UI 2.6, активный. |
| `/admin/orders` | Новый список заказов с deadline-табами. | Да | Активная новая страница. |
| `/admin/orders/new` | Новая форма создания заказа («Номенклатура = Лекала»). | Да | Единственная официальная точка для менеджера. |
| `/admin/orders/[id]` | Новая карточка заказа (`admin-grid-2`). | Да | Активная. Содержит ссылку «Открыть старую карточку». |
| `/admin/orders/[id]/edit` | Новая форма редактирования (карточный layout). | Да | Активная. |
| `/admin/clients`, `/admin/clients/[id]`, `/admin/clients/new` | Справочник клиентов. | Да | Активные. |
| `/admin/employees*`, `/admin/equipment*`, `/admin/operations*`, `/admin/routes*`, `/admin/tech-cards*`, `/admin/warehouses*`, `/admin/printers*`, `/admin/display-screens*`, `/admin/diagnostics`, `/admin/production-cost`, `/admin/overview`, `/admin/production-dashboard` | Справочники / админ-разделы. | Да | Все активны, в Admin UI 2.5+. |
| `/admin/patterns*` | Раздел «Номенклатура / Лекала» (Patterns MVP-1). | Да | Активный, под feature-flag `NEXT_PUBLIC_FEATURE_PATTERNS` (default-on). |
| `/admin/workshop-needs*` | «Потребность цеха» (Этап 4А). | Да | Активный, feature-flag `NEXT_PUBLIC_FEATURE_WORKSHOP_NEEDS`. |
| `/admin/suppliers*` | Поставщики (Этап 5). | Да | Feature-flag `NEXT_PUBLIC_FEATURE_SUPPLIERS`. |
| `/admin/purchase-orders*` | Заказы поставщикам (Этап 6А). | Да | Feature-flag `NEXT_PUBLIC_FEATURE_PURCHASE_ORDERS`. |
| `/admin/purchase-receipts*` | Приёмка поставок (Этап 7А). | Да | Feature-flag `NEXT_PUBLIC_FEATURE_PURCHASE_RECEIPTS`. |
| `/orders` | Legacy список заказов. | Да (как legacy bridge) | На него ссылаются `app/page.tsx:154`, `app/layout.tsx:94`, `app/admin/production-dashboard/page.tsx:353`. |
| `/orders/[id]` | Legacy карточка заказа (управляющие действия Start/Complete/Cancel живут здесь). | Да (как legacy bridge) | Ссылается из `qc`, `packing`, `passports/[id]`, `work/cut-orders`, и из admin как «Открыть старую карточку». |
| `/orders/[id]/edit` | Legacy форма редактирования. | Да (как legacy bridge) | Smoke `admin-order-edit.smoke.test.ts §«legacy /orders/[id]/edit — НЕ удалён»` охраняет. |
| `/orders/[id]/passports/new` | Выпуск паспорта по заказу — единственная точка для `CUTTER_ASSISTANT`. | Да (production-critical) | Внутри страницы есть отдельный back-link для CUTTER_ASSISTANT (на `/work`). |
| `/orders/new` | Legacy форма создания заказа (с `productId`-select). | Кандидат на deprecate (см. §8.1) | RBAC внутри страницы редиректит CUTTER_ASSISTANT → `/orders` (`page.tsx:20`). Доступна ADMIN/SHOP_MANAGER, дублирует `/admin/orders/new`. |
| `/work`, `/work/cut-orders` | Терминал швеи / помощника раскройщика. | Да | Активные production flow. |
| `/qc`, `/qc/passports/[id]` | Терминал ОТК. | Да | Активные. |
| `/wto` | Терминал ВТО. | Да | Активные. |
| `/packing`, `/packing/boxes/[id]` | Терминал упаковки. | Да | Активные. |
| `/passports/[id]` | Detail-page паспорта. | Да | Используется ВСЕМИ ролями. |
| `/master` | Экран мастера (master-actions / cut-release-policy). | Да | Активный. |
| `/shopfloor`, `/shopfloor/display` | Цех + большой экран. | Да | Активные. |
| `/earnings` | Зарплата. | Да | Активный. |
| `/production-cost` | Себестоимость. | Да | Активный (managers). |

---

## 3. Старые / дублирующие маршруты

| Route/file | Почему старый | Риск удаления | Рекомендация |
|---|---|---|---|
| `apps/web/app/orders/new/page.tsx` + `new-order-form.tsx` | Дублирует `/admin/orders/new`. Грузит legacy `listProducts()`, `productId`-select явный (`new-order-form.tsx:82`). RBAC внутри (`role !== 'ADMIN' && role !== 'SHOP_MANAGER' redirect('/orders')`, line 20) показывает: CUTTER_ASSISTANT сюда **не попадает**. Тайл «+ Создать заказ» на `/orders` ведёт сюда (line 81), в админке — на `/admin/orders/new`. | Средний — нужно убедиться, что внешние интеграции/закладки не открывают этот URL и заменить кнопку «+ Создать заказ» на странице `/orders` на ссылку на новый admin. | Не удалять сейчас. Кандидат на Этап 3: redirect `/orders/new → /admin/orders/new` для `ADMIN`/`SHOP_MANAGER` (форма уже умеет всё то же самое). Smoke `admin-orders-create.smoke.test.ts §«legacy /orders/new — НЕ удалён»` отдельно разрешает существование файлов как «легаси-flow CUTTER_ASSISTANT» — этот комментарий устарел (см. §8.1). |
| `apps/web/app/orders/[id]/edit/page.tsx` + `edit-order-form.tsx` | Дублирует `/admin/orders/[id]/edit`. Содержит legacy `productId`-select (`edit-order-form.tsx:161`), грузит `listProducts()` (`page.tsx:50`). Ссылка из `OrderActions` (`/orders/[id]/order-actions.tsx:39`) ведёт на `/orders/[id]/edit` — при `status === 'DRAFT'`. Внешних ссылок на эту страницу больше нет. | Средний — это используется legacy-flow редактирования черновика. | Не трогать. Кандидат на Этап 3 после того, как legacy `/orders/[id]/page.tsx::OrderActions` будет переключён на новую форму или сам legacy-detail исчезнет. Сейчас smoke явно охраняет файлы от удаления. |
| `apps/web/app/orders/[id]/page.tsx` | Legacy карточка заказа. Содержит управляющие действия Start/Complete/Cancel (нет в новой admin-карточке) и единственный заголовок «Изделие» (а не «Номенклатура»). Используется и менеджерами (через «Открыть старую карточку»), и `CUTTER_ASSISTANT`. | Высокий — там сейчас живут Start/Complete/Cancel. | Оставить как legacy bridge. Перенос управляющих действий в `/admin/orders/[id]` — отдельный этап. |
| `apps/web/app/orders/page.tsx` | Legacy список заказов. На него ведут шапка (`AppHeader` через `app/layout.tsx:94`), home-tile «Заказы» (`app/page.tsx:154`), `production-dashboard` (`app/admin/production-dashboard/page.tsx:353`). «Настоящий» admin-список — `/admin/orders`. | Низкий-средний — пункт меню «Заказы» в шапке для CUTTER_ASSISTANT/менеджеров идёт сюда. | Оставить пока как legacy bridge. Возможно, шапку для менеджеров перевести на `/admin/orders` (нужно UX-решение, см. §8.2). |
| `apps/web/app/orders/[id]/passports/new/page.tsx` + `new-passport-form.tsx` | На вид «legacy» (вне `/admin/*`), но это **единственная точка выпуска паспорта для `CUTTER_ASSISTANT`**, и из `app/work/cut-orders/page.tsx` (рабочее место помощника) ведёт ссылка `/orders/${o.id}/passports/new`. Внутри страницы есть отдельный back-link для CUTTER_ASSISTANT (на `/work`, `page.tsx:50`). | Высокий — production-critical flow. | Оставить. Не помечать на удаление. |

---

## 4. Компоненты-кандидаты на удаление

| File | Import count | Почему удалить | Риск |
|---|---|---|---|
| `apps/web/components/detail-page-header.tsx` | **0** в исходниках приложения. `rg "from '.*detail-page-header'\|DetailPageHeader" apps/` — пусто за пределами самого файла. | Заменён `AdminPageShell` (`@/components/admin/admin-page-shell.tsx`). Smoke-тесты по 9 admin-разделам охраняют отсутствие импорта (см. §1). Документация в `docs/screens.md` / `docs/ui-mobile.md` / `README.md` ещё ссылается, но это историческое упоминание. | Низкий. После удаления нужно убрать упоминания из docs (опционально, не блокер). |
| `apps/web/components/status-pill.tsx` | **0**. `rg "from '.*status-pill'\|StatusPill" apps/` — пусто за пределами самого файла. | Использовался в mobile-design-system, не подключен ни к одной активной странице. Документация (`docs/ui-mobile.md`, `README.md`) ссылается. **CSS-классы `.pill*` НЕ мёртвые** — используются `apps/web/app/passports/[id]/page.tsx` (см. §7), при удалении компонента CSS оставляем. | Низкий. |

**Не удалять (хотя похоже на «duplicate»):**

- `apps/web/components/status-badge.tsx` — активно используется на legacy `/orders` (`page.tsx:12`), `/passports/[id]`, `/qc`, etc. Это «строгий» бейдж статуса заказа (legacy CSS `.status-badge`), не путать со «свободным» `StatusPill`.
- `apps/web/components/admin/admin-status-badge.tsx` — admin-стиль бейджа, активно используется по всему `/admin`. Не дубль `status-badge`, потому что у них разные дизайн-системы.
- `apps/web/components/app-section-card.tsx` — активно импортируется `app/passports/[id]/page.tsx:19` (множество секций паспорта). Оставить.
- `apps/web/components/role-header-card.tsx` — активно используется на `/work`, `/qc`, `/wto`, `/packing`. Оставить.
- `apps/web/components/print-button.tsx` + `print-button-actions.ts` — используются `passports/[id]` и `orders/[id]/passports/new`. Оставить.
- `apps/web/components/mobile-action-card.tsx` — используется `app/page.tsx`. Оставить.
- `apps/web/components/call-master-button.tsx` — используется `work/`, `qc/`, `wto/`, `packing/` layout-ами. Оставить.
- `apps/web/components/chunk-error-guard.tsx` — используется `app/layout.tsx:19`. Оставить.
- `apps/web/components/admin/pattern-hero-preview.tsx` — используется `/admin/orders/new`. Оставить.
- `apps/web/components/orders/pattern-preview-card.tsx` — используется `/admin/orders/[id]` (variant=admin) и `/orders/[id]` (variant=legacy). Оставить.
- `apps/web/components/orders/cut-readiness-card.tsx`, `purchase-orders-card.tsx`, `purchase-receipts-card.tsx`, `workshop-needs-card.tsx`, `workshop-needs-calculate-form.tsx` — все используются на `/admin/orders/[id]`. Оставить.

**Спорное (см. §8.4):**

- `apps/web/components/admin/admin-production-heatmap.tsx` —
  компонент **не импортируется ни одной страницей**
  (`rg "AdminProductionHeatmap" apps/web/app` — пусто). Реэкспорт
  есть в `components/admin/index.ts:16`, но потребителей нет.
  Smoke `admin-final-cleanup.smoke.test.ts §«/admin/page.tsx не
  импортирует AdminProductionHeatmap»` (line 57) явно требует
  отсутствия импорта в `/admin`, а
  `admin-analytics.smoke.test.ts` всё ещё хранит экспорт как
  «доступный для будущей аналитики». Это «спящий» компонент.
  Перевести в §8 «Needs decision»: либо удалить (тогда обновить
  smoke + barrel + `lib/admin-analytics.ts`), либо явно вернуть
  на `/admin` или `/admin/production-dashboard`.

---

## 5. CSS-классы-кандидаты на удаление

| Class | Где найден | Используется? | Рекомендация |
|---|---|---|---|
| `.detail-header`, `.detail-header__main`, `.detail-header__back`, `.detail-header__meta`, `.detail-header__badges`, `.detail-header__aside`, `.detail-header__actions` | `apps/web/app/globals.css` lines 1894–1946 (≈55 строк). | **Да** — `.detail-header__back` напрямую используется `apps/web/app/passports/[id]/page.tsx:128`. | **Не удалять.** Live UI styles паспорта. См. §7. |
| `.pill`, `.pill--accent`, `.pill--ok`, `.pill--warn`, `.pill--danger`, `.pill--ghost` | `globals.css` lines 452–467. | **Да** — `.pill`, `.pill--accent`, `.pill--ok`, `.pill--warn`, `.pill--ghost` используются `apps/web/app/passports/[id]/page.tsx` (lines 160, 165, 251, 369, 375, 379, 445). | **Не удалять.** Live UI styles паспорта. См. §7. |
| `.admin-order-card__secondary`, `.admin-order-card__secondary > .admin-field > label` | `globals.css` lines 8112–8129. | Нет. Smoke `admin-orders-create.smoke.test.ts:159` и `admin-order-layout.smoke.test.ts:189` явно проверяют, что в форме НЕТ этого класса. | **Можно удалить из CSS.** Класс описан как «контейнер для „Учётное изделие"», но «Учётное изделие» (`productId`-select) удалено из admin-форм после «Номенклатура = Лекала». Реальный риск — нулевой; smoke даже охраняет отсутствие класса. |
| Header-комментарий блока «Admin Order Form 2.1» — упоминание `--secondary` / `__secondary` для «Учётного изделия» | `globals.css` lines 7984–7986. | Только комментарий. | **Safe to delete** в комментарии после удаления `.admin-order-card__secondary`. |
| Упоминание `pill` в большом комментарии-описании группы | `globals.css` line 1421 (`.data-table / .summary-card / .status-badge / .pill / .action-card`). | Только комментарий. | **Не трогать** — сами классы `.pill*` остаются (используются паспортом, см. §7). |
| `.admin-order-card--dates` | `globals.css` (внутри общего блока `.admin-order-card*`); `apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx:376`. | Да — карточка «2. Сроки» в форме редактирования. Smoke `admin-order-edit.smoke.test.ts:108` явно требует этот класс; smoke `admin-order-layout.smoke.test.ts:136` и `admin-orders-create.smoke.test.ts:124` явно требует, чтобы его НЕ было в форме создания. | **Не удалять.** Это часть конструктора карточек заказа `--order/--dates/--product/--production/--sizes/--hero`. Чистить только если будет принято решение убрать карточку «2. Сроки» из admin-edit (нет основания). |
| `.admin-pattern-preview` | Используется только как тег для `AdminCard` в `pattern-preview-card.tsx:257`; правил для самого класса в `globals.css` нет. | Только использование, без правил. | Условно. Можно почистить тег у `AdminCard`, но проще оставить — нулевой эффект. |
| `.admin-overview*` | Используется в `/admin/overview/page.tsx`. | Да. | **Не удалять.** |
| `.admin-deadline-kpis*`, `.admin-deadline-kpi*`, `.admin-deadline-tabs*`, `.admin-deadline-tab*`, `.admin-deadline-cell*`, `.admin-deadline-card*`, `.admin-deadline-progress*` (45 совпадений в `globals.css`) | Используются на `/admin`, `/admin/orders`, `/admin/orders/[id]`, `/admin/clients/[id]`. | Да, все активны. | **Не трогать.** |
| `.admin-order-card`, `.admin-order-card--*`, `.admin-order-card__icon*`, `.admin-order-card__title`, `.admin-order-card__header`, `.admin-order-summary*`, `.admin-order-due-badge`, `.admin-order-pattern-summary*`, `.admin-order-form__top`, `.admin-order-form__middle`, `.admin-order-form__sizes-footer`, `.admin-order-form__hint`, `.admin-order-form__actions`, `.admin-order-route-preview`, `.admin-pattern-hero*` | Используются в `/admin/orders/new`, `/admin/orders/[id]/edit` (см. §1 раздел «дубли»). | Да. | **Не трогать.** |
| `.section-card`, `.section-card__title`, `.section-card__hint` | Используются `AppSectionCard` (passports/[id]) и `admin/operations/[id]/edit-form`. | Да. | **Не трогать.** |
| `.status-badge.*` | Используется `StatusBadge` на `/orders/*`, `/passports/[id]`, `/qc`, `/wto`, `/packing`. | Да. | **Не трогать.** |

**Прямых упоминаний классов из ТЗ recon (`admin-order-deadline`, «old product labels»):** не найдено в `globals.css`. Видимо переименованы заранее в `.admin-deadline-*`.

---

## 6. Старые UI-тексты

| Text | File | Что сделать |
|---|---|---|
| «Изделие» (`<th>` / `<label>` / `<dt>`) | `apps/web/app/orders/page.tsx:127`, `apps/web/app/orders/[id]/page.tsx:134`, `apps/web/app/orders/[id]/edit/edit-order-form.tsx:161`, `apps/web/app/orders/new/new-order-form.tsx:82`, `apps/web/app/orders/[id]/passports/new/new-passport-form.tsx:169`, `apps/web/app/admin/overview/page.tsx:184`, `apps/web/app/admin/orders/page.tsx:360` (`header: 'Изделие'`), `apps/web/app/qc/qc-work-card.tsx:79`, `apps/web/app/qc/passports/[id]/page.tsx:68`, `apps/web/app/wto/wto-work-card.tsx:69`, `apps/web/app/passports/[id]/page.tsx:150`, `apps/web/app/packing/packing-terminal.tsx:440`, `apps/web/app/work/active-shift-panel.tsx:92`, `apps/web/app/work/passport-confirm-modal.tsx:150`, `apps/web/app/admin/orders/[id]/page.tsx:297` («3. Изделие»), `apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx:434` («3. Изделие»), `apps/web/app/admin/orders/new/admin-create-order-form.tsx:363` («2. Изделие»). | **Safe to relabel.** Везде показывается `productName` / `pattern.name`. После принятия «Лекало = единица номенклатуры» можно везде заменить на «Номенклатура» / «Лекало». **Но**: в задаче запрещено менять UI и backend, поэтому в этом recon — только перечень. |
| «Учётное изделие» (упоминание в коде/CSS) | Уже удалено из UI; осталось в комментариях `apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx:12,440` и в комментарии CSS `globals.css:8112` (`/* --- Второстепенный контейнер для «Учётное изделие» --- */`) и `globals.css:7984` (header-комментарий блока). | **Safe to delete** в CSS-комментариях после удаления `.admin-order-card__secondary`. Комментарии в `admin-edit-order-form.tsx` оставить — они объясняют, почему поля больше нет (полезный контекст). |
| «Используется для текущего учёта» | Только в smoke-тестах (`tests/smoke/admin-orders-create.smoke.test.ts:157`) как охрана «текста НЕТ в форме». | **Не трогать.** Это negative-assertion. |
| «Статус срока» / «Без срока сдачи» | Активный текст: `apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx:421-423` (карточка «2. Сроки»). Smoke `admin-orders-create.smoke.test.ts:165-166` явно требует, чтобы этих фраз НЕ было в форме создания (там используется badge `admin-order-due-badge` «Срок не указан»). | **Можно унифицировать** между формой создания и редактирования. Оставлены как «активные тексты», менять только если будет принято UX-решение (см. §8.6). |
| «Срок не указан» (badge) | `admin-create-order-form.tsx:288`. | Активный, оставить. |
| «Лекала ещё не заведены» как заголовок empty-state | `apps/web/app/admin/patterns/page.tsx:226`. Sidebar и шапка раздела используют «Номенклатура» (`apps/web/components/admin-sidebar.tsx:181` и `apps/web/app/admin/patterns/page.tsx:158 title="Номенклатура"`). | **Safe to relabel** на «Номенклатура» если хочется консистентности, но текущая формулировка читается естественно. Можно оставить. |
| «Product» (как ярлык в UI) | Не встречается в видимых пользователю строках. Только в комментариях кода и docs. | **Не трогать.** |
| «productId» / «productName» | Только в коде / комментариях / smoke. Не видно пользователю. | **Не трогать.** |
| «старого учёта» | Не встречается в текущем коде. | — |
| «legacy» | Только в комментариях кода (≈25 совпадений в `apps/web/app`). | **Не трогать.** Комментарии важны как маркер «это технический мост, не бизнес-фича». |
| «salaryBase (legacy)» | `apps/web/app/admin/employees/[id]/page.tsx:177` — техническая подпись поля в `AdminTechInfo`. | **Safe to relabel** или скрыть. Видно только при открытии «Технической информации» сотрудника; не критично. |
| «Лекало (снимок)» / «снимок» / «актуальное» (badges на `PatternPreviewCard`) | `apps/web/components/orders/pattern-preview-card.tsx:108-117`. | Активный, оставить. |

---

## 7. Legacy bridge — оставить

Эти куски выглядят «старыми», но **удалять нельзя**:

1. **Product / productId / Catalog**:
   - `apps/api/src/modules/catalog/catalog.controller.ts` (`GET /api/products`, `GET /api/sizes`).
   - `apps/web/lib/orders-api.ts:110 listProducts()`.
   - `OrderItem.productId` (Prisma), `Passport.productName`, payroll по `Product`.
   - `Product` ↔ `PatternItem.legacyProductId` (1:1, обеспечен `@unique`, см. миграцию `20260513100000_pattern_legacy_product_link`).
   - `OrdersService.ensureLegacyProductForPattern()` (`orders.service.ts:304`) создаёт «технический» Product при создании / смене лекала. Используется в `create()` и `update()` (`orders.service.ts:177, 853`).
   - Используется legacy-формами `/orders/new` и `/orders/[id]/edit`.

2. **Legacy-страницы заказов** (`apps/web/app/orders/*`):
   - `/orders` — legacy список (на него ведут header / mobile-nav / home tile / production-dashboard).
   - `/orders/[id]` — legacy карточка с управляющими действиями (Start/Complete/Cancel живут только здесь, `OrderActions` компонент `order-actions.tsx`).
   - `/orders/[id]/edit` — legacy редактирование (доступно при `status === 'DRAFT'`).
   - `/orders/new` — legacy форма создания (NB: CUTTER_ASSISTANT её не использует; см. §8.1).
   - `/orders/[id]/passports/new` — production-critical, единственная точка для CUTTER_ASSISTANT, ссылка из `/work/cut-orders/page.tsx`.
   - `/orders/[id]/order-actions.tsx`, `outsource-status-actions.tsx`, `not-found.tsx` — части той же страницы.
   - `/orders/actions.ts` — общий server-action файл (`createOrderAction`, `updateOrderAction`, `startOrderAction`, `cancelOrderAction`, `completeOrderAction`). На него опираются ОБЕ admin-формы.

3. **CUTTER_ASSISTANT flow** (`/work` → `/work/cut-orders` → `/orders/[id]/passports/new`).
   - `apps/web/app/work/page.tsx`, `apps/web/app/work/cut-orders/page.tsx` и связанные client-компоненты.
   - В коде эти файлы помечены комментариями «legacy cell-based flow / route-WIP», но это **рабочая prod-логика**.

4. **Passport flows** (`apps/web/app/passports/[id]/page.tsx`, `cutting-closure-section.tsx`, и `apps/api/src/modules/passports/`).
   - Имеют легаси-внешний вид (`AppSectionCard`, `meta-line`, `data-table`), но активны.

5. **Live UI styles, используемые паспортом — `.detail-header*` и `.pill*`**:
   - `.detail-header__back` (`globals.css` lines 1894–1946) — используется
     `apps/web/app/passports/[id]/page.tsx:128`.
   - `.pill`, `.pill--accent`, `.pill--ok`, `.pill--warn`, `.pill--ghost`
     (`globals.css` lines 452–467) — используются
     `apps/web/app/passports/[id]/page.tsx` в lines 160, 165, 251, 369, 375,
     379, 445.
   - **Used directly by `apps/web/app/passports/[id]/page.tsx`. Do not delete during safe cleanup.**
   - Хотя парные TSX-компоненты (`detail-page-header.tsx`, `status-pill.tsx`)
     удалены как мёртвые, эти CSS-классы — живые стили активной страницы
     паспорта.
   - **Optional future refactor:** namespace passport styles as `.passport-pill*`
     and `.passport-detail-header__back`, but this touches passport UI and is
     outside safe cleanup.

6. **Payroll / earnings / production-cost** — те же стили `page-shell`, `data-table`, бизнес-логика legacy. Активны, не трогать.

7. **Master / shopfloor terminals** (`/master`, `/shopfloor`, `/shopfloor/display`).
   - Свой собственный layout, не admin-shell. Активны.

8. **Re-exports в lib/** — нужны для tree-shaking / разделения server/client:
   - `apps/web/lib/passports-api.ts:73` re-export `PASSPORT_STATUS_LABELS` из `passport-status-labels.ts` — клиентские компоненты (`qc-work-card.tsx:24`, `wto-work-card.tsx:24`) импортируют напрямую из labels-файла, серверные — через старый путь.
   - `apps/web/lib/warehouses-api.ts:22` re-export `buildCellPrintUrl`, `buildCellQrImageUrl` из `warehouses-urls.ts` — тот же паттерн.
   - `apps/web/components/admin/admin-pagination.tsx:15` импортирует `PageSizeSelect` из `admin-pagination.client.tsx` — классический server/client split.

9. **Smoke-тесты, явно охраняющие legacy-файлы**:
   - `tests/smoke/admin-orders-create.smoke.test.ts §«legacy /orders/new — НЕ удалён»` (line 259).
   - `tests/smoke/admin-order-edit.smoke.test.ts §«legacy /orders/[id]/edit — НЕ удалён»` (line 167).
   - `tests/smoke/admin-legacy-cleanup.smoke.test.ts §«старая карточка /orders/[id]/page.tsx не удалена»` (line 118).

---

## 8. Needs decision

Спорные места — нужна команда / продуктовое решение, прежде чем что-то менять:

1. **`/orders/new` действительно «нужен для CUTTER_ASSISTANT»?**
   - Файл: `apps/web/app/orders/new/page.tsx:18-20`: `if (role !== 'ADMIN' && role !== 'SHOP_MANAGER') redirect('/orders');` — RBAC внутри страницы **редиректит CUTTER_ASSISTANT**. Помощник раскройщика этой формы не видит.
   - Smoke-тест `admin-orders-create.smoke.test.ts:259` в комментарии всё ещё пишет «нужен для CUTTER_ASSISTANT», но фактически это не так.
   - Что проверить вручную: есть ли внешний интегратор, который делает `POST /api/orders` напрямую (без UI), и нужно ли поддерживать «голый» legacy-form для них.
   - Если CUTTER_ASSISTANT там и правда не нужен → можно сделать redirect `/orders/new → /admin/orders/new` (Этап 3) и удалить дубль формы вообще.

2. **«Заказы» в шапке менеджера ведёт на legacy?**
   - `app/layout.tsx:94`: `{showOrders && <Link href="/orders">…Заказы…</Link>}` — для всех ролей с `canSeeOrdersMenu`.
   - `app/page.tsx:154`: на главной тайл «Заказы» ведёт сюда же.
   - `app/admin/production-dashboard/page.tsx:353`: тоже `/orders`.
   - Что проверить: продуктовое — должна ли «Заказы» в шапке менеджера вести на новый `/admin/orders` (с deadline-табами), а на legacy `/orders` оставить только ссылки из CUTTER_ASSISTANT-flow.

3. **`/orders/[id]/page.tsx::OrderActions` (Start/Complete/Cancel) — переносить в admin?**
   - Сейчас управляющие действия (запуск в производство, завершение, отмена) живут только на legacy-карточке (`order-actions.tsx`). Admin-карточка имеет ссылку «Открыть старую карточку» именно для этого (`admin/orders/[id]/page.tsx:182`).
   - Что проверить: продуктовое — допустимо ли разместить эти кнопки в admin-shell, или legacy-карточка останется навсегда. От этого зависит, можно ли в перспективе удалять `apps/web/app/orders/[id]/page.tsx`.

4. **`AdminProductionHeatmap` — удалять или возвращать?**
   - `apps/web/components/admin/admin-production-heatmap.tsx` + `apps/web/lib/admin-analytics.ts`. **0 импортов** в `apps/web/app`. Smoke `admin-final-cleanup.smoke.test.ts:57` явно требует, чтобы `/admin/page.tsx` его НЕ импортировал. Smoke `admin-analytics.smoke.test.ts:90,95` требует, чтобы он экспортировался барелл-индексом и сам файл существовал.
   - Что проверить: продуктовое — собираемся ли когда-нибудь возвращать heatmap на admin home (или production-dashboard)? Если нет — компонент + библиотечный helper можно перенести в Safe to delete (с соответствующей правкой smoke и `components/admin/index.ts`).

5. **Дублирующие smoke-тесты cleanup**:
   - `tests/smoke/admin-final-cleanup.smoke.test.ts`, `admin-legacy-cleanup.smoke.test.ts`, `admin-ui-polish.smoke.test.ts`, `admin-ui-consistency.smoke.test.ts` — все охраняют отсутствие `DetailPageHeader`/`<Icon name=…>`/`page-shell` в admin-страницах. Большое пересечение.
   - Что проверить: можно ли консолидировать в один файл (после релиза). Сейчас все отрабатывают, удаление любого временно ослабит сетку.

6. **`apps/web/app/admin/orders/[id]/edit/admin-edit-order-form.tsx` карточка «2. Сроки»** содержит summary-плашку «Статус срока / Без срока сдачи / Срок выбран» (line 421-423) — а у формы создания это уже badge «Срок не указан». Лёгкое расхождение в дизайн-языке.
   - Что проверить: UX — нужна ли карточка «2. Сроки» вообще, или dueDate можно убрать в карточку «1. Заказ» как в форме создания.

7. **`apps/web/app/admin/orders/page.tsx::OrdersTable` колонка `header: 'Изделие'`** vs `patternName`: после «Номенклатура = Лекала» показывается `o.productName` из DTO — но это уже подменённое имя «технического» legacy-Product, а не имя лекала. Если PatternItem.name отличается от Product.name (для исторических заказов до миграции) — в списке заказов будет старое имя.
   - Что проверить: на проде уже обкатано? есть ли заказы, у которых `Product.name !== PatternItem.name`? Если да — нужно поменять рендер на `o.patternName ?? o.productName` (новый DTO-поле уже есть в `OrderListItemDto`, см. `packages/shared/src/orders.ts`). **В этом recon ничего не меняем.**

8. **`apps/web/components/orders/pattern-preview-card.tsx`** имеет `variant: 'admin' | 'legacy'` и инлайн-стили внутри `body` — это сделано чтобы не тащить admin-CSS в legacy-страницу. Когда (или если) `/orders/[id]` исчезнет, можно упростить до single-variant. **Сейчас не трогать.**

9. **Smoke-тест `admin-orders-create.smoke.test.ts:173` `expect(src).not.toMatch(/listProducts/);`** — очень узкий regex, ловит подстроку. Если в админ-странице создания случайно появится `listProductsForX` — тест упадёт ложноположительно. Не блокер для cleanup, но стоит держать в голове.

---

## 9. Рекомендуемый план cleanup

### Этап 1 — безопасное удаление мёртвого UI

Без риска, ничего не используется:

1. Удалить `apps/web/components/detail-page-header.tsx` (`rg "DetailPageHeader" apps/` уже подтверждено: 0 импортов в `apps/`).
2. Удалить `apps/web/components/status-pill.tsx`.
3. Обновить `docs/screens.md`, `docs/ui-mobile.md`, `README.md` — убрать упоминания `DetailPageHeader` / `StatusPill` (опционально, не блокер).
4. (Опционально, см. §8.4): если решено не возвращать heatmap — удалить `apps/web/components/admin/admin-production-heatmap.tsx`, `apps/web/lib/admin-analytics.ts`, поправить barrel `components/admin/index.ts:16` и smoke `admin-analytics.smoke.test.ts`.

### Этап 2 — удаление старых CSS-классов

После Этапа 1 (или параллельно):

1. Удалить `.admin-order-card__secondary` + `.admin-order-card__secondary > .admin-field > label` (lines 8112–8129) — smoke явно охраняет, что класс не используется в формах.
2. Очистить header-комментарий блока «Admin Order Form 2.1» в CSS — упоминание «Учётного изделия» (lines 7984–7986) уже не отражает реальность.

**NB:** `.detail-header*` (lines 1894–1946) и `.pill*` (lines 452–467) **в safe cleanup НЕ удаляем** — они используются `apps/web/app/passports/[id]/page.tsx` (см. §7). Комментарий-перечень в `globals.css:1421` с упоминанием `pill` тоже остаётся.

После каждого пункта — прогнать smoke. Высокий шанс, что всё пройдёт.

### Этап 3 — redirect/deprecate legacy routes (требует продуктового решения)

Только после явного решения по §8.1, §8.2, §8.3:

1. Добавить серверный redirect `/orders/new → /admin/orders/new` (через `redirect()` в `app/orders/new/page.tsx`) — если §8.1 подтверждён.
2. Поменять `Link href="/orders"` в шапке/тайлах на `/admin/orders` для менеджерских ролей (если §8.2 подтверждён).
3. Только после того, как обе прошли, можно безопасно удалить `apps/web/app/orders/new/*` и обновить smoke.
4. Если §8.3 принят — перенос Start/Complete/Cancel в admin-карточку и удаление legacy `/orders/[id]/page.tsx` + `/orders/[id]/edit/*`.

### Этап 4 — позже: Product migration

После того, как:

- все исторические заказы переведены через `ensureLegacyProductForPattern()`;
- проведена контрольная миграция `Product.name → pattern.name` (если расходятся);
- payroll/паспорта переведены на чтение `patternName` напрямую (если решено);

Можно обсуждать удаление:

- `Product` модели, `OrderItem.productId`, `Passport.productName` (или замена на `patternName`).
- `apps/api/src/modules/catalog/catalog.controller.ts::products()`.
- `apps/web/lib/orders-api.ts::listProducts()` + `ProductDto`.
- legacy-форм `/orders/new`, `/orders/[id]/edit`.

**Этот этап явно за пределами cleanup recon — требует Prisma-миграции и backend-работы.**

---

## 10. Проверки после cleanup

После каждого этапа запускать (последовательность важна):

1. **TypeScript / lint**:

   ```bash
   npm run -w apps/web typecheck
   npm run -w apps/web lint
   npm run -w apps/api typecheck
   npm run -w apps/api lint
   npm run -w packages/shared typecheck
   ```

2. **Сборка фронта** (явно увидит мёртвые импорты):

   ```bash
   npm run -w apps/web build
   ```

3. **Smoke-тесты** (vitest без БД, source-level):

   ```bash
   npx vitest run -c tests/vitest.config.ts tests/smoke
   ```

   Особенно важны:
   - `admin-final-cleanup.smoke.test.ts`
   - `admin-legacy-cleanup.smoke.test.ts`
   - `admin-orders-create.smoke.test.ts`
   - `admin-order-edit.smoke.test.ts`
   - `admin-order-layout.smoke.test.ts`
   - `admin-ui-consistency.smoke.test.ts`
   - `admin-ui-polish.smoke.test.ts`
   - `admin-analytics.smoke.test.ts` (если трогали heatmap)
   - `frontend-rbac.smoke.test.ts`

4. **Unit-тесты**:

   ```bash
   npx vitest run -c tests/vitest.config.ts tests/unit
   ```

5. **Integration-тесты** (требуют поднятой PostgreSQL по `DATABASE_URL`):

   ```bash
   npx vitest run -c tests/vitest.config.ts tests/integration
   ```

   Особенно:
   - `orders-pattern-as-product.test.ts` — этап «Номенклатура = Лекала».
   - `orders-edit-admin.test.ts`, `orders-deadlines.test.ts`,
     `orders-client-due-date.test.ts`.

6. **Ручная проверка production-flow** (smoke-сценарии из `docs/screens.md` и `README.md`):

   - Менеджер: создать заказ через `/admin/orders/new`, отредактировать, запустить через legacy `/orders/[id]`, увидеть в KPI «Контроль сроков» на `/admin`.
   - CUTTER_ASSISTANT: `/work` → `/work/cut-orders` → `/orders/[id]/passports/new` → выпуск паспорта.
   - QC / WTO / PACKING: терминалы открываются, `RoleHeaderCard` рендерится.
   - `/shopfloor/display` рендерится отдельно от admin-shell.

7. **`grep`-чеклист на регрессы** (после Этапа 1–2):

   ```bash
   rg -n "DetailPageHeader|StatusPill|admin-order-card__secondary" apps/ packages/
   ```

   Должно быть пусто.

   **NB:** `.detail-header*` и `.pill*` (CSS) в чеклист **не включены** —
   эти классы остаются живыми (используются `apps/web/app/passports/[id]/page.tsx`,
   см. §7). Их присутствие в `globals.css` и в `passports/[id]/page.tsx` —
   ожидаемо, не регресс.

---

> **Итог.** Безопасно сразу убирать (Этап 1+2): два мёртвых компонента
> (`DetailPageHeader`, `StatusPill`) + CSS-класс
> `.admin-order-card__secondary` и связанные комментарии.
> **CSS-классы `.detail-header*` и `.pill*` в safe cleanup НЕ удаляются** —
> они используются `apps/web/app/passports/[id]/page.tsx` (см. §7);
> при желании выносить их в `.passport-*`-namespace — это уже отдельный
> рефакторинг паспорта, вне safe cleanup. Спорное —
> `AdminProductionHeatmap`/`admin-analytics` (см. §8.4). Всё остальное
> «старое» (Product, `/orders/*`, legacy-формы) — рабочий мост, удалять
> только после явного продуктового решения по §8.
