# Design cleanup recon: рабочие места сотрудников

> Чисто фронтовая разведка/план миграции UI. Бизнес-логику паспортов,
> зарплаты, склада, материалов и Prisma schema **не меняем**.
> Источники истины по UX:
> [`docs/screens.md`](./screens.md) (карта экранов) и
> [`docs/ui-mobile.md`](./ui-mobile.md) (Шаг 13 / mobile clean redesign +
> visual layer v2).
<<<<<<< HEAD
>
> **Связано:** auth-зона (login + первый экран после login) переехала
> на новый дизайн отдельной задачей — см.
> [`docs/auth-design-cleanup-recon.md`](./auth-design-cleanup-recon.md).
=======
>>>>>>> 88554a2aa2955493b346a1883607fb420def843e

---

## 1. Что считается «новым дизайном»

Новый дизайн — это уже выполненный в проекте слой:

- **Шаг 13 / Mobile clean redesign** (см. [`docs/ui-mobile.md`](./ui-mobile.md)).
- **UI Refresh / visual layer v2** поверх Шага 13 (см. шапку
  [`docs/screens.md`](./screens.md)).

Технически — это CSS-class based design system в одном файле
`apps/web/app/globals.css` (~13.4k строк) на дизайн-токенах
(`--color-*`, `--radius-*`, `--shadow-*`, `--tap-min` и т.д.). Никакого
Tailwind/shadcn-ui в проекте нет, и заводить их не планируется —
ломает паттерны и ассеты пилота.

Канонические «строительные блоки» нового UI:

| Слой | Класс / компонент | Источник |
|------|-------------------|----------|
| Шапка-профиль | `<RoleHeaderCard>` (имя + роль + поля смены + статус) | `apps/web/components/role-header-card.tsx` |
| Карточка-секция | `<AppSectionCard>` | `apps/web/components/app-section-card.tsx` |
| Action-карточка | `<MobileActionCard>` (icon + title + hint + variant) | `apps/web/components/mobile-action-card.tsx` |
| Pill-бейдж | `<StatusBadge>` (по `OrderStatus`), `.status-badge` | `apps/web/components/status-badge.tsx`, `globals.css` |
| Скан-блок | `.scan-card` / `.scan-card--simple` | `globals.css`, шаблон используется в `/work`, `/qc`, `/wto`, `/packing` |
| Результат / ошибка | `.result-card`, `.error-box`, `.info-box`, `.qc-card` | `globals.css` |
| Кнопки | `.btn`, `.btn-primary`, `.btn-success`, `.btn-danger`, `.btn-lg`, `.btn-block` | `globals.css` |
| Меню действий | `<SeamstressActionsMenu>` (три-точечное меню в углу) | `apps/web/app/work/seamstress-actions-menu.tsx` |
| Камера для QR | `<QrScannerModal>` | `apps/web/app/work/qr-scanner-modal.tsx` |
| Скан-старт смены | `<SeamstressShiftStart>` | `apps/web/app/work/seamstress-shift-start.tsx` |
| Текущий крой | `<CurrentWorkCard>` | `apps/web/app/work/current-work-card.tsx` |
| QR-сотрудника | `<EmployeeQrButton variant="floating" \| "inline" />` | `apps/web/components/employees/employee-qr-button.tsx` |
| Иконография | `<Icon name=... />` (inline-SVG) | `apps/web/components/icon.tsx` |

Дизайн-токены — переменные `:root` в `globals.css` (см.
[`docs/ui-mobile.md`](./ui-mobile.md)). Использовать только их,
hardcoded hex запрещён правилами стиля.

---

## 2. Карта рабочих экранов сотрудников

