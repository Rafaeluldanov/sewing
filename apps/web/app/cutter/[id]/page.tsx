import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getCuttingTask } from '@/lib/cutting-tasks-api';
import {
  CUTTING_TASK_STATUS_LABELS,
  type CuttingTaskDetailDto,
} from '@sewing/shared/cutting-tasks';
import { StartButton } from './start-button';
import { CuttingForm } from './cutting-form';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { id: string };
}

/**
 * Детальная страница задачи на раскрой. Что показываем — зависит от
 * статуса:
 *   - `NEW`         → задание (размер / план) + кнопка «Принять задание»;
 *   - `IN_PROGRESS` → интерактивная форма раскроя (настил рулонов);
 *   - `DONE`        → read-only итоги;
 *   - `CANCELLED`   → заметка.
 */
export default async function CutterTaskDetailPage({ params }: PageProps) {
  let task: CuttingTaskDetailDto;
  try {
    task = await getCuttingTask(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  const statusLabel = CUTTING_TASK_STATUS_LABELS[task.status];

  return (
    <div className="constructor-detail">
      <Link href="/cutter" className="constructor-back">
        ← К списку задач
      </Link>

      <header className="constructor-detail__head">
        <div>
          <h1 className="constructor-detail__title">Заказ {task.orderNumber}</h1>
          <div className="constructor-detail__article">
            {task.orderColor ?? 'Цвет не указан'}
          </div>
        </div>
        <span
          className={`constructor-status constructor-status--${task.status.toLowerCase()}`}
        >
          {statusLabel}
        </span>
      </header>

      <section className="constructor-card-block">
        <h2 className="constructor-card-block__title">Параметры задачи</h2>
        <dl className="constructor-meta-grid">
          <div>
            <dt>Заказ</dt>
            <dd>{task.orderNumber}</dd>
          </div>
          <div>
            <dt>Клиент</dt>
            <dd>{task.orderCustomer ?? '—'}</dd>
          </div>
          <div>
            <dt>Раскройщик</dt>
            <dd>
              {task.assignedToName ?? (
                <span className="constructor-muted">не назначен</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Размеров</dt>
            <dd>{task.sizeRowsCount}</dd>
          </div>
        </dl>
      </section>

      {task.status === 'NEW' ? (
        <>
          <section className="constructor-card-block">
            <h2 className="constructor-card-block__title">Задание по размерам</h2>
            {task.sizeRows.length === 0 ? (
              <p className="constructor-muted">Размеры не заданы.</p>
            ) : (
              <table className="constructor-table">
                <thead>
                  <tr>
                    <th>Размер</th>
                    <th>План, шт</th>
                  </tr>
                </thead>
                <tbody>
                  {task.sizeRows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.sizeCodeSnapshot}</strong>
                      </td>
                      <td>{r.qtyPlan}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="constructor-card-block">
            <p className="constructor-muted" style={{ marginBottom: '0.5rem' }}>
              Примите задание, чтобы ввести раскладку и настелить рулоны.
            </p>
            <StartButton taskId={task.id} />
          </section>
        </>
      ) : null}

      {task.status === 'IN_PROGRESS' ? (
        <CuttingForm
          taskId={task.id}
          sizeRows={task.sizeRows}
          rolls={task.rolls}
        />
      ) : null}

      {task.status === 'DONE' ? (
        <>
          <section className="constructor-card-block">
            <p className="constructor-muted">
              Раскрой завершён. Данные переданы дальше по производству.
            </p>
          </section>
          <CuttingForm
            taskId={task.id}
            sizeRows={task.sizeRows}
            rolls={task.rolls}
            readOnly
          />
        </>
      ) : null}

      {task.status === 'CANCELLED' ? (
        <section className="constructor-card-block">
          <p className="constructor-muted">
            Задача отменена — действий больше не требуется.
          </p>
        </section>
      ) : null}
    </div>
  );
}
