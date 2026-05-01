'use client';

/**
 * Модалка визуальной сверки паспорта на /work для швеи.
 *
 * После скана QR паспорта швея видит крупно номер/изделие/цвет/размер/
 * количество/рулон + текущую операцию и оборудование. Никаких silent
 * confirm — только явный «Принять».
 */

import { useEffect } from 'react';
import type { ShiftSessionDto } from '@sewing/shared/shifts';

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

  return (
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
        </div>

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
  );
}
