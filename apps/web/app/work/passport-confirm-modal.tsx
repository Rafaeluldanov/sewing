'use client';

/**
 * Модалка визуальной сверки паспорта на /work для швеи.
 *
 * После скана QR паспорта швея видит крупно номер/изделие/цвет/размер/
 * количество/рулон + текущую операцию и оборудование. Никаких silent
 * confirm — только явный «Принять».
 */

import { useEffect } from 'react';
import { ModalPortal } from '@/components/modal-portal';
import type { ShiftSessionDto } from '@sewing/shared/shifts';
import type { PassportRouteHintDto } from '@sewing/shared/passports';

export interface PassportConfirmData {
  id: string;
  number: string;
  productName: string;
  color: string;
  sizeCode: string;
  qtyCut: number;
  qtyGood: number;
  rollNumber: string;
  status: string;
  /**
   * Soft-route MVP (STEP 8 ТЗ): подсказка по маршруту (`OrderRouteStep`
   * snapshot) + сравнение с активной сменой. `null` — у заказа нет
   * маршрута, блок просто не рендерим. См. `docs/domain.md §«Маршруты
   * производства»`.
   */
  routeHint: PassportRouteHintDto | null;
  /**
   * Признак «паспорт в маршрутном потоке» — `currentRouteStepIndex !== null`.
   * Симметрично серверному правилу route-WIP в
   * `PassportsService.issueToEmployee` (см. `docs/domain.md §«Маршруты
   * производства»`, `docs/flows.md §F3a`). UI использует этот флаг,
   * чтобы поменять copy и не подсвечивать отсутствие ячейки как
   * проблему. `null` — заказ без маршрута, legacy cell-based flow.
   */
  currentRouteStepIndex: number | null;
  /**
   * Код текущей ячейки паспорта (`Passport.currentCell.code`). `null` —
   * ячейки нет: либо паспорт ещё не размещён, либо он в маршрутном
   * потоке между шагами (route-WIP). Для legacy flow модалка
   * показывает строку «Ячейка», для route-WIP без ячейки — спокойный
   * subtext «Ячейка не требуется», а не тревогу.
   */
  currentCellCode: string | null;
}

interface Props {
  passport: PassportConfirmData;
  shift: Pick<
    ShiftSessionDto,
    'operationName' | 'operationCode' | 'equipmentName' | 'equipmentCode'
  >;
  onAccept: () => void;
  onCancel: () => void;
  pending?: boolean;
  /**
   * Локализованные надписи. По умолчанию модалка играет роль
   * визуальной сверки перед приёмом кроя (issue). Для сценария
   * «Завершить операцию» (ТЗ §1) передаём отдельные строки — контракт
   * остаётся тот же, меняется только вербалайз.
   */
  title?: string;
  acceptLabel?: string;
  pendingLabel?: string;
}