| Роль                | Primary route        | Файл page.tsx                                  | Состояние |
|---------------------|----------------------|------------------------------------------------|-----------|
| SEAMSTRESS          | `/work`              | `apps/web/app/work/page.tsx`                   | **Новый дизайн** (`<RoleHeaderCard>` + `SeamstressActivePanel` / `SeamstressShiftStart`, scan-driven flow) |
| CUTTER_ASSISTANT    | `/work`              | `apps/web/app/work/page.tsx` → `CutterAssistantWorkPanel` | **Новый дизайн** (две action-card + shelf-placement session) |
| CUTTER              | `/work`              | `apps/web/app/work/page.tsx` → `ActiveShiftPanel` → `DefaultActivePanel` | **Новый дизайн** (`RoleHeaderCard` + pill-tabs `.work-tabs` из Шага 13 + `.scan-card` + `.result-card` + danger-кнопка «Завершить смену» по `docs/ui-mobile.md §4.2`). Отличается от seamstress-flow по дизайну: швея получает однокнопочный mobile-flow, CUTTER/менеджер — две формы под табами. |
| QC                  | `/qc`                | `apps/web/app/qc/page.tsx` → `QcTerminal`       | **Новый дизайн** (start-shift gate + scan-card + `<QcWorkCard>`) |
| IRONING             | `/wto`               | `apps/web/app/wto/page.tsx` → `WtoTerminal`     | **Новый дизайн** (полный аналог QC) |
| PACKING             | `/packing`           | `apps/web/app/packing/page.tsx` → `PackingTerminal` | **Новый дизайн** (scan-card + box-card в стиле `qc-card`) |
| SHOPFLOOR_MASTER    | `/master`            | `apps/web/app/master/page.tsx` → `MasterPageClient` | **Новый дизайн** (`master-page` + `master-call-card`, fullscreen без header) |
| DISPLAY             | `/shopfloor/display` | `apps/web/app/shopfloor/display/page.tsx`       | **Read-only витрина** (своя визуальная модель, см. §6) |

Дополнительные employee-only роуты:

- `apps/web/app/work/cut-orders/page.tsx` — упрощённый выбор заказа
  для CUTTER_ASSISTANT (`.cut-orders__*`). **Новый дизайн.**
- `apps/web/app/passports/[id]/page.tsx` — карточка паспорта (mobile
  hero + `<AppSectionCard>`). **Новый дизайн.**
- `apps/web/app/orders/[id]/passports/new/*` — выпуск паспорта для
  CUTTER_ASSISTANT (под тем же `app-header`-скрытием). **Новый дизайн.**

---

## 3. Что уже на новом дизайне (зафиксировать)

1. **SEAMSTRESS** (`/work`) — `RoleHeaderCard` + `SeamstressActivePanel`
   + `SeamstressShiftStart` + `CurrentWorkCard`. Один primary `btn-lg`,
   один secondary, опц. ручной ввод. Звук + хаптика на success-ветках
   (`feedback.ts`). Logout/«Завершить смену» — в `SeamstressActionsMenu`.
2. **CUTTER_ASSISTANT** (`/work`) — `CutterAssistantWorkPanel`: две
   action-card одного уровня («Выпустить паспорт» / «Разместить на
   стеллаж»), shelf-placement в session-режиме (`ShelfPlacementPanel`).
3. **QC** (`/qc`) — `QcTerminal` с тремя ветками
   (`SeamstressShiftStart` → `WrongOperationCard` → `QcScanTerminal`),
   `qc-card` для активного паспорта, `qc-completed-row` для свернутого.
4. **IRONING/WTO** (`/wto`) — `WtoTerminal`, полный визуальный аналог QC,
   без блока «фиксация брака».
5. **PACKING** (`/packing`) — `PackingTerminal`: SHOP_MANAGER/ADMIN
   видят управленческий список, PACKING сразу попадает в scan-driven
   терминал (создание коробки → сканирование паспортов → закрытие).
6. **SHOPFLOOR_MASTER** (`/master`) — `MasterPageClient`: лента
   `master-call-card`, polling 5 сек, scan QR сотрудника для resolve,
   bottom-sheet ручных действий, политика выдачи кроя
   (`CutReleasePolicyCard`). Header/MobileNav скрыты — fullscreen
   терминал.
7. **Кнопка «Мой QR-код»** уже подключена через
   `canSeeEmployeeQrButton`:
   - в `app/layout.tsx` (root header) — `inline` для всех ролей из
     матрицы;
   - в section layouts `/work`, `/qc`, `/wto`, `/packing` — `floating`
     рядом с `CallMasterButton`;
   - в `app/master/page.tsx` — `floating` для мастера.

---

## 4. Что осталось от старого дизайна

Все находки относятся к employee-flow. Управленческие/admin-вью с
`.data-table`, `.toolbar`, `.page-header` (например
`/packing/page.tsx` для SHOP_MANAGER, `/admin/*`, `/orders/*`,
`/shopfloor/page.tsx` для менеджера) **сознательно оставлены** — они не
часть рабочих мест сотрудников и трогать их в этой задаче нельзя
(см. constraints ТЗ).

