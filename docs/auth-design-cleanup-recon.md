# Auth Design Cleanup RECON

> Дата RECON: 2026-05-04. Связано с задачей «вычистить старый дизайн в
> зоне авторизации и убрать старый промежуточный экран после входа».

## 1. Scope

Эта задача касается **только**:

1. **Экрана авторизации** — `apps/web/app/login/page.tsx` +
   `apps/web/app/login/login-form.tsx`. Сейчас собран на legacy CSS-
   классах (`.auth-page`, `.auth-card`, `.auth-form*`), не использует
   ни UI-токены rolEHeaderCard/AppSection стиля, ни shopfloor-namespace.
2. **Первого экрана после авторизации** — `apps/web/app/page.tsx`.
   Сейчас это **полноценный legacy-dashboard** с тайлами
   (`MobileActionCard`, `brand-mark`, inline `style={{ marginTop: 0, ... }}`),
   который видят только ADMIN и SHOP_MANAGER (производственные роли уже
   редиректятся в свой primary workspace). Это и есть «старый
   промежуточный экран», от которого хотим уйти.
3. **Role-based редиректа** — единый helper, к которому опирается и
   `/`, и login action, и login page. Сегодня логика дважды
   продублирована (см. §3) и для ADMIN/SHOP_MANAGER «фигурирует» как
   «остаёмся на `/`», что и держит legacy-dashboard на месте.

Вне scope:

- бизнес-логика паспортов, операций, склада, материалов, QR;
- backend auth (`apps/api/src/modules/auth`), сессии, HMAC, Prisma
  schema;
- production flows `/work`, `/qc`, `/wto`, `/packing`, `/master`;
- DISPLAY (`/shopfloor/display`);
- редизайн admin UI;
- шапка/sidebar в зоне `/admin/*` (Admin UI 2.6 уже на новом дизайне).

## 2. Auth routes inventory

| Route | File | Current design | Problem | Action |
|---|---|---|---|---|
| `/login` (GET) | `apps/web/app/login/page.tsx` | old (`.auth-page` / `.auth-card` legacy CSS) | Старый legacy layout с brand-mark и текстом «Demo-аккаунты после `npm run db:seed` используют пароль `Demo12345!`», ссылка «← На главную». Нет new shopfloor-style визуальной системы. | Перенести на новый AuthShell + AuthCard + LoginForm; убрать пилотные подсказки про demo-пароли (это утечка контекста на pilot). |
| `/login` (server action `loginAction`) | `apps/web/app/login/actions.ts` | old | `safeNext` дублируется в `login/page.tsx`; redirect использует `getPrimaryWorkspace` напрямую — для ADMIN/SHOP_MANAGER это `/`, что и приводит к показу старого dashboard. | Использовать новый `safeReturnTo` + `getDefaultRouteForRole`; не менять fetch / cookie / HMAC. |
| `/(auth)/logout-action.ts` (server action) | `apps/web/app/(auth)/logout-action.ts` | new (server action только) | Возвращает `redirect('/login')` — корректно. | **Не трогаем.** Логика выхода стабильна. |
| `/auth/*` | — | — | Публичных URL `/auth/*` в Next-зоне нет (route-группа `(auth)` не создаёт URL). | Не нужно. |
| `/signin` | — | — | Не существует. | Не нужно. |

Backend auth-эндпоинты (`POST /api/auth/login`, `GET /api/auth/me`,
`POST /api/auth/logout`) находятся в NestJS и **в scope этой задачи
не входят** — клиентские обёртки `apps/web/lib/auth-api.ts` тоже
остаются как есть.

## 3. Post-login routes inventory

