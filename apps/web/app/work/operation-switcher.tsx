'use client';

/**
 * Тумблер «Сменить операцию» для активной смены швеи (см. ТЗ
 * `docs/flows.md §F8`, ADR-0017 §«EquipmentOperation»).
 *
 * Поведение:
 *   - рендерится только если у текущего оборудования смены 2+
 *     разрешённых операций (`EquipmentOperation`). Иначе и
 *     переключать не на что — компонент возвращает `null`;
 *   - показывает chip-кнопку с названием текущей операции; по клику
 *     открывает модалку со списком альтернатив (большие touch-таргеты
 *     под мобильный экран швеи);
 *   - на выбор зовёт `switchShiftOperationAction(operationId)` и при
 *     успехе делает `router.refresh()` — заголовок и `shift.operationName`
 *     в `SeamstressActivePanel` сразу обновляются.
 *
 * Backend требует, чтобы у швеи в этот момент не было паспортов в
 * работе (`SHIFT_HAS_ACTIVE_PASSPORTS`). Сообщение из ответа мы
 * показываем inline в модалке — это естественная подсказка «закройте
 * текущий крой и попробуйте снова». Никаких local-side проверок не
 * делаем: источник истины — backend.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ModalPortal } from '@/components/modal-portal';
import type {
  OperationLiteDto,
  ShiftSessionDto,
} from '@sewing/shared/shifts';
import { switchShiftOperationAction } from './actions';

interface Props {
  shift: ShiftSessionDto;
  /**
   * Все операции, разрешённые на оборудовании текущей смены
   * (включая активную). Источник — `operationsForEquipment(meta)` в
   * server-component `/work/page.tsx`.
   */
  availableOperations: OperationLiteDto[];
}

export function OperationSwitcher({ shift, availableOperations }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | undefined>();
  const [isPending, startTransition] = useTransition();

  // Нет альтернатив — переключать не на что, прячемся целиком.
  if (availableOperations.length < 2) return null;

  const handleSwitch = (operationId: string) => {
    if (operationId === shift.operationId) {
      setOpen(false);
      return;
    }
    setError(null);
    setErrorRequestId(undefined);
    startTransition(async () => {
      const res = await switchShiftOperationAction(operationId);
      if (res.error) {
        setError(res.error);
        setErrorRequestId(res.errorRequestId);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        className="operation-switcher__chip"
        onClick={() => {
          setError(null);
          setErrorRequestId(undefined);
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="operation-switcher__chip-label">
          Операция: <strong>{shift.operationName}</strong>
        </span>
        <span className="operation-switcher__chip-cta" aria-hidden="true">
          Сменить
        </span>
      </button>

      {open && (
        <ModalPortal>
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={() => !isPending && setOpen(false)}
          >
            <div
              className="modal modal--operation-switcher"
              role="dialog"
              aria-modal="true"
              aria-labelledby="operation-switcher-title"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 id="operation-switcher-title" className="modal__title">
                Сменить операцию
              </h2>
              <p className="modal__text modal__text--muted">
                Смена и оборудование останутся прежними. Чтобы переключиться,
                сначала завершите все активные кройи.
              </p>
              <ul className="operation-switcher__list">
                {availableOperations.map((op) => {
                  const isActive = op.id === shift.operationId;
                  return (
                    <li key={op.id}>
                      <button
                        type="button"
                        className={`operation-switcher__option${
                          isActive ? ' is-active' : ''
                        }`}
                        onClick={() => handleSwitch(op.id)}
                        disabled={isPending || isActive}
                        aria-pressed={isActive}
                      >
                        <span className="operation-switcher__option-name">
                          {op.name}
                        </span>
                        <span className="operation-switcher__option-code">
                          {op.code}
                        </span>
                        {isActive && (
                          <span
                            className="operation-switcher__option-badge"
                            aria-label="Текущая операция"
                          >
                            сейчас
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {error && (
                <div className="error-box" role="alert">
                  <div className="error-box__msg">{error}</div>
                  {errorRequestId && (
                    <div className="error-box__rid">
                      req: <code>{errorRequestId}</code>
                    </div>
                  )}
                </div>
              )}
              <div className="modal__actions">
                <button
                  type="button"
                  className="btn btn-block"
                  onClick={() => setOpen(false)}
                  disabled={isPending}
                >
                  Закрыть
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </>
  );
}
