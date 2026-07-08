'use client';

import Link from 'next/link';
import {
  CUTTING_TASK_STATUS_LABELS,
  type CuttingTaskSummaryDto,
} from '@sewing/shared/cutting-tasks';
import type { RecutSessionDto } from '@sewing/shared/recut';
import { RecutPanel } from './recut-panel';

/**
 * Клиентский слой главного экрана кабинета раскройщика (данные приходят
 * готовыми секциями из серверного `page.tsx`). Список карточек, каждая
 * — крупная кликабельная ссылка на `/cutter/<id>`. Сверху — панель
 * «Подкрой» (отдельный таймер по заказу, `RecutPanel`).
 */
interface Props {
  inProgress: CuttingTaskSummaryDto[];
  fresh: CuttingTaskSummaryDto[];
  done: CuttingTaskSummaryDto[];
  recutActive: RecutSessionDto | null;
  loadError?: string | null;
}

export function CutterBoard({
  inProgress,
  fresh,
  done,
  recutActive,
  loadError = null,
}: Props) {
  return (
    <div className="constructor-page">
      <h1 className="constructor-page__title">Раскрой</h1>

      {loadError && (
        <div className="error-box" role="alert">
          {loadError}
        </div>
      )}

      <RecutPanel active={recutActive} />

      <Section
        title="В работе"
        emptyHint="Сейчас нет задач в работе. Примите новое задание из списка ниже."
        items={inProgress}
      />
      <Section
        title="Новые задания"
        emptyHint="Новых заданий нет. Они появятся, когда заказ запустят в производство."
        items={fresh}
      />
      {done.length > 0 && (
        <Section title="Завершённые" emptyHint="" items={done} />
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
  items: CuttingTaskSummaryDto[];
}) {
  return (
    <section className="constructor-section">
      <h2 className="constructor-section__title">
        {title} <span className="constructor-section__count">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <p className="constructor-section__empty">{emptyHint}</p>
      ) : (
        <ul className="constructor-list">
          {items.map((t) => (
            <li key={t.id} className="constructor-list__item">
              <Link
                href={`/cutter/${t.id}`}
                className={
                  'constructor-card' +
                  ` constructor-card--status-${t.status.toLowerCase()}`
                }
                aria-label={`Открыть раскрой заказа ${t.orderNumber}`}
              >
                <div className="constructor-card__head">
                  <strong className="constructor-card__name">
                    Заказ {t.orderNumber}
                  </strong>
                  <span
                    className={`constructor-status constructor-status--${t.status.toLowerCase()}`}
                  >
                    {CUTTING_TASK_STATUS_LABELS[t.status]}
                  </span>
                </div>
                <dl className="constructor-card__meta">
                  <div>
                    <dt>Цвет</dt>
                    <dd>{t.orderColor ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Размеров</dt>
                    <dd>{t.sizeRowsCount}</dd>
                  </div>
                  <div>
                    <dt>Рулонов</dt>
                    <dd>{t.rollsCount}</dd>
                  </div>
                  <div>
                    <dt>Всего слоёв</dt>
                    <dd>{t.totalLayers}</dd>
                  </div>
                </dl>
                {t.assignedToName ? (
                  <p className="constructor-card__comment">
                    Раскройщик: {t.assignedToName}
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
