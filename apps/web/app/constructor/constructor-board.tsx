'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type DragEvent } from 'react';
import {
  CONSTRUCTOR_TASK_STATUS_LABELS,
  type ConstructorTaskSummaryDto,
} from '@sewing/shared/constructor-tasks';
import { assignSelfAction } from './actions';

/**
 * Клиентский слой кабинета конструктора (данные приходят готовыми
 * секциями из серверного `page.tsx`).
 *
 * Делает две вещи:
 *  1. Цвет статуса на каждой карточке — бейдж `.constructor-status--*`
 *     (тона — `CONSTRUCTOR_TASK_STATUS_TONE`, те же, что в админке).
 *  2. Drag-and-drop ТОЛЬКО для безопасного перехода «взять в работу»:
 *     карточку из «Свободные» (NEW) или «Возвращены на доработку»
 *     (REWORK) можно перетащить в секцию «В работе у меня» — это
 *     вызывает `assignSelfAction` (NEW/REWORK → IN_PROGRESS, бэкенд
 *     валидирует права и владение). Остальные переходы требуют файлов
 *     или прав менеджера и здесь намеренно НЕ перетаскиваются.
 *
 * Нативный HTML5 DnD, без библиотек. Доступная (клавиатурная)
 * альтернатива остаётся прежней — кнопка «Взять в работу» на странице
 * задачи `/constructor/<id>`.
 */

const DRAG_MIME = 'application/x-constructor-task-id';

interface Props {
  rework: ConstructorTaskSummaryDto[];
  myActive: ConstructorTaskSummaryDto[];
  pool: ConstructorTaskSummaryDto[];
  pending: ConstructorTaskSummaryDto[];
  loadError?: string | null;
}

export function ConstructorBoard({
  rework,
  myActive,
  pool,
  pending,
  loadError = null,
}: Props) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);

  function handleDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setDropActive(false);
    const taskId = e.dataTransfer.getData(DRAG_MIME);
    if (!taskId || busy) return;
    setError(null);
    startTransition(async () => {
      const result = await assignSelfAction(taskId);
      if (!result.ok) {
        setError(result.error ?? 'Не удалось взять задачу');
      } else {
        router.refresh();
      }
    });
  }

  return (
    <div className="constructor-page">
      <h1 className="constructor-page__title">Мои задачи</h1>

      {(loadError || error) && (
        <div className="error-box" role="alert">
          {loadError ?? error}
        </div>
      )}

      {rework.length > 0 && (
        <Section
          title="Возвращены на доработку"
          emptyHint=""
          items={rework}
          draggableItems
        />
      )}

      <Section
        title="В работе у меня"
        emptyHint="Пока нет задач в работе. Перетащите сюда задачу из списка ниже или возьмите её на странице задачи."
        items={myActive}
        dropZone={{
          active: dropActive,
          busy,
          onDragOver: (e) => {
            // Разрешаем drop только если тащат нашу карточку.
            if (e.dataTransfer.types.includes(DRAG_MIME)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (!dropActive) setDropActive(true);
            }
          },
          onDragLeave: () => setDropActive(false),
          onDrop: handleDrop,
        }}
      />

      <Section
        title="Свободные задачи"
        emptyHint="Свободных задач сейчас нет. Менеджер создаст новую — она появится здесь."
        items={pool}
        draggableItems
      />

      {pending.length > 0 && (
        <Section
          title="Ждут приёмки менеджером"
          emptyHint=""
          items={pending}
        />
      )}
    </div>
  );
}

interface DropZone {
  active: boolean;
  busy: boolean;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}

function Section({
  title,
  emptyHint,
  items,
  draggableItems = false,
  dropZone,
}: {
  title: string;
  emptyHint: string;
  items: ConstructorTaskSummaryDto[];
  draggableItems?: boolean;
  dropZone?: DropZone;
}) {
  const dropProps = dropZone
    ? {
        onDragOver: dropZone.onDragOver,
        onDragLeave: dropZone.onDragLeave,
        onDrop: dropZone.onDrop,
      }
    : {};
  const sectionClass =
    'constructor-section' +
    (dropZone ? ' constructor-section--dropzone' : '') +
    (dropZone?.active ? ' constructor-section--drop-active' : '') +
    (dropZone?.busy ? ' constructor-section--drop-busy' : '');

  return (
    <section className={sectionClass} {...dropProps}>
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
                className={
                  'constructor-card' +
                  ` constructor-card--status-${t.status.toLowerCase()}` +
                  (draggableItems ? ' constructor-card--draggable' : '')
                }
                aria-label={`Открыть задачу ${t.patternName}`}
                draggable={draggableItems}
                onDragStart={
                  draggableItems
                    ? (e) => {
                        e.dataTransfer.setData(DRAG_MIME, t.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }
                    : undefined
                }
              >
                <div className="constructor-card__head">
                  <strong className="constructor-card__name">
                    {t.patternName}
                  </strong>
                  <span
                    className={`constructor-status constructor-status--${t.status.toLowerCase()}`}
                  >
                    {CONSTRUCTOR_TASK_STATUS_LABELS[t.status]}
                  </span>
                </div>
                <dl className="constructor-card__meta">
                  <div>
                    <dt>Артикул</dt>
                    <dd>{t.patternArticle}</dd>
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
