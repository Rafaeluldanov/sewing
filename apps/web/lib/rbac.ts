/**
 * Frontend RBAC helpers.
 *
 * Backend остаётся источником истины (см. `apps/api/src/modules/*` —
 * декораторы `@Roles(...)`). Эти хелперы нужны только UI:
 *   - спрятать пункты навигации, которые роль всё равно не сможет
 *     открыть;
 *   - на server-component страницах закрытых разделов вернуть
 *     forbidden state, не делая лишних API-запросов.
 *
 * Матрица доступности (см. `docs/api.md §1`, `docs/screens.md §1`):
 *
 *   /qc       → QC, SHOP_MANAGER, ADMIN
 *   /wto      → IRONING, SHOP_MANAGER, ADMIN
 *   /packing  → PACKING, SHOP_MANAGER, ADMIN
 *   /orders   → ADMIN, SHOP_MANAGER (+ CUTTER_ASSISTANT — read-only,
 *               чтобы помощник раскройщика мог выпустить паспорт)
 *
 * Для остальных разделов (/work, /earnings, /shopfloor, /admin/*)
 * проверки уже сделаны на местах — здесь их не дублируем.
 *
 * Видимость в навигации (header / mobile-nav) сознательно отделена
 * от технического доступа: для `CUTTER_ASSISTANT` backend оставляет
 * read-доступ к `/orders/*` (нужен для flow «Выпустить паспорт» —
 * `/work` → `/work/cut-orders` → `/orders/:id/passports/new`), но в
 * меню `/orders` и `/shopfloor` ему не показываются — у него есть
 * единственная точка входа `/work`. Это закрывают `canSeeOrdersMenu`
 * и `canSeeShopfloorMenu` ниже; технический `canSeeOrders` оставлен
 * как есть и продолжает использоваться в `app/orders/layout.tsx`.
 */

import { SYSTEM_ROLE_LABELS } from '@sewing/shared/app-roles';

export type Role =
  | 'ADMIN'
  | 'SHOP_MANAGER'
  | 'CUTTER'
  | 'CUTTER_ASSISTANT'
  | 'SEAMSTRESS'
  | 'QC'
  | 'IRONING'
  | 'PACKING'
  /**
   * Read-only роль «Экран цеха» (shopfloor display, см.
   * `apps/web/app/shopfloor/display/page.tsx`). Используется для
   * учётки, под которой запущен большой монитор в зале: единственная
   * доступная страница — `/shopfloor/display`, никаких мутаций,
   * никакой навигации, любая попытка зайти в другой раздел
   * редиректится в display-экран (см. `apps/web/middleware.ts`).
   */
  | 'DISPLAY'
  /**
   * Мастер цеха (MVP, см. `docs/domain.md §«Мастер цеха»`,
   * `apps/web/app/master/page.tsx`). Мобильный терминал `/master`:
   * видит очередь открытых вызовов от рабочих, закрывает вызов сканом
   * QR сотрудника. Доступа к админке/ценам/маршрутам/техкартам/
   * пользователям на MVP нет — primary workspace и единственная
   * осмысленная точка входа совпадают.
   */
  | 'SHOPFLOOR_MASTER'
  /**
   * Конструктор лекал (см. `apps/web/app/constructor/`,
   * `apps/api/src/modules/constructor-tasks/`). Кабинет
   * `/constructor` — single-workspace роль: видит назначенные на
   * себя задачи + общий пул свободных, берёт в работу
   * (`assignSelf` → IN_PROGRESS), завершает с загрузкой готовых
   * DXF-лекал — backend атомарно переводит `PatternItem` в `ACTIVE`
   * и `ConstructorTask` в `DONE`. Доступа к админке / заказам /
   * терминалам цеха не имеет.
   */
  | 'CONSTRUCTOR'
  /**
   * Супер-админ control-plane (мультитенантность, Фаза 4). КРОСС-тенантная
   * роль: панель `/superadmin` (реестр тенантов). НЕ равна tenant-ADMIN —
   * `canSeeSuperadmin` пускает ТОЛЬКО эту роль.
   */
  | 'SUPERADMIN';

/**
 * Единственная страница, на которую пускают роль `DISPLAY`. Хранится
 * в одном месте, чтобы middleware и RBAC-хелперы не разъезжались.
 */
