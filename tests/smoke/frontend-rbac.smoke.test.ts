/**
 * Frontend smoke-тест RBAC видимости и упрощённого `/work` для
 * CUTTER_ASSISTANT.
 *
 * Полноценного React-рендерера в проекте нет (vitest идёт в Node, без
 * jsdom + RTL), поэтому проверяем вещи, которые можно зафиксировать
 * без рендера:
 *
 *   1. Хелперы матрицы доступа (`apps/web/lib/rbac.ts`) согласованы с
 *      backend `@Roles(...)` для всех 8 ролей.
 *   2. `apps/web/app/work/active-shift-panel.tsx` действительно содержит
 *      отдельный `CutterAssistantWorkPanel` с одним primary-action
 *      «Выпустить паспорт» и без scanner-first сценария; primary-кнопка
 *      ведёт на упрощённый выбор `/work/cut-orders` (а не на admin
 *      `/orders`).
 *   3. `apps/web/app/work/page.tsx` маршрутизирует CUTTER_ASSISTANT на
 *      этот упрощённый путь, минуя `ShiftStartForm` и табы, и
 *      подключает ему то же три-точечное меню действий
 *      (`SeamstressActionsMenu`), что и у швеи — потому что верхний
 *      header у него на `/work*` тоже скрыт.
 *   4. `apps/web/components/app-header.tsx` явно скрывает шапку для
 *      CUTTER_ASSISTANT на `/work*` и на `/orders/:id/passports/new` —
 *      это «mobile clean» режим из ТЗ.
 *   5. Новый route `/work/cut-orders` (упрощённый выбор заказа)
 *      опирается на бэкенд (`listOrders` + `status: 'IN_PRODUCTION'`),
 *      авто-редиректит при единственном заказе и показывает
 *      empty state, когда заказов нет.
 *
 * Тесты узкие, но это «обязательно, но минимально», как просит ТЗ.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  canSeeHome,
  canSeeOrders,
  canSeeOrdersMenu,
  canSeePacking,
  canSeePackingMenu,
  canSeeQc,
  canSeeQcMenu,
  canSeeShopfloorMenu,
  canSeeWorkTab,
  canSeeWto,
  canSeeWtoMenu,
  getPrimaryWorkspace,
  isSingleWorkspaceRole,
  isWorkingRole,
  type Role,
} from '../../apps/web/lib/rbac';

const ALL_ROLES: Role[] = [
  'ADMIN',
  'SHOP_MANAGER',
  'CUTTER',
  'CUTTER_ASSISTANT',
  'SEAMSTRESS',
  'QC',
  'IRONING',
  'PACKING',
];

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('frontend rbac matrix', () => {
  test('canSeeQc: только QC, SHOP_MANAGER, ADMIN', () => {
    const allowed = ALL_ROLES.filter((r) => canSeeQc(r));
    expect(allowed.sort()).toEqual(['ADMIN', 'QC', 'SHOP_MANAGER']);
  });

  test('canSeePacking: только PACKING, SHOP_MANAGER, ADMIN', () => {
    const allowed = ALL_ROLES.filter((r) => canSeePacking(r));
    expect(allowed.sort()).toEqual(['ADMIN', 'PACKING', 'SHOP_MANAGER']);
  });

  test('canSeeOrders: ADMIN, SHOP_MANAGER + CUTTER_ASSISTANT (read-only для выпуска паспорта)', () => {
    const allowed = ALL_ROLES.filter((r) => canSeeOrders(r));
    expect(allowed.sort()).toEqual([
      'ADMIN',
      'CUTTER_ASSISTANT',
      'SHOP_MANAGER',
    ]);
  });

  test('canSeeOrdersMenu: только ADMIN и SHOP_MANAGER (CUTTER_ASSISTANT исключён из меню)', () => {
    const allowed = ALL_ROLES.filter((r) => canSeeOrdersMenu(r));
    expect(allowed.sort()).toEqual(['ADMIN', 'SHOP_MANAGER']);
    // У роли остаётся технический read-доступ для flow «Выпустить паспорт».
    expect(canSeeOrders('CUTTER_ASSISTANT')).toBe(true);
    expect(canSeeOrdersMenu('CUTTER_ASSISTANT')).toBe(false);
  });

  test('canSee{Qc,Wto,Packing}Menu: SHOP_MANAGER исключён, операторы остаются, технический доступ сохранён', () => {
    // По матрице из ТЗ начальник цеха не должен видеть в навигации
    // scan-driven терминалы операторов — но прямой доступ к страницам
    // (через URL) у роли остаётся, как и у `canSeeOrdersMenu` vs
    // `canSeeOrders`.
    expect(canSeeQc('SHOP_MANAGER')).toBe(true);
    expect(canSeeWto('SHOP_MANAGER')).toBe(true);
    expect(canSeePacking('SHOP_MANAGER')).toBe(true);
    expect(canSeeQcMenu('SHOP_MANAGER')).toBe(false);
    expect(canSeeWtoMenu('SHOP_MANAGER')).toBe(false);
    expect(canSeePackingMenu('SHOP_MANAGER')).toBe(false);

    // Профильные роли по-прежнему видят свой пункт.
    expect(canSeeQcMenu('QC')).toBe(true);
    expect(canSeeWtoMenu('IRONING')).toBe(true);
    expect(canSeePackingMenu('PACKING')).toBe(true);

    // ADMIN сохраняет полный набор пунктов в меню (для отладки/поддержки).
    expect(canSeeQcMenu('ADMIN')).toBe(true);
    expect(canSeeWtoMenu('ADMIN')).toBe(true);
    expect(canSeePackingMenu('ADMIN')).toBe(true);

    // Роли, которым раздел вообще недоступен, и через menu-хелпер не пройдут.
    expect(canSeeQcMenu('SEAMSTRESS')).toBe(false);
    expect(canSeeWtoMenu('CUTTER')).toBe(false);
    expect(canSeePackingMenu('IRONING')).toBe(false);
    expect(canSeeQcMenu(undefined)).toBe(false);
    expect(canSeeWtoMenu(null)).toBe(false);
    expect(canSeePackingMenu('')).toBe(false);
  });

  test('canSeeShopfloorMenu: показываем всем кроме CUTTER_ASSISTANT', () => {
    const allowed = ALL_ROLES.filter((r) => canSeeShopfloorMenu(r));
    expect(allowed.sort()).toEqual(
      [
        'ADMIN',
        'CUTTER',
        'IRONING',
        'PACKING',
        'QC',
        'SEAMSTRESS',
        'SHOP_MANAGER',
      ].sort(),
    );
    expect(canSeeShopfloorMenu('CUTTER_ASSISTANT')).toBe(false);
  });

  test('пустая/невалидная роль никуда не пускает', () => {
    expect(canSeeQc(undefined)).toBe(false);
    expect(canSeePacking(null)).toBe(false);
    expect(canSeeOrders('')).toBe(false);
    expect(canSeeOrdersMenu(undefined)).toBe(false);
    expect(canSeeShopfloorMenu(null)).toBe(false);
    expect(canSeeQc('UNKNOWN_ROLE')).toBe(false);
  });
});

describe('cutter-assistant /work simplified UI', () => {
  test('active-shift-panel экспортирует CutterAssistantWorkPanel с двумя action: «Выпустить паспорт» и «Разместить на стеллаж»', () => {
    const src = readSrc('apps/web/app/work/active-shift-panel.tsx');
    expect(src).toMatch(/export function CutterAssistantWorkPanel/);
    expect(src).toMatch(/Выпустить паспорт/);
    // primary-action ведёт на упрощённый выбор заказа `/work/cut-orders`
    // (а не в admin `/orders`): это и есть «один тап до выпуска».
    expect(src).toMatch(/href="\/work\/cut-orders"/);
    // Старого хака «выпуск через admin /orders» больше быть не должно
    // — иначе помощник снова попадёт в полноценный admin-список.
    expect(src).not.toMatch(/href="\/orders"/);
    // Второе действие — shelf-placement flow (см. ТЗ §4–§7,
    // `docs/flows.md §F3b`). Кнопка лейбл «Разместить на стеллаж»
    // и сама ведёт в `<ShelfPlacementPanel>`, без route-перехода.
    expect(src).toMatch(/Разместить на стеллаж/);
    expect(src).toMatch(/Разместить крой на стеллаж/);
    expect(src).toMatch(/ShelfPlacementPanel/);
    // В самой панели кнопки «Завершить смену» больше нет — она
    // переехала в три-точечное меню `SeamstressActionsMenu`, иначе
    // экран снова станет шумным.
    const panelStart = src.indexOf('export function CutterAssistantWorkPanel');
    const panelEnd = src.indexOf('function DefaultActivePanel', panelStart);
    expect(panelStart).toBeGreaterThan(0);
    expect(panelEnd).toBeGreaterThan(panelStart);
    const panelBlock = src.slice(panelStart, panelEnd);
    expect(panelBlock).not.toMatch(/Завершить смену/);
    // Панель больше не принимает props — рендерится только при
    // активной смене (см. `app/work/page.tsx`), `canStop` выпилен.
    expect(panelBlock).toMatch(/CutterAssistantWorkPanel\(\)/);
  });

  test('shelf-placement-panel реализует state-машину scan-cell → confirm-cell → placing', () => {
    const src = readSrc('apps/web/app/work/shelf-placement-panel.tsx');
    // Только эта роль использует панель — но проверяем сам контракт
    // state machine, не RBAC (RBAC обеспечивается `CutterAssistantWorkPanel`).
    expect(src).toMatch(/'scanning-cell'/);
    expect(src).toMatch(/'confirm-cell'/);
    expect(src).toMatch(/'placing'/);
    // Подтверждение ячейки имеет крупную primary-кнопку.
    expect(src).toMatch(/Подтвердить ячейку/);
    // Backend = источник истины: используем cell-by-code и server action
    // размещения, а не client-only validation.
    expect(src).toMatch(/lookupCellByCodeAction/);
    expect(src).toMatch(/placePassportToCellAction/);
    // Кнопка завершения сессии размещения — «Готово».
    expect(src).toMatch(/Готово/);
  });

  test('shelf-placement-panel в режиме placing явно объясняет UX-режим', () => {
    const src = readSrc('apps/web/app/work/shelf-placement-panel.tsx');
    // После confirm ячейки помощник должен видеть крупный read-out
    // «Сканируйте паспорта» и подсказку, что QR ячейки больше не нужны
    // (логи пилота: оператор по привычке снова сканирует ячейку).
    expect(src).toMatch(/Сканируйте паспорта/);
    expect(src).toMatch(/QR ячейки больше сканировать не нужно/);
    // Если оператор всё-таки навёл камеру на QR ячейки в режиме
    // паспортов — детектим префикс `cell:` (ADR-0008) до запроса в
    // backend и показываем понятный текст вместо общего PASSPORT_NOT_FOUND.
    expect(src).toMatch(/startsWith\('cell:'\)/);
    expect(src).toMatch(/Сейчас нужен QR паспорта, а не ячейки/);
    // PASSPORT_ALREADY_PLACED маппится в дружелюбный двухстрочный текст
    // с кодом ячейки + явно упоминаем, что перемещение пока недоступно.
    expect(src).toMatch(/PASSPORT_ALREADY_PLACED/);
    expect(src).toMatch(/Паспорт уже размещён в ячейке/);
    expect(src).toMatch(/Перемещение между ячейками пока недоступно/);
  });

  test('shelf-placement-actions опираются на существующие endpoint-ы (place + by-code)', () => {
    const src = readSrc('apps/web/app/work/shelf-placement-actions.ts');
    expect(src).toMatch(/findCellByCode/);
    expect(src).toMatch(/findPassportByCode/);
    expect(src).toMatch(/placePassport\(/);
    // Action не ломает passport issue flow — это отдельный server-file.
    expect(src).not.toMatch(/issuePassport\(/);
    // Прокидываем backend `code` и контекст ячейки наружу, чтобы UI
    // мог построить дружелюбный текст без повторного запроса в API.
    expect(src).toMatch(/errorCode\?: string/);
    expect(src).toMatch(/placedInCellCode\?: string/);
    expect(src).toMatch(/PASSPORT_ALREADY_PLACED/);
  });

  test('cells/by-code endpoint существует и опирается на findCellByCode', () => {
    const ctrl = readSrc('apps/api/src/modules/passports/cells.controller.ts');
    expect(ctrl).toMatch(/Post\('by-code'\)/);
    expect(ctrl).toMatch(/findCellByCode/);
    const svc = readSrc('apps/api/src/modules/passports/passports.service.ts');
    expect(svc).toMatch(/findCellByCode/);
    // Поддерживаются `cell:{id}` (QR), `code` и голый `id` — как у
    // паспорта (ADR-0008).
    expect(svc).toMatch(/cell:/);
  });

  test('work/page.tsx ставит CUTTER_ASSISTANT на упрощённый путь и подключает SeamstressActionsMenu', () => {
    const src = readSrc('apps/web/app/work/page.tsx');
    expect(src).toMatch(/CutterAssistantWorkPanel/);
    // Проверка по роли стоит раньше, чем общая ветка isActive ниже
    // (см. комментарий в файле). Внутри своей ветки CUTTER_ASSISTANT
    // тоже ходит через `isActive`, но первое попадание в файле — это
    // ровно эта внутренняя проверка.
    const idxRole = src.indexOf("employee.role === 'CUTTER_ASSISTANT'");
    const idxIsActive = src.indexOf('isActive ? (');
    expect(idxRole).toBeGreaterThan(0);
    expect(idxIsActive).toBeGreaterThan(0);
    expect(idxRole).toBeLessThan(idxIsActive);

    // Logout/Stop менюшка для mobile-clean ролей включает CUTTER_ASSISTANT.
    expect(src).toMatch(/SeamstressActionsMenu/);
    expect(src).toMatch(/isCutterAssistant/);
  });

  test('work/page.tsx без активной смены показывает CUTTER_ASSISTANT экран старта смены через SeamstressShiftStart (QR оборудования)', () => {
    const src = readSrc('apps/web/app/work/page.tsx');
    // Помощник раскройщика теперь работает строго в контексте
    // активной смены — как и швея, ОТК, ВТО, упаковка. До старта
    // мы переиспользуем тот же mobile-first scan-driven flow,
    // что и у швеи (`SeamstressShiftStart`), и НЕ показываем сам
    // `<CutterAssistantWorkPanel>`: иначе помощник может попытаться
    // выпустить паспорт без `equipmentId`, и печать упадёт в
    // `SHIFT_SESSION_REQUIRED` (см.
    // `apps/api/src/modules/printers/print-jobs.service.ts`).
    expect(src).toMatch(/SeamstressShiftStart/);
    // Внутри ветки роли есть явный isActive-тернарник: при !isActive
    // рендерится SeamstressShiftStart, при isActive — рабочая панель.
    const cutterBranchStart = src.indexOf(
      "employee.role === 'CUTTER_ASSISTANT' ?",
    );
    expect(cutterBranchStart).toBeGreaterThan(0);
    const cutterBranchEnd = src.indexOf(
      "employee.role === 'SEAMSTRESS' ?",
      cutterBranchStart,
    );
    expect(cutterBranchEnd).toBeGreaterThan(cutterBranchStart);
    const cutterBranch = src.slice(cutterBranchStart, cutterBranchEnd);
    expect(cutterBranch).toMatch(/isActive\s*\?/);
    expect(cutterBranch).toMatch(/<CutterAssistantWorkPanel\s*\/>/);
    expect(cutterBranch).toMatch(/<SeamstressShiftStart\b/);
    // Старого безусловного рендера панели без shift-context быть не должно.
    expect(cutterBranch).not.toMatch(/CutterAssistantWorkPanel\s+canStop=/);
  });
});

describe('legacy /work disabled for QC / IRONING / PACKING', () => {
  test('work/page.tsx делает SSR-редирект в primary workspace до загрузки meta', () => {
    const src = readSrc('apps/web/app/work/page.tsx');
    // Используем ту же матрицу, что и login/корневой `/`.
    expect(src).toMatch(/getPrimaryWorkspace/);
    // Фича «несколько ролей» (18.06.2026): на /work пускаем, если ХОТЯ
    // БЫ одна роль сотрудника может его использовать (primary `/work`
    // или менеджерский `/`). Иначе — серверный redirect в его активный/
    // основной workspace. Логика — флаг `allowsWork`.
    expect(src).toMatch(/allowsWork/);
    expect(src).toMatch(/redirect\(getPrimaryWorkspace\(/);
    // Редирект должен срабатывать ДО любых тяжёлых API-вызовов
    // (`getShiftMeta` / `getCurrentShift`), иначе QC будет дёргать
    // backend ради экрана, который ему не покажется.
    const idxRedirect = src.indexOf('redirect(getPrimaryWorkspace(');
    const idxMeta = src.indexOf('getShiftMeta(');
    const idxCurrentShift = src.indexOf('getCurrentShift(');
    expect(idxRedirect).toBeGreaterThan(0);
    expect(idxMeta).toBeGreaterThan(idxRedirect);
    expect(idxCurrentShift).toBeGreaterThan(idxRedirect);
  });

  test('ROLE_LABELS в work/page.tsx больше не содержит ролей с собственным терминалом', () => {
    const src = readSrc('apps/web/app/work/page.tsx');
    const labelsStart = src.indexOf('const ROLE_LABELS');
    const labelsEnd = src.indexOf('};', labelsStart);
    expect(labelsStart).toBeGreaterThan(0);
    expect(labelsEnd).toBeGreaterThan(labelsStart);
    const labelsBlock = src.slice(labelsStart, labelsEnd);
    // QC / IRONING / PACKING на этот экран больше не приходят
    // (см. SSR-редирект выше) — лишних подписей оставлять не нужно.
    expect(labelsBlock).not.toMatch(/\bQC:/);
    expect(labelsBlock).not.toMatch(/\bIRONING:/);
    expect(labelsBlock).not.toMatch(/\bPACKING:/);
  });

  test('ROLE_LABELS в work/page.tsx показывает CUTTER_ASSISTANT как «Помощник раскройщика» (канон admin-labels)', () => {
    // Регресс-щит для опечатки «Помощник закройщика» (см.
    // `docs/cutter-assistant-passport-release-recon.md §8`):
    // канонический лейбл живёт в `apps/web/lib/admin-labels.ts`.
    // Любая обратная замена ловится в CI.
    const src = readSrc('apps/web/app/work/page.tsx');
    const labelsStart = src.indexOf('const ROLE_LABELS');
    const labelsEnd = src.indexOf('};', labelsStart);
    expect(labelsStart).toBeGreaterThan(0);
    expect(labelsEnd).toBeGreaterThan(labelsStart);
    const labelsBlock = src.slice(labelsStart, labelsEnd);
    expect(labelsBlock).toMatch(
      /CUTTER_ASSISTANT:\s*'Помощник раскройщика'/,
    );
    expect(labelsBlock).not.toMatch(/закройщик/);
    // Канонический словарь должен совпадать по этой роли. Справочник
    // ролей (28.07.2026): названия системных ролей переехали из
    // `apps/web/lib/admin-labels.ts` в `@sewing/shared/app-roles`
    // (`SYSTEM_ROLE_DEFAULTS`) — оттуда же их сидирует миграция.
    const canon = readSrc('packages/shared/src/app-roles.ts');
    const block = canon.slice(
      canon.indexOf('CUTTER_ASSISTANT: {'),
      canon.indexOf('SEAMSTRESS: {'),
    );
    expect(block).toMatch(/name:\s*'Помощник раскройщика'/);
    expect(block).not.toMatch(/закройщик/);
  });

  test('ActiveShiftPanel.Props больше не принимает role (legacy QC-ветка удалена)', () => {
    const src = readSrc('apps/web/app/work/active-shift-panel.tsx');
    const propsStart = src.indexOf('interface Props');
    const propsEnd = src.indexOf('}', propsStart);
    expect(propsStart).toBeGreaterThan(0);
    expect(propsEnd).toBeGreaterThan(propsStart);
    const propsBlock = src.slice(propsStart, propsEnd);
    // Поле было нужно только для исчезнувшей role-specific ветки
    // QC/IRONING/PACKING на /work — теперь оно не используется.
    expect(propsBlock).not.toMatch(/\brole\b/);
    // Сам пропс на месте — без него страница не соберётся.
    expect(propsBlock).toMatch(/shift:\s*ShiftSessionDto/);
  });

  test('QC page по-прежнему рендерит новый QcTerminal, без ActiveShiftPanel', () => {
    const src = readSrc('apps/web/app/qc/page.tsx');
    expect(src).toMatch(/QcTerminal/);
    // Никаких импортов/упоминаний legacy /work панели в /qc быть
    // не должно: это ровно тот «общий рабочий экран», от которого
    // мы уходим.
    expect(src).not.toMatch(/ActiveShiftPanel/);
    expect(src).not.toMatch(/ShiftStartForm/);
    expect(src).not.toMatch(/Получить крой/);
  });

  test('QcTerminal не содержит legacy work-tabs «Получить крой» и не использует старый ShiftStartForm', () => {
    const src = readSrc('apps/web/app/qc/qc-terminal.tsx');
    expect(src).not.toMatch(/Получить крой/);
    expect(src).not.toMatch(/work-tab/);
    // У ОТК тоже есть смена: нужна для backend-инварианта
    // `SHIFT_SESSION_REQUIRED` в `PassportsService.scanOnOperation`
    // (см. `docs/flows.md §F5`). Поэтому терминал реюзает тот же
    // `SeamstressShiftStart`, что и швея/упаковщик. Кнопка
    // «Завершить смену» живёт в общем `SeamstressActionsMenu` (как
    // у `/work` и `/packing`), а не как большая красная кнопка прямо
    // на терминале — поэтому inline-`<button>Завершить смену</button>`
    // здесь по-прежнему быть не должно. Но импорт меню легально
    // упоминает компонент, поэтому regex прижат к JSX-контексту.
    expect(src).not.toMatch(/<button[^>]*>\s*Завершить смену/);
    // Старый ShiftStartForm (полный list-pick UI для менеджера) на
    // /qc не используется — мы реюзаем mobile-first SeamstressShiftStart.
    expect(src).not.toMatch(/ShiftStartForm/);
  });
});

describe('cutter-assistant header visibility', () => {
  test('app-header.tsx прячет тёмный header для CUTTER_ASSISTANT на /work* и /orders/:id/passports/new', () => {
    const src = readSrc('apps/web/components/app-header.tsx');
    expect(src).toMatch(/role === 'CUTTER_ASSISTANT'/);
    // Условие включает /work* (через usePathname) и шаблон страницы
    // выпуска паспорта.
    expect(src).toMatch(/\/work/);
    // Шаблон пути выпуска паспорта зафиксирован константой
    // `PASSPORT_NEW_RE` — её и проверяем по подстроке, чтобы не
    // дублировать regex-эскейпинг в тесте.
    expect(src).toContain('PASSPORT_NEW_RE');
    expect(src).toContain('/orders/');
    expect(src).toContain('/passports/new');
    // Старое поведение для SEAMSTRESS не сломалось.
    expect(src).toMatch(/role === 'SEAMSTRESS'/);
  });
});

describe('cutter-assistant simplified order picker', () => {
  test('/work/cut-orders существует и опирается на listOrders + IN_PRODUCTION', () => {
    const src = readSrc('apps/web/app/work/cut-orders/page.tsx');
    expect(src).toMatch(/listOrders/);
    expect(src).toMatch(/status: 'IN_PRODUCTION'/);
    // Авто-редирект при единственном заказе.
    expect(src).toMatch(
      /items\.length === 1[\s\S]*redirect\(`\/orders\/\$\{items\[0\]\.id\}\/passports\/new`\)/,
    );
    // Empty-state, когда заказов нет.
    expect(src).toMatch(/Нет заказов на раскрое/);
    // Карточка ведёт на ту же форму выпуска паспорта.
    expect(src).toMatch(/\/orders\/\$\{o\.id\}\/passports\/new/);
  });

  test('новая форма выпуска паспорта возвращает CUTTER_ASSISTANT обратно на /work', () => {
    const src = readSrc('apps/web/app/orders/[id]/passports/new/page.tsx');
    expect(src).toMatch(/isCutterAssistant/);
    expect(src).toMatch(/На рабочее место/);
    expect(src).toMatch(/getCurrentUserOrNull/);
  });

  test('createPassportAction принимает mode (redirect|inline) и поддерживает closure.kind="skipped"', () => {
    // Контракт server action: режим post-success-поведения
    // прокидывается через `bind()` со страницы (а не из FormData),
    // чтобы клиент не мог его подменить. Для menu-пользователей
    // mode='redirect' (старое поведение, redirect на
    // `/passports/[id]`). Для CUTTER_ASSISTANT — mode='inline',
    // server action возвращает success без редиректа, и UI
    // показывает компактный пост-релизный блок.
    const src = readSrc('apps/web/app/orders/[id]/passports/actions.ts');
    expect(src).toMatch(/export type CreatePassportMode/);
    expect(src).toMatch(/'redirect'/);
    expect(src).toMatch(/'inline'/);
    // Сигнатура action: orderId, productId, mode, _prev, form.
    expect(src).toMatch(
      /createPassportAction\([\s\S]*?orderId: string,[\s\S]*?productId: string \| null,[\s\S]*?mode: CreatePassportMode/,
    );
    // success теперь несёт snapshot для компактного блока.
    expect(src).toMatch(/qtyCut: number/);
    expect(src).toMatch(/rollNumber: string/);
    // closure ветка 'skipped' — это inline-режим без чекбокса
    // «Подать заявку на закрытие раскроя».
    expect(src).toMatch(/kind: 'skipped'/);
    // Между ветками: для inline без closure НЕ редиректим.
    expect(src).toMatch(
      /if \(mode === 'inline'\)[\s\S]*?closure: \{ kind: 'skipped' \}/,
    );
  });

  test('NewPassportForm у CUTTER_ASSISTANT показывает компактный пост-релизный блок (печать + Выпустить следующий)', () => {
    const src = readSrc(
      'apps/web/app/orders/[id]/passports/new/new-passport-form.tsx',
    );
    // Проп `isCutterAssistant` обязателен и приходит сверху —
    // источник истины для режима. На клиенте также используется как
    // `mode = isCutterAssistant ? 'inline' : 'redirect'`.
    expect(src).toMatch(/isCutterAssistant: boolean/);
    expect(src).toMatch(
      /isCutterAssistant \? 'inline' : 'redirect'/,
    );
    // Компактный success-блок и его тексты — как в ТЗ
    // («упрощение UX помощника раскройщика», см. docs/screens.md §7.5).
    expect(src).toMatch(/CutterAssistantSuccessCard/);
    expect(src).toMatch(/Паспорт \{passport\.number\} выпущен\./);
    expect(src).toMatch(/label="Распечатать паспорт"/);
    expect(src).toMatch(/Выпустить следующий/);
    // «Распечатать» — переиспользуем общий PrintButton (а не свой),
    // и рассчитываем fallback на печатную HTML-форму так же, как на
    // /passports/[id].
    expect(src).toMatch(/import \{ PrintButton \}/);
    expect(src).toMatch(/sourceType="PASSPORT_PRINT"/);
    expect(src).toMatch(/buildPassportPrintPath\(passport\.id\)/);
    // «Выпустить следующий» сбрасывается через key-bump во внешней
    // обёртке (useFormState reset недоступен иначе).
    expect(src).toMatch(/onIssueAnother/);
    expect(src).toMatch(/key=\{iteration\}/);
    // Большая карточка `/passports/[id]` остаётся доступной по
    // прямой ссылке — но не как primary action.
    expect(src).toMatch(/\/passports\/\$\{passport\.id\}/);
  });
});

describe('QC scan-driven terminal (/qc)', () => {
  test('apps/web/app/qc/page.tsx — server-component-обёртка над QcTerminal', () => {
    const src = readSrc('apps/web/app/qc/page.tsx');
    // Терминал — единственное окно ОТК; никаких списков паспортов
    // на /qc больше нет.
    expect(src).toMatch(/QcTerminal/);
    expect(src).toMatch(/RoleHeaderCard/);
    expect(src).toMatch(/listDefectTypes/);
    expect(src).not.toMatch(/listQcPassports/);
  });

  test('apps/web/app/qc/qc-terminal.tsx — scan + lookup + complete', () => {
    const src = readSrc('apps/web/app/qc/qc-terminal.tsx');
    // QR-сканер — тот же, что у швеи на /work.
    expect(src).toMatch(/QrScannerModal/);
    // Резолв и действия — server actions, экспортируемые из
    // apps/web/app/qc/actions.ts.
    expect(src).toMatch(/lookupQcPassportAction/);
    expect(src).toMatch(/recordDefectAction/);
    expect(src).toMatch(/completeQcAction/);
    // Звуковой и тактильный фидбек переиспользуем из /work.
    expect(src).toMatch(/playOperationCompletedSound/);
    expect(src).toMatch(/playCutAcceptedSound/);
    // «Выйти» / «Завершить смену» теперь живут в общем
    // SeamstressActionsMenu (как у швеи и упаковщика) — глобальный
    // header на /qc у роли QC скрыт. Inline-форма logoutAction
    // больше не нужна.
    expect(src).toMatch(/SeamstressActionsMenu/);
  });

  test('AppHeader скрыт у роли QC на /qc', () => {
    const src = readSrc('apps/web/components/app-header.tsx');
    expect(src).toMatch(/role === 'QC'/);
    expect(src).toMatch(/hideForQc/);
  });
});

describe('Packing scan-driven terminal (/packing)', () => {
  test('apps/web/app/packing/page.tsx ветвится по роли: PACKING → PackingTerminal, остальные → список', () => {
    const src = readSrc('apps/web/app/packing/page.tsx');
    expect(src).toMatch(/PackingTerminal/);
    expect(src).toMatch(/RoleHeaderCard/);
    // PACKING сразу попадает в терминал (никакого списка коробок),
    // SHOP_MANAGER/ADMIN — в управленческий список.
    expect(src).toMatch(/me\.user\.role === 'PACKING'/);
    expect(src).toMatch(/listBoxes/);
  });

  test('apps/web/app/packing/packing-terminal.tsx — scan-driven flow «открой смену → создай коробку → сканируй → закрой»', () => {
    const src = readSrc('apps/web/app/packing/packing-terminal.tsx');
    // Те же камеры/звуки, что у швеи и ОТК.
    expect(src).toMatch(/QrScannerModal/);
    expect(src).toMatch(/playCutAcceptedSound/);
    expect(src).toMatch(/playOperationCompletedSound/);
    // Старт смены реиспользует existing seamstress-flow.
    expect(src).toMatch(/SeamstressShiftStart/);
    expect(src).toMatch(/SeamstressActionsMenu/);
    // Все три client-action завязаны на терминале.
    expect(src).toMatch(/createBoxTerminalAction/);
    expect(src).toMatch(/scanPassportToBoxAction/);
    expect(src).toMatch(/closeBoxTerminalAction/);
  });

  test('apps/web/app/packing/actions.ts экспортирует client-actions для scan-driven терминала', () => {
    const src = readSrc('apps/web/app/packing/actions.ts');
    expect(src).toMatch(/export async function createBoxTerminalAction/);
    expect(src).toMatch(/export async function scanPassportToBoxAction/);
    expect(src).toMatch(/export async function closeBoxTerminalAction/);
    expect(src).toMatch(/export async function getActiveBoxAction/);
    // Старые form-actions для legacy-страниц должны остаться.
    expect(src).toMatch(/export async function createBoxAction/);
    expect(src).toMatch(/export async function addPassportToBoxAction/);
    expect(src).toMatch(/export async function closeBoxAction/);
  });

  test('AppHeader скрыт у роли PACKING на /packing', () => {
    const src = readSrc('apps/web/components/app-header.tsx');
    expect(src).toMatch(/role === 'PACKING'/);
    expect(src).toMatch(/hideForPacking/);
  });
});

describe('Packing earnings approval timing (ADR-0005)', () => {
  test('PackingService.addPassport больше НЕ апрувит начисления — это делает close', () => {
    const src = readSrc('apps/api/src/modules/packing/packing.service.ts');
    // close() должен вызывать approvePendingForPassport для каждого
    // элемента коробки.
    const closeStart = src.indexOf('async close(');
    const closeEnd = src.indexOf('// INTERNAL', closeStart);
    expect(closeStart).toBeGreaterThan(0);
    expect(closeEnd).toBeGreaterThan(closeStart);
    const closeBlock = src.slice(closeStart, closeEnd);
    expect(closeBlock).toMatch(/approvePendingForPassport/);
    expect(closeBlock).toMatch(/boxItem\.findMany/);

    // addPassport не должен больше делать апрув начислений.
    const addStart = src.indexOf('async addPassport(');
    const addEnd = src.indexOf('// CLOSE', addStart);
    expect(addStart).toBeGreaterThan(0);
    expect(addEnd).toBeGreaterThan(addStart);
    const addBlock = src.slice(addStart, addEnd);
    expect(addBlock).not.toMatch(/approvePendingForPassport/);
  });
});

// Старый блок `homepage tile visibility` удалён вместе с tile-сеткой
// на `/`. После auth-design-cleanup-а корневая страница — pure
// redirect (см. `apps/web/app/page.tsx` и
// `docs/auth-design-cleanup-recon.md §3, §7`); ассерты на тайлы и
// `*Menu`-хелперы внутри `/page.tsx` потеряли смысл. Поведение
// корня закрепляется в `tests/smoke/auth-design-cleanup.smoke.test.ts`.

describe('frontend nav-visibility helpers fed into layout / mobile-nav', () => {
  test('apps/web/app/layout.tsx прокидывает show-флаги в MobileNav', () => {
    const src = readSrc('apps/web/app/layout.tsx');
    expect(src).toMatch(/canSeeQc/);
    expect(src).toMatch(/canSeePacking/);
    // Для меню используется именно `canSeeOrdersMenu` (исключает
    // CUTTER_ASSISTANT), а не технический `canSeeOrders`.
    expect(src).toMatch(/canSeeOrdersMenu/);
    expect(src).not.toMatch(/canSeeOrders\(/);
    expect(src).toMatch(/canSeeShopfloorMenu/);
    // «Главная» и «Работа» теперь тоже под флагами — модель «одно
    // рабочее окно на роль».
    expect(src).toMatch(/canSeeHome/);
    expect(src).toMatch(/canSeeWorkTab/);
    expect(src).toMatch(/isSingleWorkspaceRole/);
    expect(src).toMatch(/showQc && <Link href="\/qc"/);
    expect(src).toMatch(/showPacking && <Link href="\/packing"/);
    expect(src).toMatch(/showOrders && <Link href="\/orders"/);
    // «Рабочее место» в шапке теперь только для тех, у кого
    // `canSeeWorkTab` true (по факту — менеджеры/админ).
    expect(src).toMatch(/showWork && <Link href="\/work"/);
    // «Цех» теперь под флагом и тоже скрыт у CUTTER_ASSISTANT.
    expect(src).toMatch(/showShopfloor && <Link href="\/shopfloor"/);
    // MobileNav скрыт целиком для single-workspace ролей.
    expect(src).toMatch(/isStaff && !singleWorkspace/);
  });

  test('apps/web/components/mobile-nav.tsx скрывает запрещённые пункты', () => {
    const src = readSrc('apps/web/components/mobile-nav.tsx');
    expect(src).toMatch(/showHome/);
    expect(src).toMatch(/showWork/);
    expect(src).toMatch(/showQc/);
    expect(src).toMatch(/showWto/);
    expect(src).toMatch(/showPacking/);
    expect(src).toMatch(/showOrders/);
    expect(src).toMatch(/if \(showQc\) items.push\(QC_ITEM\)/);
    expect(src).toMatch(/if \(showWto\) items.push\(WTO_ITEM\)/);
    expect(src).toMatch(/if \(showHome\) items.push\(HOME_ITEM\)/);
    expect(src).toMatch(/if \(showWork\) items.push\(WORK_ITEM\)/);
    // Если все пункты выключены — компонент молча не рендерится.
    expect(src).toMatch(/items\.length === 0/);
  });
});

describe('primary workspace per role (one terminal per role)', () => {
  test('getPrimaryWorkspace отдаёт корректный route по матрице из ТЗ', () => {
    expect(getPrimaryWorkspace('SEAMSTRESS')).toBe('/work');
    expect(getPrimaryWorkspace('CUTTER_ASSISTANT')).toBe('/work');
    expect(getPrimaryWorkspace('CUTTER')).toBe('/work');
    // ВТО, как и ОТК, теперь полноценный role-terminal: scan-driven
    // экран `/wto` (см. apps/web/app/wto/wto-terminal.tsx и
    // docs/flows.md §F6, ADR-0013 §«WTO_DONE»).
    expect(getPrimaryWorkspace('IRONING')).toBe('/wto');
    expect(getPrimaryWorkspace('QC')).toBe('/qc');
    expect(getPrimaryWorkspace('PACKING')).toBe('/packing');
    expect(getPrimaryWorkspace('SHOP_MANAGER')).toBe('/');
    expect(getPrimaryWorkspace('ADMIN')).toBe('/');
  });

  test('getPrimaryWorkspace для пустой/неизвестной роли — корень', () => {
    expect(getPrimaryWorkspace(undefined)).toBe('/');
    expect(getPrimaryWorkspace(null)).toBe('/');
    expect(getPrimaryWorkspace('')).toBe('/');
    expect(getPrimaryWorkspace('UNKNOWN_ROLE')).toBe('/');
  });

  test('isSingleWorkspaceRole — SEAMSTRESS, CUTTER_ASSISTANT, QC, IRONING и PACKING', () => {
    // QC, IRONING и PACKING попадают сюда после редизайна
    // `/qc` / `/wto` / `/packing` в scan-driven терминалы
    // (см. apps/web/app/qc/qc-terminal.tsx,
    // apps/web/app/wto/wto-terminal.tsx,
    // apps/web/app/packing/packing-terminal.tsx и
    // docs/screens.md §5/§5a/§6).
    const single = ALL_ROLES.filter((r) => isSingleWorkspaceRole(r));
    expect(single.sort()).toEqual([
      'CUTTER_ASSISTANT',
      'IRONING',
      'PACKING',
      'QC',
      'SEAMSTRESS',
    ]);
    expect(isSingleWorkspaceRole(undefined)).toBe(false);
    expect(isSingleWorkspaceRole('UNKNOWN_ROLE')).toBe(false);
  });

  test('isWorkingRole — все производственные, кроме менеджеров/админа', () => {
    const working = ALL_ROLES.filter((r) => isWorkingRole(r));
    expect(working.sort()).toEqual(
      [
        'CUTTER',
        'CUTTER_ASSISTANT',
        'IRONING',
        'PACKING',
        'QC',
        'SEAMSTRESS',
      ].sort(),
    );
    expect(isWorkingRole('ADMIN')).toBe(false);
    expect(isWorkingRole('SHOP_MANAGER')).toBe(false);
  });

  test('canSeeHome — скрыт для всех рабочих ролей, виден менеджерам и админу', () => {
    const allowed = ALL_ROLES.filter((r) => canSeeHome(r));
    expect(allowed.sort()).toEqual(['ADMIN', 'SHOP_MANAGER']);
    // SEAMSTRESS и CUTTER_ASSISTANT — обязательный минимум из ТЗ.
    expect(canSeeHome('SEAMSTRESS')).toBe(false);
    expect(canSeeHome('CUTTER_ASSISTANT')).toBe(false);
    expect(canSeeHome(undefined)).toBe(false);
  });

  test('canSeeWorkTab — только ADMIN (рабочее место в меню не показываем менеджеру)', () => {
    const allowed = ALL_ROLES.filter((r) => canSeeWorkTab(r));
    // SHOP_MANAGER исключён сознательно: терминал швеи в меню
    // начальника цеха не нужен. Технический доступ к `/work`
    // у роли остаётся (страница и backend не закрыты этим UI-флагом).
    expect(allowed.sort()).toEqual(['ADMIN']);
    expect(canSeeWorkTab('SHOP_MANAGER')).toBe(false);
    // У SEAMSTRESS и CUTTER_ASSISTANT нет дублирующей вкладки «Работа».
    expect(canSeeWorkTab('SEAMSTRESS')).toBe(false);
    expect(canSeeWorkTab('CUTTER_ASSISTANT')).toBe(false);
    expect(canSeeWorkTab('CUTTER')).toBe(false);
    expect(canSeeWorkTab('IRONING')).toBe(false);
    expect(canSeeWorkTab('QC')).toBe(false);
    expect(canSeeWorkTab('PACKING')).toBe(false);
    expect(canSeeWorkTab(undefined)).toBe(false);
  });
});

describe('login redirect uses safeReturnTo + getDefaultRouteForRole', () => {
  test('apps/web/app/login/actions.ts использует safeReturnTo (не getPrimaryWorkspace напрямую)', () => {
    const src = readSrc('apps/web/app/login/actions.ts');
    // После auth-design-cleanup-а login action делегирует роутинг
    // единому `safeReturnTo` (см. `apps/web/lib/safe-return-to.ts`),
    // который сам зовёт `getDefaultRouteForRole`. Старый ручной
    // `next === '/'` + `getPrimaryWorkspace(role)` больше не нужен.
    expect(src).toMatch(/safeReturnTo/);
    expect(src).not.toMatch(/getPrimaryWorkspace/);
    // Старого «hard-coded» fallback на `/` тоже не должно остаться.
    expect(src).not.toMatch(/redirect\(next\.startsWith/);
  });

  test('apps/web/app/login/page.tsx редиректит уже залогиненного через safeReturnTo', () => {
    const src = readSrc('apps/web/app/login/page.tsx');
    expect(src).toMatch(/safeReturnTo/);
    expect(src).not.toMatch(/getPrimaryWorkspace/);
  });
});

describe('root / pure redirect (no legacy intermediate dashboard)', () => {
  test('apps/web/app/page.tsx — pure redirect через getDefaultRouteForRole', () => {
    const src = readSrc('apps/web/app/page.tsx');
    // Для anon — `/login`, для залогиненного — role-based redirect
    // через единый helper. Никаких tile-grid/MobileActionCard и
    // никаких ветвлений по working-role внутри страницы.
    expect(src).toMatch(/redirect\('\/login'\)/);
    expect(src).toMatch(/getDefaultRouteForRole/);
    expect(src).not.toMatch(/MobileActionCard/);
    expect(src).not.toMatch(/isWorkingRole/);
    // Helper-возврат `/` запрещён (см. `lib/role-redirect.ts`), но
    // дополнительная страховка — никаких inline `redirect('/')` в
    // самой странице.
    expect(src).not.toMatch(/redirect\('\/'\)/);
  });
});
