import { ApiRequestError } from '@/lib/api';
import { listCuttingTasks } from '@/lib/cutting-tasks-api';
import { type CuttingTaskSummaryDto } from '@sewing/shared/cutting-tasks';
import { CutterBoard } from './cutter-board';

export const dynamic = 'force-dynamic';

/**
 * Главный экран кабинета раскройщика. Серверный компонент: один запрос
 * `/api/cutting-tasks` (общая очередь, без CANCELLED) → делит на секции
 * и отдаёт клиентскому `CutterBoard`.
 *
 * Секции:
 *   1. «В работе» — IN_PROGRESS (то, что раскраивается сейчас);
 *   2. «Новые задания» — NEW (общая очередь, можно принять);
 *   3. «Завершённые» — недавние DONE (короткая история).
 */
export default async function CutterCabinetPage() {
  let tasks: CuttingTaskSummaryDto[] = [];
  let error: string | null = null;
  try {
    tasks = await listCuttingTasks();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
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