export function PassportConfirmModal({
  passport,
  shift,
  onAccept,
  onCancel,
  pending = false,
  title = 'Проверка паспорта',
  acceptLabel = 'Принять',
  pendingLabel = 'Принимаем…',
}: Props) {
  // Esc → отмена. Без побочных эффектов: всё локально модалке.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, pending]);

  // Route-WIP UI критерий — единый для всех мест /work (см.
  // `current-work-card.tsx`, `state.ts`). Симметричен серверному
  // правилу в `PassportsService.issueToEmployee`.
  const isRouteWip = passport.currentRouteStepIndex !== null;
  // «Маршрутный поток без буфера»: паспорт в маршруте и при этом не
  // лежит в ячейке. Только в этом случае мы заменяем складскую
  // подсказку на маршрутную («Ячейка не требуется»). Если route-WIP
  // паспорт временно положили в ячейку как буфер — UI продолжает
  // показывать обычную строку «Ячейка», без drama.
  const showRouteOnlyHint = isRouteWip && !passport.currentCellCode;

  return (
    <ModalPortal>
    <div
      className="qr-modal passport-confirm"
      role="dialog"
      aria-modal="true"
          aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onCancel();
      }}
    >
      <div className="qr-modal__card passport-confirm__card">
        <div className="qr-modal__header">
          <h3 className="qr-modal__title">{title}</h3>
          <button
            type="button"
            className="qr-modal__close"
            onClick={onCancel}
            aria-label="Закрыть"
            disabled={pending}
          >
            ×
          </button>
        </div>

        <div className="passport-confirm__number">
          <span className="passport-confirm__number-label">Паспорт</span>
          <span className="passport-confirm__number-value">{passport.number}</span>
          {isRouteWip && (
            <span
              className="passport-confirm__route-badge"
              aria-label="Паспорт идёт по маршруту"
            >
              Из маршрута
            </span>
          )}
        </div>

        {showRouteOnlyHint && (
          <p
            className="passport-confirm__route-subtext"
            role="status"
            aria-live="polite"
          >
            Паспорт идёт по маршрутному потоку — ячейка не требуется.
          </p>
        )}

        <dl className="passport-confirm__grid">
          <div>
            <dt>Изделие</dt>
            <dd>{passport.productName}</dd>
          </div>
          <div>
            <dt>Цвет</dt>
            <dd>{passport.color}</dd>
          </div>
          <div>
            <dt>Размер</dt>
            <dd className="passport-confirm__size">{passport.sizeCode}</dd>
          </div>
          <div>
            <dt>Количество</dt>
            <dd className="passport-confirm__qty">
              {passport.qtyCut} шт
              {passport.qtyGood !== passport.qtyCut ? (
                <span className="passport-confirm__qty-meta">
                  {' '}· годных {passport.qtyGood}
                </span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Рулон</dt>
            <dd>{passport.rollNumber}</dd>
          </div>
        </dl>

        <div className="passport-confirm__shift">
          <div>
            <span className="passport-confirm__shift-label">Операция</span>
            <span className="passport-confirm__shift-value">
              {shift.operationName}
            </span>
            <span className="passport-confirm__shift-meta">
              {shift.operationCode}
            </span>
          </div>
          <div>
            <span className="passport-confirm__shift-label">Оборудование</span>
            <span className="passport-confirm__shift-value">
              {shift.equipmentName}
            </span>
            <span className="passport-confirm__shift-meta">
              {shift.equipmentCode}
            </span>
          </div>
        </div>

        {passport.routeHint && (
          <PassportRouteHintBlock hint={passport.routeHint} />
        )}

        <div className="passport-confirm__actions">
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
            className="btn btn-primary btn-lg btn-block"
            onClick={onAccept}
            disabled={pending}
          >
            {pending ? pendingLabel : acceptLabel}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

/**
 * Soft-route MVP (STEP 8 ТЗ): компактный блок «маршрут» в модалке
 * сверки паспорта. Показывает:
 *   - текущий шаг (`hint.currentRouteStep`);
 *   - следующий шаг (`hint.nextRouteStep`) или «последний шаг», если
 *     маршрут уже на конце;
 *   - предупреждение, если активная смена сотрудника не совпадает с
 *     ожидаемым шагом маршрута (`hint.routeMismatchWithActiveShift`).
 *
 * Все надписи — read-only, никаких блокировок и disabled-кнопок.
 * Стили — общие с `current-work-card.tsx`, чтобы оператор видел один
 * и тот же визуальный язык что в карточке активного кроя, что в модалке.
 */
function PassportRouteHintBlock({ hint }: { hint: PassportRouteHintDto }) {
  const { currentRouteStep, nextRouteStep, routeMismatchWithActiveShift } =
    hint;
  return (
    <div className="active-passport__route" aria-label="Маршрут заказа">
      <div className="active-passport__route-row">
        <span className="active-passport__route-label">Сейчас</span>
        <span className="active-passport__route-value">
          {currentRouteStep ? (
            <>
              Шаг {currentRouteStep.index + 1}: {currentRouteStep.operationName}
              <span className="active-passport__route-code">
                {' '}
                {currentRouteStep.operationCode}
              </span>
            </>
          ) : (
            '— ещё не начат'
          )}
        </span>
      </div>
      <div className="active-passport__route-row">
        <span className="active-passport__route-label">Далее</span>
        <span className="active-passport__route-value">
          {nextRouteStep ? (
            <>
              Шаг {nextRouteStep.index + 1}: {nextRouteStep.operationName}
              <span className="active-passport__route-code">
                {' '}
                {nextRouteStep.operationCode}
              </span>
            </>
          ) : (
            '— последний шаг маршрута'
          )}
        </span>
      </div>
      {routeMismatchWithActiveShift && (
        <p className="active-passport__route-warn" role="status">
          <strong>Внимание:</strong> ваша смена идёт на операции{' '}
          <em>{hint.activeShiftOperationName ?? '—'}</em>, а маршрут заказа
          ожидает <em>{hint.expectedOperationName ?? '—'}</em>. Это
          подсказка, паспорт не блокируется.
        </p>
      )}
    </div>
  );
}
