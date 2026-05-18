import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { getConstructorTask } from '@/lib/constructor-tasks-api';
import {
  CONSTRUCTOR_TASK_STATUS_LABELS,
  type ConstructorTaskDetailDto,
} from '@sewing/shared/constructor-tasks';
import { AssignSelfButton } from './assign-self-button';
import { CompleteTaskForm } from './complete-task-form';
import { UpdateCommentForm } from './update-comment-form';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { id: string };
}

/**
 * Детальная страница задачи в кабинете конструктора. Что показываем
 * и какие действия — зависит от статуса задачи и того, кто её взял:
 *
 *   - `NEW` без assign → кнопка «Взять в работу» (`AssignSelfButton`).
 *   - `NEW` / `IN_PROGRESS` назначена другому → read-only заметка.
 *   - `IN_PROGRESS` назначена мне → форма комментария + форма
 *     завершения с upload-ами DXF по каждому размеру.
 *   - `DONE` / `CANCELLED` → read-only результат + ссылка на лекало
 *     (только если ADMIN/SHOP_MANAGER, у конструктора нет доступа в
 *     `/admin/patterns`).
 *
 * Серверный компонент: данные приходят из `getConstructorTask` (тот
 * же API, что использует админская страница, RBAC расширен на
 * `CONSTRUCTOR`).
 */