| # | Где                                                 | Что                                                                     | Кому видно                |
|---|-----------------------------------------------------|--------------------------------------------------------------------------|---------------------------|
| 1 | `apps/web/app/work/active-shift-panel.tsx` (`DefaultActivePanel` / `ScanForm`) | Inline `style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}` и `style={{ color: 'var(--color-fg-muted)', fontWeight: 500 }}` — для CUTTER и manager fallback | CUTTER + manager fallback |
| 2 | `seamstress-shift-start.tsx` / `shift-start-form.tsx` | Мелкие inline `style={{ marginBottom: 0 }}` и `style={{ color: 'var(--color-fg)' }}` для тонкой типографики | SEAMSTRESS / CUTTER (старт смены) |
| 3 | `qc-terminal.tsx`, `wto-terminal.tsx`               | `<span style={{ marginLeft: '0.45rem' }}>` после иконки                  | QC / IRONING (косметика)  |
| 4 | `packing-terminal.tsx`                              | `<span style={{ marginLeft: '0.5rem' }}>` для бейджа «✓ только что»      | PACKING                   |

> **Уточнение:** `.work-tabs` в `DefaultActivePanel` — это `pill-style`
> tabs из Шага 13 (см. [`docs/ui-mobile.md`](./ui-mobile.md)), новый
> дизайн. SEAMSTRESS не использует их по UX-решению («mobile-first
> однокнопочный flow», см. там же), но для CUTTER/менеджера два таба
> остаются осмысленными — это два разных ходовых сценария на одной
> смене (`POST /api/passports/:id/issue` vs `POST /api/passports/:id/scan`).

Никаких legacy CSS-modules / отдельных `.module.css` файлов в проекте
нет (есть только `globals.css`). Старых компонентов вне employee-flow,
которые можно безопасно удалить, не задевая admin/orders/warehouses,
обнаружено **не было** (см. §7 — только консолидация).

---

## 5. Какие новые компоненты уже есть

См. таблицу в §1. Дополнительно:

- `<MobileNav>` (нижняя нав-панель ≤ 900 px) — `apps/web/components/mobile-nav.tsx`.
- `<LogoutButton>` — `apps/web/components/logout-button.tsx`.
- `<CallMasterButton>` (плавающая кнопка вызова мастера) —
  `apps/web/components/call-master-button.tsx`.
- `<ChunkErrorGuard>` — `apps/web/components/chunk-error-guard.tsx`
  (RSC chunk-load fallback).
- В `apps/web/components/icon.tsx` — единый набор inline-SVG.

«Контейнер» рабочего места = `<div className="seamstress-work">`. Это
де-факто ShopfloorShell проекта (max-width, padding, safe-area, gap).
Все 4 терминала (`/work`, `/qc`, `/wto`, `/packing`) уже используют
этот контейнер.

> **Важно:** компоненты, перечисленные в ТЗ
> (`shopfloor-shell`, `shopfloor-header`, `shopfloor-nav`,
> `worker-status-card`, `passport-task-card`, `operation-action-panel`,
> `scan-panel`, `production-empty-state`, `production-error-state`,
> `production-loading-state`, `production-status-badge`),
> **уже реализованы — но под другими именами**:
>
> - `shopfloor-shell` → `<div className="seamstress-work">` (CSS-shell);
> - `shopfloor-header` → `<RoleHeaderCard>` + `<SeamstressActionsMenu>`;
> - `shopfloor-nav` → `<MobileNav>` (для multi-workspace ролей; у
>   single-workspace ролей nav скрыт по дизайну);
> - `shopfloor-page-title` → `.role-header__name` внутри `RoleHeaderCard`;
> - `worker-status-card` → `RoleHeaderCard` (роль + смена + статус);
> - `passport-task-card` → `<QcWorkCard>` / `<WtoWorkCard>` /
>   `<CurrentWorkCard>` (одна семья `qc-card` + `current-work` стилей);
> - `operation-action-panel` → нижний блок `.qc-card__actions`;
> - `scan-panel` → `.scan-card.scan-card--simple` + `<QrScannerModal>`;
> - `production-empty-state` → `.card.empty` / `.cut-orders__empty` /
>   `.current-work--empty`;
> - `production-error-state` → `.error-box`;
> - `production-loading-state` → label кнопки `«Загрузка…»` /
>   `«Сохраняем…»` (на терминалах нет «full-screen spinner» по дизайну —
>   pending-state живёт прямо на кнопке);
> - `production-status-badge` → `.status-badge` + `<StatusBadge>` для
>   `OrderStatus`.
>
> **Дублировать их под новыми именами не будем** — это против явной
> инструкции ТЗ «если уже есть аналогичные компоненты, не дублируйте,
> а приводите к единому API». Чтобы дать новым экранам один очевидный
> entry-point, заведём re-export wrappers в
> `apps/web/components/shopfloor/` (см. §7).