export const DISPLAY_ALLOWED_PATH = '/shopfloor/display';

/**
 * Единственная страница, на которую пускают роль `SHOPFLOOR_MASTER`.
 * Логика та же, что у `DISPLAY_ALLOWED_PATH`, чтобы middleware и
 * login redirect не разъезжались с RBAC-хелперами.
 */
export const SHOPFLOOR_MASTER_ALLOWED_PATH = '/master';

/**
 * Корневой путь кабинета конструктора. Middleware пускает роль
 * `CONSTRUCTOR` только по путям, начинающимся с этого префикса
 * (`/constructor`, `/constructor/<taskId>` и т.д.).
 */
export const CONSTRUCTOR_ALLOWED_PATH = '/constructor';

/**
 * Корневой путь кабинета раскройщика (роль `CUTTER`). Middleware
 * пускает роль `CUTTER` только по путям с этим префиксом — та же
 * single-workspace модель, что у `CONSTRUCTOR`.
 */
export const CUTTER_ALLOWED_PATH = '/cutter';

/**
 * Фича «несколько ролей» (18.06.2026): RBAC-хелперы теперь принимают
 * либо одну роль (как раньше — основная/активная), либо весь набор
 * ролей доступа (`Employee.roles`). Доступ есть, если ХОТЯ БЫ ОДНА роль
 * проходит проверку. Так старые вызовы с одной строкой остаются
 * валидны, а layout/навигация передают полный массив.
 */
export type RolesInput = string | readonly string[] | null | undefined;

function toRoleList(input: RolesInput): string[] {
  if (!input) return [];
  return Array.isArray(input)
    ? (input as readonly string[]).filter((r): r is string => !!r)
    : [input as string];
}

function anyRoleIn(input: RolesInput, allowed: readonly string[]): boolean {
  const list = toRoleList(input);
  if (list.length === 0) return false;
  const set = new Set<string>(allowed as readonly string[]);
  return list.some((r) => set.has(r));
}

export const QC_ALLOWED_ROLES: readonly Role[] = ['QC', 'SHOP_MANAGER', 'ADMIN'];
export const WTO_ALLOWED_ROLES: readonly Role[] = [
  'IRONING',
  'SHOP_MANAGER',
  'ADMIN',
];
export const PACKING_ALLOWED_ROLES: readonly Role[] = [
  'PACKING',
  'SHOP_MANAGER',
  'ADMIN',
];
export const CONSTRUCTOR_ALLOWED_ROLES: readonly Role[] = [
  'CONSTRUCTOR',
  'SHOP_MANAGER',
  'ADMIN',
];
export const CUTTER_ALLOWED_ROLES: readonly Role[] = [
  'CUTTER',
  'SHOP_MANAGER',
  'ADMIN',
];
export const ORDERS_ALLOWED_ROLES: readonly Role[] = [
  'ADMIN',
  'SHOP_MANAGER',
  'CUTTER_ASSISTANT',
];

/**
 * Роли, которым в UI-навигации (header + mobile-nav) показываем
 * пункт «Заказы». Это подмножество `ORDERS_ALLOWED_ROLES`, из
 * которого исключён `CUTTER_ASSISTANT`: технический read-доступ к
 * `/orders/*` ему остаётся (см. `canSeeOrders` и
 * `app/orders/layout.tsx`), но в меню он ходит только через `/work`.
 */
export const ORDERS_MENU_ALLOWED_ROLES: readonly Role[] = [
  'ADMIN',
  'SHOP_MANAGER',
];

/**
 * Роли, которым НЕ показываем пункт «Цех» в навигации. Сама страница
 * `/shopfloor` остаётся доступной по прямой ссылке для всех
 * залогиненных ролей (RBAC закрывает только конкретные операции
 * внутри). Скрываем пункт у `CUTTER_ASSISTANT`, чтобы у помощника
 * раскройщика остался единственный рабочий вход — `/work`. У
 * `DISPLAY` навигации нет вовсе — он сидит на `/shopfloor/display`.
 */
