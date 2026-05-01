'use client';

/**
 * Mobile-first старт смены для швеи.
 *
 * Поток (ТЗ §1):
 *   1. Большая primary-кнопка «Начать смену» — открывает камеру.
 *   2. После скана QR оборудования — показываем оборудование и список
 *      ДОПУСТИМЫХ для него операций (см. `lib/equipment-operations.ts`).
 *   3. Швея выбирает операцию и подтверждает смену (`startShiftAction`).
 *
 * Ручной ввод кода оборудования сохранён как secondary action (fallback),
 * но не шумит в основном экране. Никаких выпадашек со ВСЕМИ операциями
 * цеха.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import type {
  EmployeeLiteDto,
  EquipmentLiteDto,
  OperationLiteDto,
  ShiftMetaDto,
} from '@sewing/shared/shifts';
import { startShiftAction } from './actions';
import { initialWorkFormState } from './state';
import { QrScannerModal } from './qr-scanner-modal';
import {
  matchEquipmentByCode,
  operationsForEquipment,
} from '@/lib/equipment-operations';

interface Props {
  meta: ShiftMetaDto;
  employee: EmployeeLiteDto;
}

function ConfirmShiftButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary btn-lg btn-block"
      disabled={pending}
    >
      {pending ? 'Подтверждаем…' : 'Подтвердить смену'}
    </button>
  );
}

export function SeamstressShiftStart({ meta, employee }: Props) {
  const [state, formAction] = useFormState(
    startShiftAction,
    initialWorkFormState,
  );

  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [equipment, setEquipment] = useState<EquipmentLiteDto | null>(null);
  const [operationId, setOperationId] = useState<string>('');
  const [localError, setLocalError] = useState<string | null>(null);
  const manualInputRef = useRef<HTMLInputElement>(null);

  // Подбираем доступные операции под выбранное оборудование. Если
  // оборудование ещё не выбрано — список пустой (стадия `idle`).
  const availableOperations = useMemo<OperationLiteDto[]>(
    () =>
      equipment ? operationsForEquipment(equipment, meta.operations) : [],
    [equipment, meta.operations],
  );

  // Когда меняется список операций — пред-выбираем первую, чтобы швея
  // могла сразу нажать «Подтвердить смену» одной рукой.
  useEffect(() => {
    if (availableOperations.length === 0) {
      setOperationId('');
      return;
    }
    if (!availableOperations.some((o) => o.id === operationId)) {
      setOperationId(availableOperations[0]!.id);
    }
  }, [availableOperations, operationId]);

  useEffect(() => {
    if (manualOpen) manualInputRef.current?.focus();
  }, [manualOpen]);

  const tryAcceptCode = (raw: string) => {
    const eq = matchEquipmentByCode(meta.equipment, raw);
    if (!eq) {
      setLocalError(
        `Оборудование не распознано: «${raw.trim()}». Сканируйте QR со станка или введите его код.`,
      );
      return;
    }
    if (!eq.active) {
      setLocalError(`Оборудование «${eq.name}» неактивно. Обратитесь к мастеру.`);
      return;
    }
    setLocalError(null);
    setEquipment(eq);
    setManualOpen(false);
    setManualCode('');
  };

  const handleScan = (decoded: string) => {
    setScannerOpen(false);
    tryAcceptCode(decoded);
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    tryAcceptCode(manualCode);
  };

  // -------------------------------------------------------------------
  // RENDER
  // -------------------------------------------------------------------

  if (!equipment) {
    return (
      <>
        <div
          className="scan-card scan-card--simple"
          aria-label="Начать смену — сканировать оборудование"
        >
          <div>
            <h2 className="scan-card__title">Начать смену</h2>
            <p className="scan-card__hint">
              Сканируйте QR-код вашего станка — система покажет, какие
              операции на нём можно выполнять.
            </p>
          </div>

          {(localError || state.error) && (
            <div className="error-box" role="alert">
              <div className="error-box__msg">
                {localError ?? state.error}
              </div>
              {state.errorRequestId && (
                <div className="error-box__rid">
                  req: <code>{state.errorRequestId}</code>
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            className="btn btn-primary btn-lg btn-block scan-card__primary-camera"
            onClick={() => {
              setLocalError(null);
              setScannerOpen(true);
            }}
          >
            Начать смену
          </button>

          {manualOpen ? (
            <form
              onSubmit={handleManualSubmit}
              className="seamstress-start__manual"
              aria-label="Ввести код оборудования вручную"
            >
              <label
                className="scan-card__input"
                htmlFor="seamstress-equipment-code"
              >
                <span className="scan-card__input-label">
                  Код оборудования
                </span>
                <input
                  ref={manualInputRef}
                  id="seamstress-equipment-code"
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="например, overlock-01"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                />
              </label>
              <button type="submit" className="btn btn-block">
                Подтвердить код
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="scan-card__manual-toggle"
              onClick={() => setManualOpen(true)}
            >
              Ввести код вручную
            </button>
          )}

          <p className="scan-card__hint" style={{ marginBottom: 0 }}>
            Сотрудник:{' '}
            <strong style={{ color: 'var(--color-fg)' }}>
              {employee.fullName}
            </strong>
          </p>
        </div>
        {scannerOpen && (
          <QrScannerModal
            onScan={handleScan}
            onClose={() => setScannerOpen(false)}
          />
        )}
      </>
    );
  }

  // ------------------- stage: pick-operation -------------------------

  return (
    <form
      action={formAction}
      className="scan-card scan-card--simple"
      aria-label="Подтвердить смену"
    >
      <div>
        <h2 className="scan-card__title">Выберите операцию</h2>
        <p className="scan-card__hint">
          Доступные операции для вашего оборудования.
        </p>
      </div>

      <div className="seamstress-start__equipment" role="status">
        <span className="seamstress-start__equipment-label">Оборудование</span>
        <span className="seamstress-start__equipment-name">{equipment.name}</span>
        <span className="seamstress-start__equipment-meta">{equipment.code}</span>
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">{state.error}</div>
          {state.errorRequestId && (
            <div className="error-box__rid">
              req: <code>{state.errorRequestId}</code>
            </div>
          )}
        </div>
      )}

      {availableOperations.length === 0 ? (
        <div className="error-box" role="alert">
          <div className="error-box__msg">
            Для этого оборудования нет настроенных операций. Обратитесь
            к мастеру.
          </div>
        </div>
      ) : (
        <div
          role="radiogroup"
          aria-label="Доступные операции"
          className="seamstress-start__ops"
        >
          {availableOperations.map((op) => {
            const checked = op.id === operationId;
            return (
              <label
                key={op.id}
                className={`seamstress-start__op${checked ? ' is-active' : ''}`}
              >
                <input
                  type="radio"
                  name="operationId"
                  value={op.id}
                  checked={checked}
                  onChange={() => setOperationId(op.id)}
                />
                <span className="seamstress-start__op-name">{op.name}</span>
                <span className="seamstress-start__op-meta">{op.code}</span>
              </label>
            );
          })}
        </div>
      )}

      <input type="hidden" name="equipmentId" value={equipment.id} />

      <ConfirmShiftButton />

      <button
        type="button"
        className="scan-card__manual-toggle"
        onClick={() => {
          setEquipment(null);
          setOperationId('');
          setLocalError(null);
        }}
      >
        Сменить оборудование
      </button>
    </form>
  );
}