---

## 6. DISPLAY (`/shopfloor/display`) — отдельная история

`DISPLAY` — это учётка под большой монитор в зале:

- единственная доступная страница — `/shopfloor/display` (см.
  `DISPLAY_ALLOWED_PATH` в `apps/web/lib/rbac.ts`);
- middleware (`apps/web/middleware.ts`) редиректит роль с любого
  другого пути обратно;
- header и `MobileNav` скрыты у любой роли на этом пути
  (`hideForDisplay` в `app-header.tsx`);
- интерактива нет — только KPI-цифры + матрица «цвет × размер × stage»
  + статусы оборудования (`apps/web/app/shopfloor/display/display-board.tsx`);
- авто-обновление каждые 7 сек (см. [`docs/display-board.md`](./display-board.md)).

DISPLAY использует свою CSS-семью (`.display-screen`,
`.display-screen__matrix`, `.display-status-tile` и т.д.) — она
отдельная от рабочих терминалов по дизайну (TV-friendly типографика,
без mobile-touch правил). Менять её в этой задаче нельзя — это сломает
действующую трансляцию у пилота. **Документируем и оставляем**.

---

## 7. План миграции (по этапам)

Все этапы малые, инкрементальные, не затрагивают backend и Prisma.
Каждый этап — отдельный коммит.

### Этап 1 — Унификация UI foundation (без визуальных изменений)

Цель: дать новым/будущим экранам один импорт-точку, не плодя дубли.

- `apps/web/components/shopfloor/index.ts` — re-export канонических
  компонентов под названиями из ТЗ:
  - `ShopfloorPageTitle` → `RoleHeaderCard`,
  - `WorkerStatusCard` → `RoleHeaderCard`,
  - `ProductionStatusBadge` → `StatusBadge`,
  - `ScanPanel` → лёгкий wrapper `.scan-card scan-card--simple`,
  - `ProductionEmptyState` / `ProductionErrorState` /
    `ProductionLoadingState` — лёгкие функциональные компоненты на
    канонических CSS-классах (`.card.empty` / `.error-box` / inline
    «Загрузка…»).
- `<ShopfloorShell>` — функциональный wrapper над
  `<div className="seamstress-work">`, принимающий `header` +
  `actionsMenu` props и применяющий safe-area + max-width.
- Никаких новых стилей в `globals.css` — только использование
  существующих токенов.

### Этап 2 — Финальная чистка SEAMSTRESS / CUTTER_ASSISTANT (косметика)

- Заменить inline `style={{}}` на utility-классы или модификаторы.
- Убрать `style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}`
  у formов на `/work` — заменить на класс `.work-active`, который
  уже есть.

### Этап 3 — CUTTER (косметика, без структурных изменений)

`DefaultActivePanel` уже на новом дизайне (`.work-tabs` — pill-tabs
Шага 13). Делаем только косметику:

- убрать inline `style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}`,
  заменить на класс `.work-active` (он уже есть в `globals.css`);
- убрать inline `style={{ display: 'flex', justifyContent: 'flex-end' }}`
  у нижней формы «Завершить смену» — заменить на класс
  `.work-active__shift-end` (тонкая обёртка, добавить в `globals.css`).

### Этап 4 — DISPLAY (только документация)

- Зафиксировать в `docs/screens.md` секции, что DISPLAY использует
  свою CSS-семью и сознательно не подключён к employee-design-system.
- В `globals.css` ничего не трогаем.

### Этап 5 — Удаление legacy (только то, что точно не используется)

После §3 не остаётся неиспользуемых TSX-компонентов в employee-flow.
Удалять CSS-правила из `globals.css` опасно (на пилоте уже работают
admin/orders/warehouses-страницы), поэтому **CSS не трогаем**, только
TSX. Ожидаемое удаление: **0 файлов** — весь legacy-TSX в
employee-flow переиспользуется.