export const SHOPFLOOR_MENU_HIDDEN_ROLES: readonly Role[] = [
  'CUTTER_ASSISTANT',
  // У раскройщика единственная точка входа — `/cutter`.
  'CUTTER',
  'DISPLAY',
  // У мастера цеха единственная точка входа — `/master`.
  'SHOPFLOOR_MASTER',
  // У конструктора единственная точка входа — `/constructor`.
  'CONSTRUCTOR',
];

/**
 * Доступ к admin/manager-разделам (`/admin/*`, в т.ч. управление
 * оборудованием — см. ADR-0017). Backend независимо защищает
 * `/api/equipment/*` и `/api/admin/*` через `@Roles('SHOP_MANAGER',
 * 'ADMIN')`.
 */
export const ADMIN_ALLOWED_ROLES: readonly Role[] = ['ADMIN', 'SHOP_MANAGER'];

/**
 * Доступ к управленческому модулю «Себестоимость выпуска»
 * (`/production-cost`, см. `docs/screens.md §17`). Backend независимо
 * защищает `/api/costs/production` через `@Roles('SHOP_MANAGER',
 * 'ADMIN')`.
 */
export const PRODUCTION_COST_ALLOWED_ROLES: readonly Role[] = [
  'ADMIN',
  'SHOP_MANAGER',
];

export function canSeeQc(roles: RolesInput): boolean {
  return anyRoleIn(roles, QC_ALLOWED_ROLES);
}

export function canSeeWto(roles: RolesInput): boolean {
  return anyRoleIn(roles, WTO_ALLOWED_ROLES);
}

export function canSeePacking(roles: RolesInput): boolean {
  return anyRoleIn(roles, PACKING_ALLOWED_ROLES);
}

/**
 * Доступ к кабинету конструктора (`/constructor`). Сама роль —
 * основной пользователь; ADMIN/SHOP_MANAGER оставлены в матрице,
 * чтобы менеджер мог открыть тот же экран при необходимости (в
 * пилоте полезно «забрать на себя» застрявшую задачу) — backend
 * пропускает их через `enforceOwnership = false`.
 */
export function canSeeConstructor(roles: RolesInput): boolean {
  return anyRoleIn(roles, CONSTRUCTOR_ALLOWED_ROLES);
}

/**
 * Доступ к кабинету раскройщика (`/cutter`). Роль `CUTTER` — основной
 * пользователь; ADMIN/SHOP_MANAGER оставлены в матрице, чтобы менеджер
 * мог открыть тот же экран и помочь с застрявшей задачей (очередь
 * общая, владение не энфорсится).
 */
export function canSeeCutter(roles: RolesInput): boolean {
  return anyRoleIn(roles, CUTTER_ALLOWED_ROLES);
}

/**
 * Видимость пунктов терминальных разделов (`/qc`, `/wto`, `/packing`)
 * в навигации (header + mobile-nav + плитки на `/`).
 *
 * Отделены от технических `canSeeQc` / `canSeeWto` / `canSeePacking`
 * по той же логике, что и `canSeeOrdersMenu` vs `canSeeOrders`:
 *
 *   - SHOP_MANAGER формально имеет read/write доступ к страницам
 *     терминалов (см. `*_ALLOWED_ROLES` выше и backend `@Roles(...)`),
 *     и должен сохранить возможность открыть их по прямой ссылке —
 *     `/qc/layout.tsx`, `/wto/layout.tsx`, `/packing/layout.tsx`
 *     продолжают пускать его, как раньше;
 *   - но в UI-меню начальник цеха работает через дашборды и
 *     admin-разделы, а пункты «Рабочее место» / «ОТК» / «ВТО» /
 *     «Упаковка» — это scan-driven терминалы операторов, в навигации
 *     менеджера они только засоряют шапку.
 *
 * ADMIN остаётся в матрице — у админа в шапке должен быть полный
 * набор разделов для отладки и поддержки.
 */
export function canSeeQcMenu(roles: RolesInput): boolean {
  // Фича «несколько ролей»: пункт «ОТК» в меню показываем тем, кто
  // реально выполняет роль QC (или ADMIN — у него полный набор для
  // отладки). Чистому SHOP_MANAGER пункт не нужен (работает через
  // дашборды), но менеджер-совместитель QC+SHOP_MANAGER его увидит.
  return anyRoleIn(roles, ['QC', 'ADMIN']);
}

