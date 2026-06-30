import { ApiRequestError, errorText } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listCuttingTasks } from '@/lib/cutting-tasks-api';
import { getCurrentShift, getShiftMeta } from '@/lib/shifts-api';
import { type CuttingTaskSummaryDto } from '@sewing/shared/cutting-tasks';
import { redirect } from 'next/navigation';
import { SeamstressShiftStart } from '@/app/work/seamstress-shift-start';
import { CutterBoard } from './cutter-board';

export const dynamic = 'force-dynamic';

/**
 * Главный экран кабинета раскройщика. Серверный компонент.
 *
 * Раскрой — scan-shift роль (как ОТК/ВТО/упаковка): сначала смена, потом
 * работа. Поэтому доска раскроя ЗАКРЫТА до открытия смены — без активной
 * `ShiftSession` показываем reuse-форму `SeamstressShiftStart` (QR
 * раскройного стола → операция `CUT_CUT` «Раскрой» → подтверждение,
 * см. ADR-0017). Смена даёт табель и часовую оплату для SALARY/MIXED
 * (`ShiftsService.start` → `SalaryService.syncDailySalary`); шапку и
 * пункт «Завершить смену» рисует `cutter/layout.tsx`.
 *
 * При активной смене — один запрос `/api/cutting-tasks` (общая очередь,
 * без CANCELLED) → делит на секции и отдаёт клиентскому `CutterBoard`:
 *   1. «В работе» — IN_PROGRESS (то, что раскраивается сейчас);
 *   2. «Новые задания» — NEW (общая очередь, можно принять);
 *   3. «Завершённые» — недавние DONE (короткая история).
 */
export default async function CutterCabinetPage() {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/cutter');

  const meta = await getShiftMeta();

  // Источник истины «есть ли активная смена» — backend
  // (`ShiftsService.getCurrent`). fail-soft на ApiRequestError, чтобы
  // временный сбой `GET /shifts/current` не превращал кабинет в экран
  // ошибки: покажем start-shift форму, при следующем запросе выровняется.
  let currentShift = null;
  try {
    currentShift = await getCurrentShift();
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
  }
  const isShiftActive = !!(currentShift && currentShift.active);

  if (!isShiftActive) {
    const employee = meta.employees.find((e) => e.id === me.user.id) ?? {
      id: me.user.id,
      login: me.user.login,
      fullName: me.user.fullName,
      role: me.user.role,
    };
    return <SeamstressShiftStart meta={meta} employee={employee} />;
  }

  let tasks: CuttingTaskSummaryDto[] = [];
  let error: string | null = null;
  try {
    tasks = await listCuttingTasks();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список задач';
  }

  const inProgress = tasks.filter((t) => t.status === 'IN_PROGRESS');
  const fresh = tasks.filter((t) => t.status === 'NEW');
  const done = tasks.filter((t) => t.status === 'DONE');

  return (
    <CutterBoard
      inProgress={inProgress}
      fresh={fresh}
      done={done}
      loadError={error}
    />
  );
}
