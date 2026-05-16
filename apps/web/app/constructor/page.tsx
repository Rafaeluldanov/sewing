import { ApiRequestError } from '@/lib/api';
import { listConstructorTasksForMe } from '@/lib/constructor-tasks-api';
import { type ConstructorTaskSummaryDto } from '@sewing/shared/constructor-tasks';
import { ConstructorBoard } from './constructor-board';

export const dynamic = 'force-dynamic';

/**
 * Главный экран кабинета конструктора. Серверный компонент:
 *   - один запрос `/api/constructor-tasks/my?scope=all` (мои активные
 *     + общий пул свободных, без DONE/CANCELLED);
 *   - делит список на секции и отдаёт их клиентскому `ConstructorBoard`,
 *     который рисует цветные статусы и поддерживает перетаскивание
 *     «взять в работу» (см. сам компонент).
 *
 * Стиль mobile-first: список карточек, каждая — крупная кликабельная
 * ссылка на `/constructor/<id>`.
 */
export default async function ConstructorCabinetPage() {
  let tasks: ConstructorTaskSummaryDto[] = [];
  let error: string | null = null;
  try {
    tasks = await listConstructorTasksForMe('all');
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список задач';
  }

  // Секции для главного экрана — приоритезируем то, что требует
  // действий конструктора:
  //   1. REWORK — самая срочная (менеджер прислал замечания);
  //   2. IN_PROGRESS / NEW (мои) — текущая работа;
  //   3. свободные NEW — общий пул;
  //   4. PENDING_ACCEPT — read-only «висит у менеджера», только инфо.
  const reworkTasks = tasks.filter(
    (t) => t.assignedToName !== null && t.status === 'REWORK',
  );
  const myActiveTasks = tasks.filter(
    (t) =>
      t.assignedToName !== null &&
      (t.status === 'IN_PROGRESS' || t.status === 'NEW'),
  );
  const poolTasks = tasks.filter((t) => t.assignedToName === null);
  const pendingTasks = tasks.filter(
    (t) => t.assignedToName !== null && t.status === 'PENDING_ACCEPT',
  );

  return (
    <ConstructorBoard
      rework={reworkTasks}
      myActive={myActiveTasks}
      pool={poolTasks}
      pending={pendingTasks}
      loadError={error}
    />
  );
}