export function canSeeWtoMenu(roles: RolesInput): boolean {
  return anyRoleIn(roles, ['IRONING', 'ADMIN']);
}

export function canSeePackingMenu(roles: RolesInput): boolean {
  return anyRoleIn(roles, ['PACKING', 'ADMIN']);
}

export function canSeeOrders(roles: RolesInput): boolean {
  return anyRoleIn(roles, ORDERS_ALLOWED_ROLES);
}

/**
 * Видимость пункта «Заказы» в навигации (header / mobile-nav).
 * Отличается от `canSeeOrders` тем, что не пускает CUTTER_ASSISTANT
 * (см. матрицу выше).
 */
export function canSeeOrdersMenu(roles: RolesInput): boolean {
  return anyRoleIn(roles, ORDERS_MENU_ALLOWED_ROLES);
}

/**
 * Видимость пункта «Цех» в навигации (header / mobile-nav). По
 * умолчанию доступно всем залогиненным ролям, кроме перечисленных в
 * `SHOPFLOOR_MENU_HIDDEN_ROLES`.
 */
export function canSeeShopfloorMenu(roles: RolesInput): boolean {
  // Показываем пункт «Цех», если ХОТЯ БЫ одна роль сотрудника не входит
  // в «спрятанные» (single-workspace) роли. Чистый CUTTER/DISPLAY/… не
  // увидит, а совместитель с обычной ролью — увидит.
  const list = toRoleList(roles);
  if (list.length === 0) return false;
  const hidden = new Set<string>(SHOPFLOOR_MENU_HIDDEN_ROLES as readonly string[]);
  return list.some((r) => !hidden.has(r));
}

export function canSeeAdmin(roles: RolesInput): boolean {
  return anyRoleIn(roles, ADMIN_ALLOWED_ROLES);
}

/**
 * Доступ к панели супер-админа control-plane `/superadmin` (Фаза 4).
 * ВАЖНО: ТОЛЬКО роль `SUPERADMIN` — обычный `ADMIN` сюда НЕ входит (это
 * кросс-тенантная панель, а ADMIN тенант-скоупный). Зеркалит SuperadminGuard.
 */
export const SUPERADMIN_ALLOWED_ROLES: readonly Role[] = ['SUPERADMIN'];
export function canSeeSuperadmin(roles: RolesInput): boolean {
  return anyRoleIn(roles, SUPERADMIN_ALLOWED_ROLES);
}

export function canSeeProductionCost(roles: RolesInput): boolean {
  return anyRoleIn(roles, PRODUCTION_COST_ALLOWED_ROLES);
}

/**
 * Модель «одно рабочее окно на роль» (см. `docs/screens.md §1`).
 *
 * Для рабочих/производственных ролей у приложения единственная
 * осмысленная точка входа — их рабочий экран. Поэтому весь UI
 * (login redirect, корневой `/`, навигация) опирается на эту матрицу,
 * а не размазывает `if role === ...` по компонентам.
 *
 * Маппинг:
 *   SEAMSTRESS         → `/work`
 *   CUTTER_ASSISTANT   → `/work`
 *   CUTTER             → `/cutter` (кабинет раскройщика, single-workspace)
 *   IRONING            → `/wto` (scan-driven role-terminal,
 *                                см. `apps/web/app/wto/wto-terminal.tsx`)
 *   QC                 → `/qc`
 *   PACKING            → `/packing`
 *   SHOP_MANAGER       → `/`
 *   ADMIN              → `/`
 *
 * Для менеджерских ролей primary workspace — это домашняя плитка
 * `/`, она и есть multi-section app: им мы не редиректим и не
 * упрощаем навигацию.
 */
