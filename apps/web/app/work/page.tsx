import { redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import {
  getCurrentShift,
  getCurrentWork,
  getCutIssueBanner,
  getShiftMeta,
} from '@/lib/shifts-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { getPrimaryWorkspace } from '@/lib/rbac';
import { RoleHeaderCard } from '@/components/role-header-card';
import { ShiftStartForm } from './shift-start-form';
import {
  ActiveShiftPanel,
  CutterAssistantWorkPanel,
} from './active-shift-panel';
import { SeamstressShiftStart } from './seamstress-shift-start';
import { SeamstressActivePanel } from './seamstress-active-panel';
import { SeamstressActionsMenu } from './seamstress-actions-menu';

export const dynamic = 'force-dynamic';

/**
 * Подписи ролей для шапки `/work`. Сюда попадают только те роли,
 * которые реально могут оказаться на этом экране после
 * primary-workspace-редиректа ниже: швея, помощник раскройщика,
 * раскройщик и менеджеры/админ. QC/IRONING/PACKING сюда не
 * приходят — у них собственные scan-driven терминалы (`/qc`,
 * `/wto`, `/packing`), а `/work` для этих ролей делает
 * server-side redirect в их primary workspace (см. ниже и
 * `apps/web/lib/rbac.ts`).
 */
const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SHOP_MANAGER: 'Начальник цеха',
  CUTTER: 'Раскройщик',
  CUTTER_ASSISTANT: 'Помощник раскройщика',
  SEAMSTRESS: 'Швея',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Аккуратный загрузчик «текущего кроя» для блока в seamstress flow.
 *
 * Если бэкенд недоступен или вернул бизнес-ошибку — отдадим пустой
 * список, чтобы не уронить весь экран /work из-за вспомогательного
 * блока (основные кнопки «Взять крой / Завершить смену» должны
 * остаться). Сама ошибка уйдёт в логи Next.
 */
async function loadCurrentWorkSafely() {
  try {
    return await getCurrentWork();
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    return [];
  }
}

/**
 * Безопасно подгружает подсказку «Очередь выдачи кроя» для
 * seamstress-баннера. Если backend недоступен или вернул бизнес-
 * ошибку — отдаём `applicable = false`, баннер не рендерится, а
 * основной flow «Взять крой» остаётся работоспособным (реальная
 * защита очереди всё равно сработает на бэке при `acceptForIssue`).
 */
async function loadCutIssueBannerSafely(operationId: string) {
  try {
    return await getCutIssueBanner(operationId);
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    return { applicable: false, orders: [] };
  }
}

export default async function WorkPage() {
  // Middleware уже редиректит анонимов — но проверяем повторно ради
  // явного fail-safe: если cookie утратила валидность между middleware
  // и SSR (TTL истёк, ротация JWT_SECRET и т.п.), не отдаём пустой UI.
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/work');

  // Модель «одно рабочее окно на роль» (см. `apps/web/lib/rbac.ts`,
  // `docs/screens.md §1.1`): для ролей, у которых primary workspace
  // — это не `/work` и не корень (QC → `/qc`, IRONING → `/wto`,
  // PACKING → `/packing`), `/work` показывать нельзя. Иначе они
  // вручную (или по старой закладке) попадают в legacy-экран швеи
  // с табами «Получить крой / Сканировать паспорт» и кнопкой
  // «Завершить смену» — это полностью посторонний UI для их
  // pipeline. Делаем server-side редирект в их собственный
  // терминал; backend всё равно режет операции по `@Roles(...)`,
  // но мы убираем сам шанс увидеть чужой экран.
  const primary = getPrimaryWorkspace(me.user.role);
  if (primary !== '/work' && primary !== '/') {
    redirect(primary);
  }

  const meta = await getShiftMeta();
  let currentShift = null;
  try {
    currentShift = await getCurrentShift();
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
  }

  const employee = meta.employees.find((e) => e.id === me.user.id) ?? {
    id: me.user.id,
    login: me.user.login,
    fullName: me.user.fullName,
    role: me.user.role,
  };

  const roleLabel = ROLE_LABELS[employee.role] ?? employee.role;
  const isActive = !!(currentShift && currentShift.active);

  const headerFields = isActive
    ? [
        {
          label: 'Операция',
          value: currentShift!.operationName,
          meta: currentShift!.operationCode,
        },
        {
          label: 'Оборудование',
          value: currentShift!.equipmentName,
          meta: currentShift!.equipmentCode,
        },
      ]
    : [];

  const isSeamstress = employee.role === 'SEAMSTRESS';
  const isCutterAssistant = employee.role === 'CUTTER_ASSISTANT';
  // Обе роли получают «mobile clean» режим /work без верхнего меню
  // (см. `components/app-header.tsx`). Поэтому им нужны:
  //   - тот же `work--seamstress` модификатор для safe-area отступа
  //     сверху;
  //   - то же три-точечное меню `SeamstressActionsMenu` справа сверху,
  //     где спрятаны редкие/опасные действия (Завершить смену, Выйти).
  const useMobileCleanWork = isSeamstress || isCutterAssistant;

  return (
    <div className={`work${useMobileCleanWork ? ' work--seamstress' : ''}`}>
      {useMobileCleanWork && (
        // Logout вынесен сюда, потому что для этих ролей глобальный
        // `<AppHeader>` на /work* не рендерится. «Завершить смену»
        // показывается только если сейчас активна смена. Для
        // CUTTER_ASSISTANT теперь это нормальный путь: рабочий экран
        // открывается только после старта смены через QR
        // оборудования (см. блок ниже).
        <SeamstressActionsMenu shiftActive={isActive} />
      )}
      <RoleHeaderCard
        name={employee.fullName}
        role={roleLabel}
        fields={headerFields}
        shiftActive={isActive}
        statusText={
          isActive
            ? `Смена с ${formatTime(currentShift!.startedAt)}`
            : 'Смена не начата'
        }
      />

      {employee.role === 'CUTTER_ASSISTANT' ? (
        // Помощник раскройщика теперь работает строго в контексте
        // активной смены на оборудовании — как и остальные рабочие
        // роли (см. `docs/flows.md §F2`, `docs/screens.md §3`). Это
        // нужно для печати: print-job выбирает принтер по
        // `equipmentId` активной смены (см.
        // `apps/api/src/modules/printers/print-jobs.service.ts`,
        // `resolvePrinter`), без смены он бы валился в
        // `SHIFT_SESSION_REQUIRED`.
        //
        // Перед стартом — переиспользуем `SeamstressShiftStart`: тот
        // же mobile-first scan-driven flow «QR оборудования →
        // выбор разрешённой операции → подтверждение» (ADR-0017,
        // источник истины — `EquipmentOperation`). Никакого
        // отдельного экрана не плодим.
        //
        // После старта — рендерим стандартный `<CutterAssistantWorkPanel>`
        // с двумя действиями («Выпустить паспорт» / «Разместить на
        // стеллаж»). Кнопка «Завершить смену» по-прежнему живёт в
        // три-точечном меню `SeamstressActionsMenu` сверху.
        isActive ? (
          <CutterAssistantWorkPanel />
        ) : (
          <SeamstressShiftStart meta={meta} employee={employee} />
        )
      ) : employee.role === 'SEAMSTRESS' ? (
        // Швея = mobile-first однокнопочный flow: перед стартом смены
        // QR оборудования + выбор операции из allow-листа этого
        // станка; после старта — устойчивый блок «Текущий крой» +
        // одна primary-кнопка «Взять (следующий) крой» с модалкой
        // проверки паспорта (см. ТЗ §1–§6, ADR-0014).
        isActive ? (
          await (async () => {
            const [currentWork, cutIssueBanner] = await Promise.all([
              loadCurrentWorkSafely(),
              loadCutIssueBannerSafely(currentShift!.operationId),
            ]);
            return (
              <SeamstressActivePanel
                shift={currentShift!}
                currentWork={currentWork}
                cutIssueBanner={cutIssueBanner}
              />
            );
          })()
        ) : (
          <SeamstressShiftStart meta={meta} employee={employee} />
        )
      ) : isActive ? (
        <ActiveShiftPanel shift={currentShift!} />
      ) : (
        <ShiftStartForm meta={meta} employee={employee} />
      )}
    </div>
  );
}
