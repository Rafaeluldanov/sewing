'use client';

/**
 * Рабочая карточка паспорта ОТК для scan-driven терминала `/qc`.
 *
 * Логика state машины — у `QcTerminal` (родитель). Этот компонент
 * чистый view + два callback-а:
 *   - `onDefectSubmit(formData)` — вызвать `recordDefectAction`
 *     для текущего паспорта (родитель сам биндит passportId);
 *   - `onComplete()` — вызвать `completeQcAction`.
 *
 * Бизнес-правила (источник истины — backend, см. `QcService`):
 *   - блок «Зафиксировать брак» прячется, когда `canRecordDefect = false`
 *     (статус не IN_PROGRESS или весь крой уже отмечен браком);
 *   - кнопка «Проверка выполнена» прячется, когда `canCompleteQc = false`
 *     (терминальные статусы);
 *   - после успешного complete показываем бейдж «Проверка выполнена ⟨время⟩»,
 *     но кнопка остаётся доступной — повторное завершение разрешено
 *     (например, после фиксации дополнительного брака).
 */

import { useRef } from 'react';
import type { DefectTypeDto, QcPassportDetailDto } from '@sewing/shared/qc';
import { PASSPORT_STATUS_LABELS } from '@/lib/passport-status-labels';

interface Props {
  detail: QcPassportDetailDto;
  defectTypes: DefectTypeDto[];
  pending: boolean;
  onDefectSubmit: (form: FormData) => void;
  onComplete: () => void;
  onScanNext: () => void;
  onRefresh: () => void;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

export function QcWorkCard({
  detail,
  defectTypes,
  pending,
  onDefectSubmit,
  onComplete,
  onScanNext,
  onRefresh,
}: Props) {
  const formRef = useRef<HTMLFormElement | null>(null);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    onDefectSubmit(new FormData(form));
    form.reset();
  };

  const completedLabel = detail.qcCompletedAt
    ? `Проверка выполнена · ${formatDateTime(detail.qcCompletedAt)}`
    : null;

  return (
    <section className="qc-card" aria-label="Карточка паспорта ОТК">
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

      {completedLabel && (
        <div className="info-box" role="status">
          {completedLabel}
        </div>
      )}

      {detail.canRecordDefect ? (
        <form
          ref={formRef}
          className="qc-card__defect-form"
          onSubmit={handleSubmit}
          aria-label="Зафиксировать брак"
        >
          <h3 className="qc-card__section-title">Зафиксировать брак</h3>
          <div className="form-row">
            <label htmlFor="qc-defect-type">Вид брака</label>
            <div>
              <select
                id="qc-defect-type"
                name="defectTypeId"
                defaultValue=""
                required
                disabled={pending || defectTypes.length === 0}
              >
                <option value="">— выбрать —</option>
                {defectTypes.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {d.code}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="qc-defect-qty">Количество, шт.</label>
            <div>
              <input
                id="qc-defect-qty"
                name="qty"
                type="number"
                min={1}
                max={Math.max(detail.remainingForDefect, 1)}
                step={1}
                defaultValue={1}
                required
                disabled={pending || detail.remainingForDefect === 0}
              />
              <div className="hint">
                Доступно к фиксации:{' '}
                <strong>{detail.remainingForDefect}</strong> шт.
              </div>
            </div>
          </div>
          <div className="form-row">
            <label htmlFor="qc-defect-comment">Комментарий</label>
            <div>
              <textarea
                id="qc-defect-comment"
                name="comment"
                rows={2}
                maxLength={500}
                placeholder="Опционально, до 500 символов"
                disabled={pending}
              />
            </div>
          </div>
          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={pending || detail.remainingForDefect === 0}
          >
            {pending ? 'Запись…' : 'Добавить брак'}
          </button>
        </form>
      ) : (
        <div className="card empty qc-card__defect-empty">
          {detail.status !== 'IN_PROGRESS'
            ? 'Паспорт ещё не в работе или уже завершён — фиксировать брак нельзя.'
            : 'Все штуки этого паспорта уже отмечены как брак.'}
        </div>
      )}

      {detail.defects.length > 0 && (
        <details className="qc-card__history">
          <summary>История дефектов ({detail.defects.length})</summary>
          <ul>
            {detail.defects.map((d) => (
              <li key={d.id}>
                <strong>{d.qty} шт.</strong> · {d.defectTypeName}
                <span className="qc-card__history-meta">
                  {' '}
                  · {formatDateTime(d.createdAt)}
                </span>
                {d.comment ? (
                  <div className="qc-card__history-comment">{d.comment}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="qc-card__actions">
        {detail.canCompleteQc && (
          <button
            type="button"
            className="btn btn-success btn-block btn-lg"
            onClick={onComplete}
            disabled={pending}
          >
            {pending ? 'Сохраняем…' : 'Проверка выполнена'}
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