const PRIMARY_WORKSPACE_BY_ROLE: Record<Role, string> = {
  ADMIN: '/',
  SHOP_MANAGER: '/',
  // CUTTER — кабинет раскройщика `/cutter` (single-workspace).
  CUTTER: CUTTER_ALLOWED_PATH,
  CUTTER_ASSISTANT: '/work',
  SEAMSTRESS: '/work',
  IRONING: '/wto',
  QC: '/qc',
  PACKING: '/packing',
  // DISPLAY — учётка под большой монитор, единственная доступная
  // страница совпадает с primary workspace.
  DISPLAY: DISPLAY_ALLOWED_PATH,
  // SHOPFLOOR_MASTER — мобильный терминал `/master` (MVP).
  SHOPFLOOR_MASTER: SHOPFLOOR_MASTER_ALLOWED_PATH,
  // CONSTRUCTOR — кабинет конструктора `/constructor` (single-workspace).
  CONSTRUCTOR: CONSTRUCTOR_ALLOWED_PATH,
  // SUPERADMIN — панель control-plane `/superadmin` (кросс-тенантная роль).
  SUPERADMIN: '/superadmin',
};

export function getPrimaryWorkspace(role: string | undefined | null): string {
  if (!role) return '/';
  return PRIMARY_WORKSPACE_BY_ROLE[role as Role] ?? '/';
}

/**
 * Участок, на котором сотрудник стоит СЕЙЧАС: `activeRole` (последнее
 * переключение), а без него — основная роль.
 *
 * Единая точка для всех терминалов. До этого каждый кабинет решал сам
 * и все решали одинаково неправильно — брали `Employee.role`, поэтому
 * сотрудница с ролями ОТК+ВТО, перейдя на ВТО, видела в шапке «ОТК», а
 * `/work` показывал швейный экран человеку, переключившемуся на участок
 * помощника раскройщика.
 */
export function getActiveWorkplaceRole(user: {
  role: string;
  activeRole?: string | null;
}): string {
  return user.activeRole ?? user.role;
}

/**
 * Подпись активного участка для бейджа в шапке терминала. Название
 * считает сервер (`AuthUserDto.activeRoleLabel`) — в справочнике живут
 * и кастомные роли, а `/api/app-roles` терминалам не открыт. Fallback
 * `formatRole` покрывает старые сессии и системные коды.
 */
export function getActiveWorkplaceLabel(user: {
  role: string;
  activeRole?: string | null;
  activeRoleLabel?: string;
}): string {
  const role = getActiveWorkplaceRole(user);
  return user.activeRoleLabel ?? SYSTEM_ROLE_LABELS[role] ?? role;
}

/**
 * Роли, у которых единственная осмысленная точка входа — их рабочий
 * экран (терминал). Для них:
 *   - `/` редиректится на primary workspace;
 *   - login без явного `next` ведёт сразу на primary workspace;
 *   - глобальная навигация в шапке/нижнем меню скрыта (см.
 *     `canSeeHome` / `canSeeWorkTab` ниже и `MobileNav`).
 *
 * SEAMSTRESS и CUTTER_ASSISTANT — обязательный минимум. У них
 * `<AppHeader>` на `/work*` уже скрывается (см.
 * `components/app-header.tsx`), а нижняя навигация теряет смысл —
 * экран должен выглядеть как один сфокусированный терминал.
 *
 * QC попадает сюда же: `/qc` теперь scan-driven терминал по той же
 * модели (см. `apps/web/app/qc/qc-terminal.tsx`), `<AppHeader>` на
 * `/qc` тоже скрыт.
 *
 * IRONING — по той же модели: `/wto` scan-driven терминал
 * (см. `apps/web/app/wto/wto-terminal.tsx`), `<AppHeader>` скрыт.
 *
 * PACKING — `/packing` теперь scan-driven терминал упаковщика:
 * единое окно «открой смену → создай коробку → сканируй паспорта →
 * закрой коробку» (см. `apps/web/app/packing/packing-terminal.tsx`).
 * Глобальная навигация и `<AppHeader>` для него тоже скрыты.
 */
const SINGLE_WORKSPACE_ROLES: readonly Role[] = [
  'SEAMSTRESS',
  'CUTTER_ASSISTANT',
  // У раскройщика один экран `/cutter` — кабинет с задачами на раскрой.
  'CUTTER',
  'QC',
  'IRONING',
  'PACKING',
  // У DISPLAY вообще нет других экранов — большой монитор должен
  // выглядеть только как доска цеха, без header/mobile-nav.
  'DISPLAY',
  // У мастера цеха одна страница `/master` — мобильный терминал.
  'SHOPFLOOR_MASTER',
  // У конструктора один экран `/constructor` — кабинет с задачами.
  'CONSTRUCTOR',
];