| Route | File | Current behavior | Problem | Target behavior |
|---|---|---|---|---|
| `/` (root) | `apps/web/app/page.tsx` | Если `!me` — рендерится legacy «карточка приветствия» (`.card`, `.brand-mark`, `.actions-row`) с кнопкой «Войти». Если `me && isWorkingRole(role)` — `redirect(getPrimaryWorkspace(role))`. Если `me && (ADMIN \| SHOP_MANAGER)` — рендерится legacy dashboard с тайлами `MobileActionCard` (это и есть «старый промежуточный экран»). | Старый UI на трёх ветках: anon-card, manager-tile-grid, working-role-redirect. Production-роли уже редиректятся, но менеджеры/админы видят legacy. Открытый XSS/redirect surface здесь нет, но visual-mismatch с новым дизайном /admin. | Одна ветка: `if (!me) redirect('/login')` иначе `redirect(getDefaultRouteForRole(me.user.role))`. Никакого UI. |
| `/dashboard` | — | — | Не существует. | Создавать не нужно. |
| `/home` | — | — | Не существует. | Не нужно. |
| `/admin` | `apps/web/app/admin/page.tsx` | Уже на новом дизайне (lucide-react, `.admin-page-shell`, `.admin-home-card`). KPI Контроль сроков + сетка карточек разделов. | Это и есть target для ADMIN/SHOP_MANAGER. | Используем как канонический admin entrypoint в `getDefaultRouteForRole`. |
| `/admin/production-dashboard` | `apps/web/app/admin/production-dashboard/page.tsx` | Новый | Существует, но это **не** канонический landing. | Не использовать в auth-redirect. |
| `/work`, `/qc`, `/wto`, `/packing`, `/master`, `/shopfloor/display` | (см. layout/page) | Все на новом дизайне (RoleHeaderCard / shopfloor-shell). | Сейчас редирект через `getPrimaryWorkspace` корректен. | Сохранить редирект через единый `getDefaultRouteForRole`. |

Дополнительно: `apps/web/middleware.ts` уже редиректит DISPLAY и
SHOPFLOOR_MASTER в их единственный path, **до** того как страница
`/` или login отработают. Это safety-net, и его не трогаем.

## 4. Role redirect map

| Role | Target route | Источник истины |
|---|---|---|
| ADMIN | `/admin` | новая admin home (`apps/web/app/admin/page.tsx`) |
| SHOP_MANAGER | `/admin` | то же |
| SHOPFLOOR_MASTER | `/master` | `SHOPFLOOR_MASTER_ALLOWED_PATH` |
| CUTTER | `/work` | `getPrimaryWorkspace('CUTTER')` |
| CUTTER_ASSISTANT | `/work` | `getPrimaryWorkspace('CUTTER_ASSISTANT')` |
| SEAMSTRESS | `/work` | `getPrimaryWorkspace('SEAMSTRESS')` |
| QC | `/qc` | `getPrimaryWorkspace('QC')` |
| IRONING | `/wto` | `getPrimaryWorkspace('IRONING')` |
| PACKING | `/packing` | `getPrimaryWorkspace('PACKING')` |
| DISPLAY | `/shopfloor/display` | `DISPLAY_ALLOWED_PATH` |
| (нет роли / unknown) | `/login` | fallback для anon |

`getDefaultRouteForRole(role)` отличается от `getPrimaryWorkspace(role)`
**только для ADMIN и SHOP_MANAGER**: первый возвращает `/admin`, второй
исторически возвращает `/` (для админа `/` — это «многосекционная
домашняя страница»). После cleanup-а домашней страницы как UI больше
нет, поэтому мы не трогаем `getPrimaryWorkspace` (его инварианты
проверяет `frontend-rbac.smoke`), а заводим отдельный helper для
auth-redirect.

## 5. Legacy auth UI inventory

