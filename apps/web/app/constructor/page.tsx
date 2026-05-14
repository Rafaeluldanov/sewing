import Link from 'next/link';
import { ApiRequestError } from '@/lib/api';
import { listConstructorTasksForMe } from '@/lib/constructor-tasks-api';
import {
  CONSTRUCTOR_TASK_STATUS_LABELS,
  type ConstructorTaskSummaryDto,
} from '@sewing/shared/constructor-tasks';

export const dynamic = 'force-dynamic';

/**
 * Главный экран кабинета конструктора. Серверный компонент:
 *   - один запрос `/api/constructor-tasks/my?scope=all` (мои активные
 *     + общий пул свободных, без DONE/CANCELLED);
 *   - на клиенте делим список на две секции по `assignedToId`:
 *       — «В работе у меня» — есть assignedToName, статус IN_PROGRESS/NEW;
 *       — «Свободные» — assignedToName === null, статус NEW.
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
    <div className="constructor-page">
      <h1 className="constructor-page__title">Мои задачи</h1>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {reworkTasks.length > 0 && (
        <Section
          title="Возвращены на доработку"
          emptyHint=""
          items={reworkTasks}
        />
      )}

      <Section
        title="В работе у меня"
        emptyHint="Пока нет задач в работе. Возьмите задачу из списка ниже."
        items={myActiveTasks}
      />

      <Section
        title="Свободные задачи"
        emptyHint="Свободных задач сейчас нет. Менеджер создаст новую — она появится здесь."
        items={poolTasks}
      />

      {pendingTasks.length > 0 && (
        <Section
          title="Ждут приёмки менеджером"
          emptyHint=""
          items={pendingTasks}
        />
      )}
    </div>
  );
}

function Section({
  title,
  emptyHint,
  items,
}: {
  title: string;
  emptyHint: string;
  items: ConstructorTaskSummaryDto[];
}) {
  return (
    <section className="constructor-section">
      <h2 className="constructor-section__title">
        {title}{' '}
        <span className="constructor-section__count">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <p className="constructor-section__empty">{emptyHint}</p>
      ) : (
        <ul className="constructor-list">
          {items.map((t) => (
            <li key={t.id} className="constructor-list__item">
              <Link
                href={`/constructor/${t.id}`}
                className="constructor-card"
                aria-label={`Открыть задачу ${t.patternName}`}
              >
                <div className="constructor-card__head">
                  <strong className="constructor-card__name">
                    {t.patternName}
                  </strong>
                  <span className="constructor-card__article">
                    {t.patternArticle}
                  </span>
                </div>
                <dl className="constructor-card__meta">
                  <div>
                    <dt>Статус</dt>
                    <dd>{CONSTRUCTOR_TASK_STATUS_LABELS[t.status]}</dd>
                  </div>
                  <div>
                    <dt>Размеров</dt>
                    <dd>{t.sizeRowsCount}</dd>
                  </div>
                  <div>
                    <dt>Файлов</dt>
                    <dd>{t.filesCount}</dd>
                  </div>
                  <div>
                    <dt>От</dt>
                    <dd>{t.createdByName ?? '—'}</dd>
                  </div>
                </dl>
                {t.comment.trim() !== '' ? (
                  <p className="constructor-card__comment">{t.comment}</p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