export function isSingleWorkspaceRole(roles: RolesInput): boolean {
  // Фича «несколько ролей»: «одно рабочее окно» — это про сотрудника с
  // РОВНО ОДНОЙ ролью, и она single-workspace. Совместитель (2+ роли)
  // получает полноценную навигацию, его не запираем на один экран.
  const list = toRoleList(roles);
  if (list.length !== 1) return false;
  return (SINGLE_WORKSPACE_ROLES as readonly string[]).includes(list[0]!);
}

/**
 * Все производственные роли (рабочие). Для них «Главная» как
 * отдельная плитка не имеет смысла — primary workspace и есть их
 * домашний экран. Менеджеры/админы продолжают видеть `/` как
 * многосекционную домашнюю страницу.
 */
const WORKING_ROLES: readonly Role[] = [
  'CUTTER',
  'CUTTER_ASSISTANT',
  'SEAMSTRESS',
  'IRONING',
  'QC',
  'PACKING',
  // DISPLAY формально не «работает», но мы пользуемся тем же
  // механизмом «корневой `/` редиректит в primary workspace», чтобы
  // и аноним при логине, и попадание на `/` уводили в `/shopfloor/display`.
  'DISPLAY',
  // SHOPFLOOR_MASTER пользуется тем же механизмом: login и `/`
  // ведут в `/master` (см. `getPrimaryWorkspace`).
  'SHOPFLOOR_MASTER',
  // CONSTRUCTOR — single-workspace кабинет `/constructor`.
  'CONSTRUCTOR',
];

export function isWorkingRole(role: string | undefined | null): boolean {
  return !!role && (WORKING_ROLES as readonly string[]).includes(role);
}

/**
 * Роль «Экран цеха». Хелпер вынесен отдельно, чтобы layout/middleware
 * могли явно отличать «производственная роль с одним рабочим экраном»
 * от read-only display: у них пересекается поведение «hide nav», но
 * расходится set прав внутри API.
 */
export function isDisplayRole(role: string | undefined | null): boolean {
  return role === 'DISPLAY';
}

/**
 * Роль «Мастер цеха». Аналог `isDisplayRole` — middleware и login
 * используют этот хелпер, чтобы редиректить мастера на `/master`,
 * не пуская его на остальные разделы.
 */
export function isShopfloorMasterRole(
  role: string | undefined | null,
): boolean {
  return role === 'SHOPFLOOR_MASTER';
}

/**
 * Роль «Конструктор». Аналог `isShopfloorMasterRole` — middleware
 * редиректит конструктора с любых страниц на `/constructor`.
 */
export function isConstructorRole(role: string | undefined | null): boolean {
  return role === 'CONSTRUCTOR';
}

/**
 * Роль «Раскройщик». Аналог `isConstructorRole` — middleware редиректит
 * раскройщика с любых страниц на `/cutter`.
 */
export function isCutterRole(role: string | undefined | null): boolean {
  return role === 'CUTTER';
}

/**
 * Доступ к мобильному терминалу мастера цеха (`/master`, см.
 * `apps/web/app/master/page.tsx`). Сама роль — основной
 * пользователь; ADMIN и SHOP_MANAGER оставлены в матрице, чтобы
 * менеджер мог открыть тот же экран на своём телефоне без отдельной
 * учётки. Backend независимо защищает `/api/master-calls/*` через
 * `@Roles(...)`.
 */
export const MASTER_PAGE_ALLOWED_ROLES: readonly Role[] = [
  'SHOPFLOOR_MASTER',
  'ADMIN',
  'SHOP_MANAGER',
];

export function canSeeMasterPage(roles: RolesInput): boolean {
  return anyRoleIn(roles, MASTER_PAGE_ALLOWED_ROLES);
}

/**
 * Доступ к экрану «Цех на большом мониторе» (`/shopfloor/display`).
 * Роли, которым разрешено его видеть:
 *   - `DISPLAY` — собственно учётка под монитор;
 *   - `ADMIN` / `SHOP_MANAGER` — менеджерам полезно открыть тот же
 *     экран на собственном устройстве, без редиректа.
 *
 * Backend пока не закрывает страницу отдельно — endpoints
 * `/api/shopfloor/state`, `/api/shopfloor/orders`,
 * `/api/dashboard/production` уже доступны нужным ролям, и
 * этого достаточно для read-only представления.
 */
