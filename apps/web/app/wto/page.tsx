import { redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { getActiveWorkplaceLabel } from '@/lib/rbac';
import {
  getCurrentShift,
  getCurrentWork,
  getShiftMeta,
} from '@/lib/shifts-api';
import { operationsForEquipment } from '@/lib/equipment-operations';
import { TerminalShell } from '@/components/terminal-shell';
import { WtoTerminal } from './wto-terminal';

export const dynamic = 'force-dynamic';

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/**
 * WTO primary workspace — scan-driven терминал по той же модели, что
 * `/qc` для ОТК (см. `apps/web/app/qc/qc-terminal.tsx`).
 *
 * Страница SSR-подтягивает профиль сотрудника, `getShiftMeta()` и
 * `getCurrentShift()` — точно так же, как это делает `/qc/page.tsx`
 * и `/packing/page.tsx`. Без активной смены любой
 * `POST /api/passports/:id/scan` от имени ВТО упирался бы в
 * `SHIFT_SESSION_REQUIRED` (см. `PassportsService.scanOnOperation`,
 * `docs/flows.md §F6`), поэтому прежний экран «один большой
 * Сканировать паспорт» без shift-flow был фактически нерабочим:
 * у роли IRONING нет другой страницы, где она могла бы стартовать
 * смену (`/work` редиректит в `/wto`, см. `getPrimaryWorkspace`).
 *
 * Вся интерактивная логика — в client-компоненте `WtoTerminal`:
 *   - нет активной смены → reuse-форма `SeamstressShiftStart`
 *     (QR оборудования + выбор разрешённой операции, см. ADR-0017);
 *   - смена есть, но не на IRONING-операции → банер «не на ВТО» с
 *     подсказкой завершить смену через меню;
 *   - смена есть и категория `IRONING` → прежний scan-driven терминал.
 *
 * Поведение и инварианты — `docs/screens.md §5a` и `docs/flows.md §F6`.
 */
export default async function WtoPage() {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/wto');

  const meta = await getShiftMeta();

  // Источник истины «есть ли активная смена» — backend, см.
  // `ShiftsService.getCurrent`. fail-soft на ApiRequestError, чтобы
  // временный сбой `GET /shifts/current` не превращал весь /wto в
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

  // Операции рабочего места текущей смены (`EquipmentOperation`,
  // ADR-0017) и паспорта, которые числятся за сотрудником и ещё не
  // закрыты — ровно та же пара, что на `/qc`. Первое кормит chip
  // «Сменить операцию» (2+ операций на столе — переключаемся, не
  // пересканируя стол), второе не даёт паспорту стать невидимым после
  // перезагрузки: рабочая карточка ВТО живёт в client-state, а
  // владельца снимает только «Завершить ВТО» (`WtoService.completeWto`).
  // fail-soft: списки — подсказка, а не условие работы терминала.
  const currentEquipment = currentShift
    ? meta.equipment.find((e) => e.id === currentShift.equipmentId) ?? null
    : null;
  const availableOperations = currentEquipment
    ? operationsForEquipment(currentEquipment, meta.operations)
    : [];

  let passportsInWork: Awaited<ReturnType<typeof getCurrentWork>> = [];
  if (isShiftActive) {
    try {
      passportsInWork = await getCurrentWork();
    } catch (e) {
      if (!(e instanceof ApiRequestError)) throw e;
    }
  }

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
          : 'Смена не начата — отсканируйте QR рабочего места ВТО'
      }
    >
      <WtoTerminal
        meta={meta}
        employee={employee}
        initialShift={currentShift}
        activeOperationCategory={activeOperationCategory}
        availableOperations={availableOperations}
        passportsInWork={passportsInWork}
      />
    </TerminalShell>
  );
}
