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

import { useRef, useState } from 'react';
import type {
  DefectTypeDto,
  EligibleReworkTargetDto,
  QcPassportDetailDto,
} from '@sewing/shared/qc';
import { PASSPORT_STATUS_LABELS } from '@/lib/passport-status-labels';
import { DefectTypeCreatableSelect } from '@/components/qc/defect-type-creatable-select';

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
  /** Фича «Корректировка фактического количества» (флаг
   *  `FEATURE_QTY_CORRECTION`, прокинут из RSC). */
  qtyCorrectionEnabled: boolean;
  onDefectSubmit: (form: FormData) => void;
  onComplete: () => void;
  /** «Вернуть на переделку» — отдаём паспорт обратно швее на
   *  выбранную SEW-операцию из `detail.eligibleReworkTargets`.
   *  См. `docs/flows.md §F5a`. */
  onReturnToRework: (targetOperationId: string) => void;
  /** ОТК предлагает новое фактическое количество (→ мастеру на
   *  согласование). См. `PassportQtyCorrectionsService`. */
  onQtyCorrectionSubmit: (qtyAfter: number, reason: string | undefined) => void;
  /** ОТК отзывает свою открытую заявку на корректировку. */
  onQtyCorrectionCancel: (correctionId: string) => void;
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
  qtyCorrectionEnabled,
  onDefectSubmit,
  onComplete,
  onReturnToRework,
  onQtyCorrectionSubmit,
  onQtyCorrectionCancel,
  onScanNext,
  onRefresh,
}: Props) {
  const formRef = useRef<HTMLFormElement | null>(null);
  // Локальное состояние picker'а «куда вернуть». Если eligibleReworkTargets
  // содержит несколько SEW-операций — открываем inline-список с radio.
  // Закрывается «Отмена» или успешным запуском возврата.
  const [reworkPickerOpen, setReworkPickerOpen] = useState(false);
  const [reworkPicked, setReworkPicked] = useState<string | null>(null);
  // Инлайн-форма «Корректировка количества».
  const [qtyCorrectionOpen, setQtyCorrectionOpen] = useState(false);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    onDefectSubmit(new FormData(form));
    form.reset();
  };

  const handleReworkClick = () => {
    setReworkPicked(detail.eligibleReworkTargets[0]?.operationId ?? null);
    setReworkPickerOpen(true);
  };

  const handleReworkConfirm = () => {
    if (!reworkPicked) return;
    const target = detail.eligibleReworkTargets.find(
      (t) => t.operationId === reworkPicked,
    );
    if (!target) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        `Вернуть ${detail.passportNumber} на ${target.operationName} ` +
          `(${target.finisherEmployeeName})?\n\n` +
          `Pending-начисление за эту операцию будет отозвано.`,
      )
    ) {
      return;
    }
    setReworkPickerOpen(false);
    onReturnToRework(target.operationId);
  };

  const handleReworkCancel = () => {
    setReworkPickerOpen(false);
    setReworkPicked(null);
  };

  const completed = !!detail.qcCompletedAt;
  const completedLabel = completed
    ? `Проверка выполнена · ${formatDateTime(detail.qcCompletedAt)}`
    : null;

  // Read-only режим, когда ОТК уже отправил паспорт на переделку и
  // ждёт сканирования швеёй. См. `QcService.returnToRework` —
  // `reworkPending` приходит с бэка.
  const reworkPending = detail.reworkPending;

  // Блок брака — только в работе (не после complete, не в read-only
  // rework-pending) и пока backend разрешает фиксировать брак.
  const showDefectForm =
    !completed && !reworkPending && detail.canRecordDefect;
  const showDefectEmpty =
    !completed && !reworkPending && !detail.canRecordDefect;

  // Корректировка фактического количества: доступна, пока паспорт в
  // работе и по нему нет открытой заявки. Если заявка уже висит —
  // показываем баннер «ждёт мастера» с кнопкой «Отозвать».
  const pendingCorrection = detail.pendingQtyCorrection;
  const showQtyCorrectionButton =
    qtyCorrectionEnabled &&
    !completed &&
    !reworkPending &&
    detail.status === 'IN_PROGRESS' &&
    !pendingCorrection;

  const handleQtyCorrectionConfirm = (
    qtyAfter: number,
    reason: string | undefined,
  ) => {
    setQtyCorrectionOpen(false);
    onQtyCorrectionSubmit(qtyAfter, reason);
  };

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

      {pendingCorrection && (
        <div className="info-box" role="status">
          <strong>
            Корректировка {pendingCorrection.qtyBefore} →{' '}
            {pendingCorrection.qtyAfter} ждёт мастера.
          </strong>{' '}
          Цифры обновятся после подтверждения.
          <div style={{ marginTop: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-block"
              onClick={() => onQtyCorrectionCancel(pendingCorrection.id)}
              disabled={pending}
            >
              Отозвать заявку
            </button>
          </div>
        </div>
      )}

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

      {reworkPending && (
        <div className="error-box" role="status">
          <div className="error-box__msg">
            Сейчас на переделке у{' '}
            <strong>
              {detail.reworkAssignment?.employeeName ?? 'предыдущей швеи'}
            </strong>
            {detail.reworkAssignment
              ? ` · ${detail.reworkAssignment.operationName}`
              : null}
            . Ждёт сканирования.
          </div>
        </div>
      )}

      {detail.incomingReworkAtQc && (
        <div className="info-box" role="status">
          <strong>Возвращён мастером на повторную проверку.</strong>
          {' '}Зафиксируйте брак (если есть) и нажмите «Проверка выполнена».
        </div>
      )}

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
              <DefectTypeCreatableSelect
                id="qc-defect-type"
                name="defectTypeId"
                defaultValue=""
                required
                disabled={pending}
                disableCreate={pending}
                defectTypes={defectTypes}
              />
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
      {reworkPickerOpen && (
        <ReworkPicker
          targets={detail.eligibleReworkTargets}
          picked={reworkPicked}
          onChange={setReworkPicked}
          onConfirm={handleReworkConfirm}
          onCancel={handleReworkCancel}
          pending={pending}
        />
      )}

      {qtyCorrectionOpen && (
        <QtyCorrectionSheet
          currentQtyGood={detail.qtyGood}
          qtyCut={detail.qtyCut}
          pending={pending}
          onConfirm={handleQtyCorrectionConfirm}
          onCancel={() => setQtyCorrectionOpen(false)}
        />
      )}

      <div className="qc-card__sticky-actions">
        {completed || reworkPending ? (
          <button
            type="button"
            className="btn btn-primary btn-block btn-lg"
            onClick={onScanNext}
            disabled={pending}
          >
            Сканировать другой паспорт
          </button>
        ) : reworkPickerOpen || qtyCorrectionOpen ? null : (
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
            {showQtyCorrectionButton && (
              <button
                type="button"
                className="btn btn-block"
                onClick={() => setQtyCorrectionOpen(true)}
                disabled={pending}
              >
                ✎ Корректировка количества
              </button>
            )}
            {detail.canReturnToRework && (
              <button
                type="button"
                className="btn btn-block"
                onClick={handleReworkClick}
                disabled={pending}
              >
                {pending ? 'Возвращаем…' : '↺ Вернуть на переделку'}
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
            {!detail.canRecordDefect &&
              !detail.canCompleteQc &&
              !detail.canReturnToRework && (
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

/**
 * Inline picker «куда вернуть на переделку». Появляется в карточке
 * ОТК при клике на «↺ Вернуть на переделку», когда в маршруте есть
 * несколько SEW-операций (КИПЕРКА / ОВЕРЛОК / РАСПОШИВ и т.п.).
 * Источник списка — `QcPassportDetailDto.eligibleReworkTargets`
 * (см. `QcService.computeEligibleReworkTargets`).
 *
 * После выбора и клика «Вернуть» — нативный `confirm` с именем
 * швеи-получателя, затем вызов `onReturnToRework(operationId)`.
 */
function ReworkPicker({
  targets,
  picked,
  onChange,
  onConfirm,
  onCancel,
  pending,
}: {
  targets: EligibleReworkTargetDto[];
  picked: string | null;
  onChange: (operationId: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  return (
    <section
      className="qc-card__rework-picker"
      aria-label="Куда вернуть на переделку"
    >
      <h3 className="qc-card__section-title">Вернуть на переделку</h3>
      <p className="hint">Выберите операцию и швею, которой возвращаем:</p>
      <ul className="qc-card__rework-list">
        {targets.map((t) => (
          <li key={t.operationId}>
            <label className="qc-card__rework-option">
              <input
                type="radio"
                name="qc-rework-target"
                value={t.operationId}
                checked={picked === t.operationId}
                onChange={() => onChange(t.operationId)}
                disabled={pending}
              />
              <span>
                <strong>{t.operationName}</strong> · {t.finisherEmployeeName}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="qc-card__rework-picker-actions">
        <button
          type="button"
          className="btn btn-block"
          onClick={onCancel}
          disabled={pending}
        >
          Отмена
        </button>
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={onConfirm}
          disabled={pending || !picked}
        >
          {pending ? 'Возвращаем…' : 'Вернуть'}
        </button>
      </div>
    </section>
  );
}

/**
 * Инлайн-форма «Корректировка количества». ОТК вводит фактическое
 * количество (можно и больше, и меньше текущего) и необязательную
 * причину; по «Отправить мастеру» создаётся заявка на согласование
 * (см. `PassportQtyCorrectionsService.create`). Сами цифры паспорта
 * меняются только после подтверждения мастером.
 */
function QtyCorrectionSheet({
  currentQtyGood,
  qtyCut,
  pending,
  onConfirm,
  onCancel,
}: {
  currentQtyGood: number;
  qtyCut: number;
  pending: boolean;
  onConfirm: (qtyAfter: number, reason: string | undefined) => void;
  onCancel: () => void;
}) {
  const [qty, setQty] = useState<string>(String(currentQtyGood));
  const [reason, setReason] = useState<string>('');

  const parsed = Number(qty);
  const valid = Number.isInteger(parsed) && parsed >= 0;
  const delta = valid ? parsed - currentQtyGood : 0;
  const deltaLabel = delta > 0 ? `+${delta}` : String(delta);
  const changed = valid && delta !== 0;
  // Больше, чем раскроено — не запрещаем, но предупреждаем.
  const aboveCut = valid && parsed > qtyCut;

  const handleConfirm = () => {
    if (!valid || !changed) return;
    onConfirm(parsed, reason.trim() ? reason.trim() : undefined);
  };

  return (
    <section
      className="qc-card__rework-picker"
      aria-label="Корректировка количества"
    >
      <h3 className="qc-card__section-title">Корректировка количества</h3>
      <p className="hint">
        По паспорту сейчас <strong>{currentQtyGood} шт.</strong> Укажите
        фактическое количество в партии.
      </p>
      <div className="form-row">
        <label htmlFor="qc-qty-correction">Фактическое количество, шт.</label>
        <div>
          <input
            id="qc-qty-correction"
            type="number"
            min={0}
            step={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            disabled={pending}
            autoFocus
          />
          <div className="hint">
            {changed ? (
              <>
                Было <strong>{currentQtyGood}</strong> → станет{' '}
                <strong>{parsed}</strong> ({deltaLabel}).
              </>
            ) : (
              'Введите число, отличное от текущего.'
            )}
            {aboveCut && (
              <>
                {' '}
                <strong>Больше, чем раскроено ({qtyCut}).</strong> Проверьте.
              </>
            )}
          </div>
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="qc-qty-correction-reason">Причина</label>
        <div>
          <textarea
            id="qc-qty-correction-reason"
            rows={2}
            maxLength={280}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Необязательно, до 280 символов"
            disabled={pending}
          />
        </div>
      </div>
      <div className="qc-card__rework-picker-actions">
        <button
          type="button"
          className="btn btn-block"
          onClick={onCancel}
          disabled={pending}
        >
          Отмена
        </button>
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={handleConfirm}
          disabled={pending || !valid || !changed}
        >
          {pending ? 'Отправка…' : 'Отправить мастеру'}
        </button>
      </div>
    </section>
  );
}
