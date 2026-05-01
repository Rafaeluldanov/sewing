'use client';

/**
 * Рабочая карточка паспорта ВТО для scan-driven терминала `/wto`.
 *
 * Структурно повторяет `QcWorkCard` (см. `apps/web/app/qc/qc-work-card.tsx`),
 * но без блоков «зафиксировать брак» и «история дефектов» — фиксация
 * брака — обязанность ОТК (`docs/flows.md §F5`). У ВТО единственное
 * действие на карточке — «Завершить ВТО».
 *
 * Бизнес-правила (источник истины — backend, см. `WtoService`):
 *   - кнопка «Завершить ВТО» прячется, когда `canCompleteWto = false`
 *     (не на ВТО или статус не IN_PROGRESS);
 *   - после успешного complete показываем бейдж «ВТО завершено ⟨время⟩»,
 *     но кнопка остаётся доступной — повторное завершение разрешено
 *     (на случай, если ВТО переподтверждает после доп. проверки).
 *
 * `qcPassedAt` показывается всегда подсказкой «ОТК прошло такого-то».
 * Это аудит для оператора ВТО, чтобы он видел, на основании чего
 * паспорт сюда попал.
 */

import type { WtoPassportDetailDto } from '@sewing/shared/wto';
import { PASSPORT_STATUS_LABELS } from '@/lib/passport-status-labels';

interface Props {
  detail: WtoPassportDetailDto;
  pending: boolean;
  onComplete: () => void;
  onScanNext: () => void;
  onRefresh: () => void;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU');
}

export function WtoWorkCard({
  detail,
  pending,
  onComplete,
  onScanNext,
  onRefresh,
}: Props) {
  const completedLabel = detail.wtoCompletedAt
    ? `ВТО завершено · ${formatDateTime(detail.wtoCompletedAt)}`
    : null;
  const qcLabel = detail.qcPassedAt
    ? `ОТК прошло · ${formatDateTime(detail.qcPassedAt)}`
    : null;

  return (
    <section className="qc-card" aria-label="Карточка паспорта ВТО">
      <header className="qc-card__header">
        <div>
          <div className="qc-card__label">Паспорт</div>
          <div className="qc-card__number">{detail.passportNumber}</div>
        </div>
        <span className={`status-badge ${detail.status.toLowerCase()}`}>
          {PASSPORT_STATUS_LABELS[detail.status]}
        </span>
      </header>

      <dl className="qc-card__grid">
        <div>
          <dt>Изделие</dt>
          <dd>{detail.productName}</dd>
        </div>
        <div>
          <dt>Цвет</dt>
          <dd>{detail.color}</dd>
        </div>
        <div>
          <dt>Размер</dt>
          <dd className="qc-card__size">{detail.sizeCode}</dd>
        </div>
        <div>
          <dt>Заказ</dt>
          <dd>{detail.orderNumber}</dd>
        </div>
        <div>
          <dt>Рулон</dt>
          <dd>{detail.rollNumber}</dd>
        </div>
        <div>
          <dt>Текущая операция</dt>
          <dd>{detail.currentOperationName ?? '—'}</dd>
        </div>
      </dl>

      <div className="qc-card__qty">
        <div>
          <span className="qc-card__qty-label">Раскроено</span>
          <strong className="qc-card__qty-value">{detail.qtyCut}</strong>
        </div>
        <div>
          <span className="qc-card__qty-label">Брак</span>
          <strong className="qc-card__qty-value qc-card__qty-value--danger">
            {detail.qtyDefect}
          </strong>
        </div>
        <div>
          <span className="qc-card__qty-label">Годных</span>
          <strong className="qc-card__qty-value qc-card__qty-value--success">
            {detail.qtyGood}
          </strong>
        </div>
      </div>

      {qcLabel && (
        <div className="info-box" role="status">
          {qcLabel}
        </div>
      )}
      {completedLabel && (
        <div className="info-box" role="status">
          {completedLabel}
        </div>
      )}

      <div className="qc-card__actions">
        {detail.canCompleteWto && (
          <button
            type="button"
            className="btn btn-success btn-block btn-lg"
            onClick={onComplete}
            disabled={pending}
          >
            {pending ? 'Сохраняем…' : 'Завершить ВТО'}
          </button>
        )}
        <button
          type="button"
          className="btn btn-block"
          onClick={onScanNext}
          disabled={pending}
        >
          Сканировать другой паспорт
        </button>
        <button
          type="button"
          className="scan-card__manual-toggle"
          onClick={onRefresh}
          disabled={pending}
        >
          Обновить карточку
        </button>
      </div>
    </section>
  );
}
