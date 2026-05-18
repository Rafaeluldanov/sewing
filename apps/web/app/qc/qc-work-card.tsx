'use client';

/**
 * Рабочая карточка паспорта ОТК для scan-driven терминала `/qc`.
 *
 * Чистый view + callbacks; state-машина — у родителя `QcTerminal`.
 *
 * UX (см. docs/screens.md §5, docs/flows.md §F5):
 *   - поле «Количество брака» по умолчанию 0 («брака нет»); если
 *     брак есть — ОТК ставит фактическое число;
 *   - панель действий ЗАКРЕПЛЕНА снизу (sticky). Пока проверка не
 *     завершена — «Добавить брак» (submit формы брака через
 *     `form=`-атрибут) + «Проверка выполнена». После «Проверка
 *     выполнена» обе кнопки заменяются одной — «Сканировать другой
 *     паспорт»;
 *   - «Обновить карточку» — мелкая ссылка в теле карточки, вне
 *     закреплённой панели (ручное обновление на всякий случай).
 *
 * Бизнес-правила (источник истины — backend, см. `QcService`):
 *   - блок «Зафиксировать брак» доступен только при `canRecordDefect`
 *     и пока проверка не завершена;
 *   - «Проверка выполнена» доступна только при `canCompleteQc`.
 */

import { useRef } from 'react';
import type { DefectTypeDto, QcPassportDetailDto } from '@sewing/shared/qc';
import { PASSPORT_STATUS_LABELS } from '@/lib/passport-status-labels';

interface ErrorState {
  message: string;
  requestId?: string;
}

interface Props {
  detail: QcPassportDetailDto;
  defectTypes: DefectTypeDto[];
  pending: boolean;
  /** Ошибка/инфо последнего действия — раньше жили в scan-карточке
   *  родителя; теперь, когда паспорт открыт, scan-карточка скрыта,
   *  поэтому фидбек показываем прямо в карточке (над панелью). */
  error: ErrorState | null;
  info: string | null;
  onDefectSubmit: (form: FormData) => void;
  onComplete: () => void;
  onScanNext: () => void;
  onRefresh: () => void;
}

/** id формы брака: кнопка «Добавить брак» вынесена в закреплённую
 *  панель (вне `<form>`) и сабмитит её через `form=`-атрибут. */
const DEFECT_FORM_ID = 'qc-defect-form';

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
  error,
  info,
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

  const completed = !!detail.qcCompletedAt;
  const completedLabel = completed
    ? `Проверка выполнена · ${formatDateTime(detail.qcCompletedAt)}`
    : null;

  // Блок брака — только в работе (не после complete) и пока backend
  // разрешает фиксировать брак.
  const showDefectForm = !completed && detail.canRecordDefect;
  const showDefectEmpty = !completed && !detail.canRecordDefect;

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

      {/* «Обновить карточку» — мелкая ссылка, вне закреплённой панели. */}
      <div className="qc-card__refresh">
        <button
          type="button"
          className="scan-card__manual-toggle"
          onClick={onRefresh}
          disabled={pending}
        >
          Обновить карточку
        </button>
      </div>

      {completedLabel && (
        <div className="info-box" role="status">
          {completedLabel}
        </div>
      )}

      {showDefectForm ? (
        <form
          key={detail.passportId}
          id={DEFECT_FORM_ID}
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
            <label htmlFor="qc-defect-qty">Количество брака, шт.</label>
            <div>
              {/*
               * По умолчанию 0 — «брака нет». Если брак есть, ОТК
               * редактирует это число. `key` на форме = passportId:
               * при сканировании другого паспорта форма
               * перемонтируется и значение сбрасывается обратно в 0.
               */}
              <input
                id="qc-defect-qty"
                name="qty"
                type="number"
                min={1}
                max={Math.max(detail.remainingForDefect, 1)}
                step={1}
                defaultValue={0}
                required
                disabled={pending || detail.remainingForDefect === 0}
              />
              <div className="hint">
                Это <strong>количество брака</strong>. 0 — брака нет;
                {' '}укажите число, если есть брак. Доступно к фиксации:{' '}
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
        </form>
      ) : showDefectEmpty ? (
        <div className="card empty qc-card__defect-empty">
          {detail.status !== 'IN_PROGRESS'
            ? 'Паспорт ещё не в работе или уже завершён — фиксировать брак нельзя.'
            : 'Все штуки этого паспорта уже отмечены как брак.'}
        </div>
      ) : null}

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

      {error && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">{error.message}</div>
          {error.requestId && (
            <div className="error-box__rid">
              req: <code>{error.requestId}</code>
            </div>
          )}
        </div>
      )}
      {info && !error && !completed && (
        <div className="info-box" role="status">
          {info}
        </div>
      )}

      {/*
       * Закреплённая снизу панель действий (sticky). До «Проверка
       * выполнена» — «Добавить брак» (submit формы брака через
       * form=DEFECT_FORM_ID) + «Проверка выполнена». После — одна
       * кнопка «Сканировать другой паспорт». Fallback: если backend
       * не разрешает ни брак, ни complete — даём скан, чтобы ОТК не
       * застрял.
       */}
      <div className="qc-card__sticky-actions">
        {completed ? (
          <button
            type="button"
            className="btn btn-primary btn-block btn-lg"
            onClick={onScanNext}
            disabled={pending}
          >
            Сканировать другой паспорт
          </button>
        ) : (
          <>
            {detail.canRecordDefect && (
              <button
                type="submit"
                form={DEFECT_FORM_ID}
                className="btn btn-primary btn-block"
                disabled={pending || detail.remainingForDefect === 0}
              >
                {pending ? 'Запись…' : 'Добавить брак'}
              </button>
            )}
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
            {!detail.canRecordDefect && !detail.canCompleteQc && (
              <button
                type="button"
                className="btn btn-block btn-lg"
                onClick={onScanNext}
                disabled={pending}
              >
                Сканировать другой паспорт
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