export default async function ConstructorTaskDetailPage({ params }: PageProps) {
  const me = await getCurrentUserOrNull();
  // Layout уже защитил роут, но без `me` детали показывать нечего —
  // решение «assigned to me» опирается на сравнение employeeId.
  if (!me) {
    notFound();
  }

  let task: ConstructorTaskDetailDto;
  try {
    task = await getConstructorTask(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  const isAdmin = me.user.role === 'ADMIN' || me.user.role === 'SHOP_MANAGER';
  // На уровне DTO мы видим только `assignedToName`, не id. Для
  // определения «моя ли это задача» используем имя — это слабая
  // эвристика, но MVP-достаточная: backend всё равно режет операции
  // по `enforceOwnership = true` для роли CONSTRUCTOR.
  const isMine =
    task.assignedToName !== null && task.assignedToName === me.user.fullName;
  const isUnassigned = task.assignedToName === null;

  const statusLabel = CONSTRUCTOR_TASK_STATUS_LABELS[task.status];

  // Группируем файлы по направлению, чтобы конструктор отличал бриф
  // менеджера от замечаний на доработку. Старые записи без `direction`
  // (до 14.05.2026) трактуем как INITIAL.
  const initialFiles = task.files.filter((f) => f.direction !== 'REWORK');
  const reworkFiles = task.files.filter((f) => f.direction === 'REWORK');

  return (
    <div className="constructor-detail">
      <Link href="/constructor" className="constructor-back">
        ← К списку задач
      </Link>

      <header className="constructor-detail__head">
        <div>
          <h1 className="constructor-detail__title">{task.patternName}</h1>
          <div className="constructor-detail__article">{task.patternArticle}</div>
        </div>
        <span
          className={`constructor-status constructor-status--${task.status.toLowerCase()}`}
        >
          {statusLabel}
        </span>
      </header>

      <section className="constructor-card-block">
        <h2 className="constructor-card-block__title">Параметры заявки</h2>
        <dl className="constructor-meta-grid">
          <div>
            <dt>Создана</dt>
            <dd>{new Date(task.createdAt).toLocaleString('ru-RU')}</dd>
          </div>
          <div>
            <dt>Кем создана</dt>
            <dd>{task.createdByName ?? '—'}</dd>
          </div>
          <div>
            <dt>Конструктор</dt>
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

      {/* Основные действия — зависят от статуса/владельца */}
      {task.status === 'NEW' && isUnassigned ? (
        <section className="constructor-card-block">
          <AssignSelfButton taskId={task.id} />
        </section>
      ) : null}

      {task.status === 'NEW' && !isUnassigned && !isMine ? (
        <section className="constructor-card-block">
          <p className="constructor-muted">
            Задача уже взята: {task.assignedToName}.
          </p>
        </section>
      ) : null}

      {task.status === 'IN_PROGRESS' && !isMine && !isAdmin ? (
        <section className="constructor-card-block">
          <p className="constructor-muted">
            Задачу ведёт {task.assignedToName ?? 'другой конструктор'}.
          </p>
        </section>
      ) : null}

      {/* REWORK: задачу вернул менеджер. Если она моя — продолжаю работу
          (ниже отрендерится та же CompleteTaskForm). Если ничей — могу
          взять (assignSelf переведёт в IN_PROGRESS). Если у другого
          конструктора — read-only. */}
      {task.status === 'REWORK' && isUnassigned ? (
        <section className="constructor-card-block">
          <p className="constructor-muted" style={{ marginBottom: '0.5rem' }}>
            Задача вернулась на доработку. Возьмите её в работу, чтобы
            прислать новую версию лекала.
          </p>
          <AssignSelfButton taskId={task.id} />
        </section>
      ) : null}
      {task.status === 'REWORK' && !isUnassigned && !isMine && !isAdmin ? (
        <section className="constructor-card-block">
          <p className="constructor-muted">
            Доработку ведёт {task.assignedToName ?? 'другой конструктор'}.
          </p>
        </section>
      ) : null}

      {task.status === 'PENDING_ACCEPT' ? (
        <section className="constructor-card-block">
          <p className="constructor-muted">
            Лекало отправлено менеджеру на приёмку. Если будут замечания
            — задача вернётся к вам со статусом «Доработка».
          </p>
        </section>
      ) : null}

      {task.status === 'CANCELLED' ? (
        <section className="constructor-card-block">
          <p className="constructor-muted">
            Задача отменена менеджером — действий больше не требуется.
          </p>
        </section>
      ) : null}

      {task.status === 'DONE' ? (
        <section className="constructor-card-block">
          <p className="constructor-muted">
            Задача принята менеджером. Лекало переведено в статус ACTIVE.
            {isAdmin ? (
              <>
                {' '}
                <Link
                  href={`/admin/patterns/${task.patternItemId}`}
                  className="constructor-link"
                >
                  Открыть в номенклатуре
                </Link>
                .
              </>
            ) : null}
          </p>
        </section>
      ) : null}

      <section className="constructor-card-block">
        <h2 className="constructor-card-block__title">Комментарий менеджера</h2>
        {task.comment.trim() === '' ? (
          <p className="constructor-muted">Комментарий не задан.</p>
        ) : (
          <p className="constructor-comment-view">{task.comment}</p>
        )}

        {(isMine || isAdmin) &&
        (task.status === 'NEW' ||
          task.status === 'IN_PROGRESS' ||
          task.status === 'REWORK') ? (
          <UpdateCommentForm
            taskId={task.id}
            initialComment={task.comment}
          />
        ) : null}
      </section>

      <section className="constructor-card-block">
        <h2 className="constructor-card-block__title">
          Размерная таблица (м пог. на изделие)
        </h2>
        {task.sizeRows.length === 0 ? (
          <p className="constructor-muted">Размеры не заданы.</p>
        ) : (
          <table className="constructor-table">
            <thead>
              <tr>
                <th>Размер</th>
                <th>Кулирка</th>
                <th>Кашкорсе</th>
              </tr>
            </thead>
            <tbody>
              {task.sizeRows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.sizeCodeSnapshot}</strong>
                  </td>
                  <td>{r.kulirkaMeters ?? '—'}</td>
                  <td>{r.kashkorseMeters ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="constructor-card-block">
        <h2 className="constructor-card-block__title">
          Бриф от менеджера{' '}
          <span className="constructor-muted">({initialFiles.length})</span>
        </h2>
        {initialFiles.length === 0 ? (
          <p className="constructor-muted">Файлы не прикреплены.</p>
        ) : (
          <ul className="constructor-files">
            {initialFiles.map((f) => (
              <li key={f.id}>
                <a
                  href={f.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="constructor-link"
                >
                  {f.originalFileName}
                </a>
                <span className="constructor-muted">
                  {' '}
                  · {(f.sizeBytes / 1024).toFixed(0)} КБ
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {reworkFiles.length > 0 && (
        <section className="constructor-card-block constructor-card-block--complete">
          <h2 className="constructor-card-block__title">
            Замечания на доработку{' '}
            <span className="constructor-muted">({reworkFiles.length})</span>
          </h2>
          <ul className="constructor-files">
            {reworkFiles.map((f) => (
              <li key={f.id}>
                <a
                  href={f.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="constructor-link"
                >
                  {f.originalFileName}
                </a>
                <span className="constructor-muted">
                  {' '}
                  · {(f.sizeBytes / 1024).toFixed(0)} КБ
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(task.status === 'IN_PROGRESS' || task.status === 'REWORK') &&
      (isMine || isAdmin) ? (
        <section className="constructor-card-block constructor-card-block--complete">
          <h2 className="constructor-card-block__title">
            {task.status === 'REWORK'
              ? 'Загрузить исправленную версию'
              : 'Завершить задачу'}
          </h2>
          <CompleteTaskForm taskId={task.id} sizeRows={task.sizeRows} />
        </section>
      ) : null}
    </div>
  );
}