export const DISPLAY_PAGE_ALLOWED_ROLES: readonly Role[] = [
  'DISPLAY',
  'ADMIN',
  'SHOP_MANAGER',
];

export function canSeeDisplayPage(roles: RolesInput): boolean {
  return anyRoleIn(roles, DISPLAY_PAGE_ALLOWED_ROLES);
}

/**
 * Видимость кнопки «Мой QR-код» (см. компонент
 * `apps/web/components/employees/employee-qr-button.tsx` и endpoint
 * `GET /api/me/employee-qr`).
 *
 * Кого включаем:
 *   - Все производственные/терминальные роли
 *     (`CUTTER`, `CUTTER_ASSISTANT`, `CONSTRUCTOR`, `SEAMSTRESS`, `QC`,
 *     `IRONING`, `PACKING`) — им QR нужен, чтобы мастер/терминал быстро
 *     идентифицировал сотрудника вместо ручного ввода логина
 *     (`CONSTRUCTOR` — по решению: в кабинете оставляем QR, хотя в
 *     цеховом потоке его не сканируют).
 *   - `SHOPFLOOR_MASTER` — по обратной логике: мастер тоже может
 *     оказаться «сканируемым» (например, на чужом терминале), а UI
 *     в `/master` проще держит единый паттерн «у каждого рабочего
 *     экрана есть эта кнопка».
 *   - `ADMIN`, `SHOP_MANAGER` — для тестирования сканера и
 *     диагностики на пилоте: админу должно быть видно всё.
 *
 * Кого исключаем:
 *   - `DISPLAY` — это учётка под большой монитор без сотрудника;
 *     показывать на ней «мой QR» бессмысленно (сотрудника нет) и
 *     опасно (публичный экран).
 */
export const EMPLOYEE_QR_BUTTON_ALLOWED_ROLES: readonly Role[] = [
  'CUTTER',
  'CUTTER_ASSISTANT',
  'CONSTRUCTOR',
  'SEAMSTRESS',
  'QC',
  'IRONING',
  'PACKING',
  'SHOPFLOOR_MASTER',
  'ADMIN',
  'SHOP_MANAGER',
];

export function canSeeEmployeeQrButton(roles: RolesInput): boolean {
  return anyRoleIn(roles, EMPLOYEE_QR_BUTTON_ALLOWED_ROLES);
}

/**
 * Видимость пункта/тайла «Главная» в навигации.
 *
 * Для производственных ролей `/` либо редиректит на их primary
 * workspace, либо дублирует его — поэтому отдельный пункт «Главная»
 * не нужен. Для менеджеров/админов оставляем как есть.
 */
export function canSeeHome(roles: RolesInput): boolean {
  // Показываем «Главную», если ХОТЯ БЫ одна роль не является
  // производственной (для совместителя с менеджерской ролью — да).
  const list = toRoleList(roles);
  if (list.length === 0) return false;
  return list.some((r) => !isWorkingRole(r));
}

/**
 * Видимость пункта «Рабочее место» (`/work`) в навигации.
 *
 * Скрываем у тех, для кого `/work` уже является primary workspace
 * (SEAMSTRESS, CUTTER_ASSISTANT, CUTTER) — иначе получается
 * дублирующая вкладка. Скрываем и у QC/IRONING/PACKING — их рабочий
 * экран другой (`/qc`, `/wto`, `/packing`), на `/work` им заходить
 * незачем.
 *
 * SHOP_MANAGER тоже скрыт: терминал швеи начальнику цеха в меню не
 * нужен (работа идёт через дашборды и admin-разделы). Технический
 * доступ к `/work` у роли остаётся — backend и страница режут
 * операции по своим guards, а не по этому UI-флагу. Полный набор
 * пунктов сохраняем только за ADMIN — для отладки и поддержки.
 */
export function canSeeWorkTab(roles: RolesInput): boolean {
  return toRoleList(roles).includes('ADMIN');
}
