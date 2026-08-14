import { redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { getActiveWorkplaceLabel } from '@/lib/rbac';
import { listDefectTypes, listQcIncomingReworks } from '@/lib/qc-api';
import {
  getCurrentShift,
  getCurrentWork,
  getShiftMeta,
} from '@/lib/shifts-api';
import { operationsForEquipment } from '@/lib/equipment-operations';
import { isQtyCorrectionEnabled } from '@/lib/feature-flags';
import { TerminalShell } from '@/components/terminal-shell';
import { QcTerminal } from './qc-terminal';

export const dynamic = 'force-dynamic';

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * QC primary workspace — scan-driven терминал по той же модели, что
 * `/work` для швеи (см. `apps/web/app/work/seamstress-active-panel.tsx`).
 *
 * Страница подтягивает справочник видов брака, профиль сотрудника и
 * shift-meta/current-shift — точно так же, как это делает
 * `/packing/page.tsx` для упаковщика. Без активной смены любой
 * `POST /api/passports/:id/scan` от имени ОТК упирался бы в
 * `SHIFT_SESSION_REQUIRED` (см. `PassportsService.scanOnOperation`,
 * `docs/flows.md §F5`), поэтому прежний экран «один большой
 * Сканировать паспорт» без shift-flow был фактически нерабочим:
 * у роли QC нет другой страницы, где бы она могла стартовать смену
 * (`/work` редиректит в `/qc`, см. `getPrimaryWorkspace`).
 *
 * Вся интерактивная логика — в client-компоненте `QcTerminal`:
 *   - нет активной смены → reuse-форма `SeamstressShiftStart`
 *     (QR оборудования + выбор разрешённой операции, см. ADR-0017);
 *   - смена есть, но не на QC-операции → банер «не на ОТК» с
 *     подсказкой завершить смену через меню;
 *   - смена есть и категория `QC` → прежний scan-driven терминал.
 *
 * Поведение и инварианты — `docs/screens.md §5` и `docs/flows.md §F5`.
 */
export default async function QcPage() {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/qc');

  const [defectTypes, meta] = await Promise.all([
    listDefectTypes(),
    getShiftMeta(),
  ]);

  // Источник истины «есть ли активная смена» — backend, см.
  // `ShiftsService.getCurrent`. fail-soft на ApiRequestError, чтобы
  // временный сбой `GET /shifts/current` не превращал весь /qc в
  // экран ошибки: терминал просто покажет start-shift UI, и при
  // следующем запросе всё выровняется.
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

  const operation = currentShift
    ? meta.operations.find((o) => o.id === currentShift.operationId) ?? null
    : null;
  const activeOperationCategory = operation?.category ?? null;
  const isShiftActive = !!(currentShift && currentShift.active);

  // Список «вернули на повторную проверку» — для баннера над сканером.
  // Тянем только при активной QC-смене, иначе бэк всё равно вернёт
  // пустой список. fail-soft на ApiRequestError, чтобы временный сбой
  // не превращал терминал в экран ошибки.
  let incomingReworks: Awaited<
    ReturnType<typeof listQcIncomingReworks>
  >['items'] = [];
  if (isShiftActive && activeOperationCategory === 'QC') {
    try {
      const res = await listQcIncomingReworks();
      incomingReworks = res.items;
    } catch (e) {
      if (!(e instanceof ApiRequestError)) throw e;
    }
  }

  // Паспорта, которые ОТК уже взяла в работу сканом, но ещё не закрыла
  // («Проверка выполнена» снимает владельца, см. `QcService.completeQc`).
  // До этого `/qc` держал открытый паспорт ТОЛЬКО в client-state
  // терминала: после F5, разряженного телефона или возврата в кабинет
  // экран показывал чистую кнопку «Сканировать паспорт», хотя паспорт
  // числился за ОТК. Всплыло это на смене операции — backend режет
  // переключение с `SHIFT_HAS_ACTIVE_PASSPORTS`, а найти «зависший»
  // паспорт в кабинете было негде. Источник тот же, что у швеи на
  // `/work`, и ровно тот же набор, что проверяет
  // `ShiftsService.switchOperation`. fail-soft: список — подсказка, а не
  // условие работы терминала.
  let passportsInWork: Awaited<ReturnType<typeof getCurrentWork>> = [];
  if (isShiftActive) {
    try {
      passportsInWork = await getCurrentWork();
    } catch (e) {
      if (!(e instanceof ApiRequestError)) throw e;
    }
  }

  const headerFields = isShiftActive
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

  // Операции, разрешённые на рабочем месте текущей смены
  // (`EquipmentOperation`, ADR-0017). Если их 2+ — терминал отрендерит
  // chip «Сменить операцию», и ОТК перейдёт с межоперационной проверки
  // на финальную не завершая смену и не пересканируя стол: рабочее
  // место-то одно и то же. Считаем ровно как `/work/page.tsx` и
  // `/packing/page.tsx`, через общий хелпер.
  const currentEquipment = currentShift
    ? meta.equipment.find((e) => e.id === currentShift.equipmentId) ?? null
    : null;
  const availableOperations = currentEquipment
    ? operationsForEquipment(currentEquipment, meta.operations)
    : [];

  const roleLabel = getActiveWorkplaceLabel(me.user);

  return (
    <TerminalShell
      name={employee.fullName}
      role={roleLabel}
      fields={headerFields}
      shiftActive={isShiftActive}
      statusText={
        isShiftActive
          ? `Смена с ${formatTime(currentShift!.startedAt)}`
          : 'Смена не начата — отсканируйте QR рабочего места ОТК'
      }
    >
      <QcTerminal
        defectTypes={defectTypes}
        meta={meta}
        employee={employee}
        initialShift={currentShift}
        activeOperationCategory={activeOperationCategory}
        availableOperations={availableOperations}
        passportsInWork={passportsInWork}
        incomingReworks={incomingReworks}
        qtyCorrectionEnabled={isQtyCorrectionEnabled()}
      />
    </TerminalShell>
  );
}