### Этап 6 — Smoke-тесты и docs

- Smoke-тест, что `apps/web/components/shopfloor/index.ts` ре-экспортит
  все ожидаемые имена и что они привязаны к канонической реализации
  (`RoleHeaderCard`, `StatusBadge`, `MobileActionCard` и т.д.).
- Обновить [`docs/screens.md`](./screens.md) (про unified shopfloor
  namespace) и [`docs/ui-mobile.md`](./ui-mobile.md) (тот же раздел).
- Этот документ (`docs/design-cleanup-recon.md`).

### Этап 7 — Verification

- `npm run typecheck` — должен пройти.
- `npm run build` — должен пройти.
- `npm run docs:check` — должен пройти.
- `npm run test:smoke --workspace=tests` — должен пройти, плюс новые
  тесты должны быть зелёные.

---

## 8. Риски и инварианты, которые нельзя ломать

1. **Бизнес-логика паспортов / OperationEntry / списания материалов**
   — backend источник истины, frontend трогаем только классами/
   разметкой. Server actions (`acceptPassportForIssueAction`,
   `completePassportOperationAction`, `recordDefectAction`,
   `completeQcAction`, `completeWtoAction`, `scanPassportToBoxAction`,
   `closeBoxTerminalAction`) не меняем.
2. **Smoke tests:**
   `tests/smoke/qc-start-shift`, `wto-start-shift`,
   `seamstress-feedback`, `master-layout`, `master-actions`,
   `master-calls`, `qc-collapsed-row`, `employee-qr-button`,
   `frontend-rbac` — все привязаны к именам файлов/символов и
   текстам. **Не переименовывать** `seamstress-active-panel.tsx`,
   `seamstress-shift-start.tsx`, `seamstress-actions-menu.tsx`,
   `qc-terminal.tsx`, `wto-terminal.tsx`, `packing-terminal.tsx`,
   `master-page-client.tsx`, `employee-qr-button.tsx`.
3. **Routing:** URL `/work`, `/qc`, `/wto`, `/packing`, `/master`,
   `/shopfloor/display`, `/work/cut-orders` — не меняем; перенос/
   redirect не нужен (новых маршрутов не вводим).
4. **AppHeader / hide rules:** скрытие шапки на `/work*`, `/qc`, `/wto`,
   `/packing`, `/master`, `/orders/:id/passports/new`,
   `/shopfloor/display` — критично для fullscreen-эффекта на пилоте.
   Не трогаем.
5. **DISPLAY:** учётка под монитор работает в зале клиента — любой
   визуальный регресс остановит трансляцию. **Только документация.**
6. **CSS-токены** в `:root` (`globals.css`) — у admin/orders/warehouses
   на них завязаны цвета и радиусы. Удалять токены/алиасы запрещено.
7. **Кнопка «Мой QR-код»:** вынесена через `canSeeEmployeeQrButton`,
   тестами зафиксированы layout-импорты во все 5 секций. Не убираем
   её ни из одного из layout-ов.
8. **Single-workspace ролям** (`SEAMSTRESS`, `CUTTER_ASSISTANT`, `QC`,
   `IRONING`, `PACKING`, `DISPLAY`, `SHOPFLOOR_MASTER`) `MobileNav`
   не рендерится — это инвариант UI-модели «одно рабочее окно» (см.
   `docs/screens.md`). Не возвращаем им навигацию.

---

## 9. Чек-лист готовности

- [ ] `apps/web/components/shopfloor/` — re-export канонических
      компонентов (без дублирования логики).
- [ ] `DefaultActivePanel` (CUTTER) — без inline `style={{}}` (визуальная семантика остаётся прежней; `.work-tabs` — это pill-tabs Шага 13).
- [ ] Inline `style={{}}` на employee-страницах сведены к минимуму /
      заменены на классы.
- [ ] Smoke: `shopfloor-namespace.smoke.test.ts` зелёный (re-export контракт).
- [ ] `docs/screens.md` обновлён (CUTTER, ShopfloorShell namespace).
- [ ] `docs/ui-mobile.md` обновлён (про unified shopfloor namespace).
- [ ] `npm run typecheck` зелёный.
- [ ] `npm run build` зелёный.
- [ ] `npm run docs:check` зелёный (включая link-checker).
- [ ] `npm run test:smoke --workspace=tests` зелёный.