| File | Legacy sign | Used by | Replace with | Safe to delete now |
|---|---|---|---|---|
| `apps/web/app/login/page.tsx` | `.auth-page`, `.auth-card`, `.auth-card__brand-mark`, inline `<code>Demo12345!</code>` | route `/login` | новый `AuthShell` + `AuthCard` (Sewing-стиль, без legacy CSS) | да — после переезда |
| `apps/web/app/login/login-form.tsx` | `.auth-form`, `.auth-form__field`, `.auth-form__submit` | login page | новый `LoginForm` на тех же UI-токенах, что admin / shopfloor | да — после переезда |
| `apps/web/app/page.tsx` (legacy dashboard для ADMIN/SHOP_MANAGER) | `.card`, `.brand-mark`, `.actions-row`, `.page-shell`, `.page-eyebrow`, `.page-title`, `.page-subtitle`, `.section-header`, `.action-grid`, `MobileActionCard` | route `/` | редирект на `getDefaultRouteForRole(role)` | анон-карточка и tile-сетка — да; сам файл остаётся как pure redirect server-component |
| `apps/web/app/globals.css` `.auth-page` / `.auth-card*` / `.auth-form*` блоки | старые legacy-классы | только legacy login | новые scoped классы `auth-screen` (см. §7) | да — после переезда login UI |
| `MobileActionCard` (`apps/web/components/mobile-action-card.tsx`) | используется только в `/page.tsx` для tile-сетки | (см. grep) | — | **проверить: используется только в `/page.tsx`?** Если нигде кроме — удалить вместе со старой сеткой. Если ещё где-то — оставить и просто перестать использовать в `/`. |
| `Icon name="login"` / `Icon name="sewing"` в `app/page.tsx` | сами по себе не legacy, но входят в анон-карточку, которой больше не будет | — | — | trim usages, но `Icon` остаётся — он используется в шапке/нав. |

**Правило:** на этапе RECON ничего **не удаляем**. Реальное удаление —
только после переезда (см. §7, шаг 7).

## 6. Risks

- **Сломать login flow.** `loginAction` идёт через `loginAndPersistSession`
  и форвардит `Set-Cookie`. Любая правка должна сохранить порядок:
  fetch → парсинг payload → `cookies().set(...)` → `redirect(...)`.
- **Сломать session-cookie.** Не трогаем `SESSION_COOKIE_NAME`,
  `httpOnly`, `sameSite`, `secure`, `maxAge`. Не трогаем
  `apps/web/middleware.ts` (он читает cookie payload без подписи —
  Edge runtime, `atob`).
- **Redirect loop.** Если post-login редиректит на `/`, а `/` редиректит
  на `getDefaultRouteForRole`, который **тоже** возвращает `/`, цикл.
  Защита: `getDefaultRouteForRole` никогда не возвращает `/` — для
  ADMIN/SHOP_MANAGER возвращает `/admin`, для рабочих ролей —
  `getPrimaryWorkspace`, для unknown/null — `/login` (а не `/`).
- **Open redirect через `next` / `returnTo`.** Сейчас `safeNext` в
  `login/page.tsx` отбрасывает `//evil.com` и absolute URLs, но
  расположен только на server-component и не покрывает действие
  `loginAction` симметрично. Новый `safeReturnTo` должен:
  - принимать только `/path` (`startsWith('/')` && `!startsWith('//')`);
  - отбрасывать `/login` (иначе после успешного login уходим обратно
    на login и зацикливаемся);
  - на любой невалидный input возвращать `getDefaultRouteForRole(role)`.
- **Не та роль на не тот экран.** ADMIN на `/work` не должен
  «застревать» — мы редиректим только из `/`/`/login`, а не из любых
  других маршрутов.
- **Сломать DISPLAY.** Middleware форсит `/shopfloor/display` для
  DISPLAY-роли независимо от `/`-страницы. Поэтому даже если cleanup
  `/page.tsx` выполнится не идеально, DISPLAY-сценарий защищён
  middleware'ом. Не трогаем `DISPLAY_ALLOWED_PATH`.
- **Случайно показать старый dashboard после login.** Решается
  превращением `/page.tsx` в pure redirect server-component (никакого
  JSX-fallback, никаких client-state).
- **Сломать существующие smoke-тесты.** В
  `tests/smoke/frontend-rbac.smoke.test.ts` есть три блока, привязанных
  к старому поведению `/`:
  1. `homepage tile visibility` — ассертит наличие `MobileActionCard`/
     `*Menu` хелперов в `/page.tsx`. **Удалить блок.** После cleanup-а
     там нет UI.
  2. `login redirect uses primary workspace` — ассертит, что в
     `login/actions.ts` вызывается `getPrimaryWorkspace`. **Заменить
     на `getDefaultRouteForRole`.**
  3. `root / redirects working roles into their workspace` — заменить
     на «`/page.tsx` редиректит **всех** залогиненных в
     `getDefaultRouteForRole(role)`».

## 7. Recommended implementation plan

1. **Helper `getDefaultRouteForRole`** — `apps/web/lib/role-redirect.ts`.
   Делегирует `getPrimaryWorkspace` для рабочих ролей; для ADMIN /
   SHOP_MANAGER возвращает `/admin`; для unknown/null — `/login`.
   Не трогает существующий `getPrimaryWorkspace`.
2. **Helper `safeReturnTo`** — `apps/web/lib/safe-return-to.ts`.
   Принимает `(returnTo, role)` и возвращает гарантированно безопасный
   относительный путь либо `getDefaultRouteForRole(role)`. Запрещает
   absolute URLs, protocol-relative `//evil.com`, и `/login` после
   успешного login.
3. **Login UI** — `apps/web/components/auth/`:
   - `auth-shell.tsx` — контейнер на всю высоту, центрирование,
     mobile-first, новые токены;
   - `auth-card.tsx` — «карточка» с заголовком и подзаголовком из ТЗ
     («Вход в SEWING» / «Система управления швейным производством»);
   - `login-form.tsx` — переехавшая форма (server action не меняется);
   - `auth-loading-state.tsx` / `auth-error-state.tsx` — компактные
     fallback-блоки.
   - Стили — отдельная секция в `globals.css` (`.auth-screen*`).
   - Старые `.auth-page` / `.auth-card*` / `.auth-form*` правила —
     удалить после переезда.
4. **`/login`** — `apps/web/app/login/page.tsx`:
   - переписать на `<AuthShell><AuthCard><LoginForm/></AuthCard></AuthShell>`;
   - убрать ссылку «← На главную» (старый `/` пропадёт);
   - убрать упоминание «Demo12345!» (pilot-leak);
   - использовать `safeReturnTo`, redirect через `getDefaultRouteForRole`.
5. **`/login/actions.ts`** — заменить `resolveLoginRedirect` на пару
   `safeReturnTo` + `getDefaultRouteForRole`.
6. **`/`** — `apps/web/app/page.tsx`:
   - удалить anon-карточку и tile-сетку;
   - превратить в pure server-component:
     `if (!me) redirect('/login'); redirect(getDefaultRouteForRole(role));`.
7. **Legacy cleanup**:
   - удалить `.auth-page` / `.auth-card*` / `.auth-form*` блоки в
     `globals.css`;
   - удалить из `app/page.tsx` impors `Icon`, `MobileActionCard`,
     `canSee*Menu`, `getPrimaryWorkspace`, `isWorkingRole`,
     `ROLE_LABELS`;
   - **проверить**: используется ли `MobileActionCard` где-то ещё —
     если только в `/page.tsx`, удалить файл.
8. **Тесты** — `tests/smoke/`:
   - удалить блок `homepage tile visibility`;
   - переписать блок `root / redirects working roles into their
     workspace` под новое поведение;
   - переписать блок `login redirect uses primary workspace` под
     `getDefaultRouteForRole`;
   - добавить unit-suites:
     `tests/unit/role-redirect.unit.test.ts`,
     `tests/unit/safe-return-to.unit.test.ts`;
   - добавить smoke `tests/smoke/auth-design-cleanup.smoke.test.ts`
     (текст login, отсутствие legacy-классов, отсутствие inline style
     в новых auth-компонентах, root.tsx — pure redirect).
   - регрессия: `employee-qr-button.smoke`, `employee-workplaces-design.smoke`,
     `route-wip-work-ui.smoke`, `frontend-rbac.smoke` остаются зелёными.
9. **Docs**:
   - этот документ;
   - обновить `docs/screens.md` (точечно: §1 «модель одного рабочего
     окна» — теперь у ADMIN/SHOP_MANAGER landing = `/admin`, не `/`);
   - обновить `docs/ui-mobile.md` (login входит в mobile UI guidelines —
     добавить раздел про AuthShell);
   - в `docs/design-cleanup-recon.md` добавить ссылку на этот файл,
     если уместно;
   - `docs/index.md` — упомянуть новый recon.

После реализации прогнать:

```
npm run typecheck
npm run build
npm run docs:check
npm run test:smoke
```
