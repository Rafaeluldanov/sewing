'use client';

/**
 * Stage 2 «Мастер цеха» — мобильный bottom-sheet ручных действий
 * мастера над одним паспортом.
 *
 * Контракт API — `apps/api/src/modules/master-actions/*`,
 * server actions — `apps/web/app/master/master-actions-actions.ts`.
 * Контейнер — `apps/web/app/master/master-page-client.tsx` (открывает
 * sheet по нажатию на «Действия» в карточке вызова).
 *
 * Mobile-first ограничения (см. `docs/screens.md §«/master mobile actions UI»`):
 *   - bottom-sheet, не центрированный modal — удобно одной рукой;
 *   - крупные кнопки (`min-height: 56px`), select причины и textarea
 *     комментария — обязательный шаг перед confirm;
 *   - QR-сканер сотрудника / ячейки — общий `<QrScannerModal>`
 *     (тот же, что в `/work` и в основной кнопке «Сканировать QR
 *     сотрудника» на `/master`).
 */

import { useCallback, useMemo, useState } from 'react';
import {
  MASTER_ACTION_REASON_LABELS,
  MASTER_ACTION_REASONS,
  parseEmployeeQr,
  type MasterActionReason,
  type MasterCallPassportDto,
} from '@sewing/shared';
import { ModalPortal } from '@/components/modal-portal';
import { QrScannerModal } from '@/app/work/qr-scanner-modal';
import {
  masterReturnToCellAction,
  masterSetRouteStepAction,
  masterTransferToEmployeeAction,
  masterUnassignPassportAction,
  type MasterActionResult,
} from './master-actions-actions';

type ActionId = 'unassign' | 'transfer' | 'returnToCell' | 'setRouteStep';

interface Props {
  passport: MasterCallPassportDto;
  /** ФИО владельца паспорта на момент открытия sheet'а — для подсказки в заголовке. */
  ownerFullName: string;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

const ACTION_LABELS: Record<ActionId, string> = {
  unassign: 'Снять с сотрудника',
  transfer: 'Передать сотруднику',
  returnToCell: 'Вернуть в ячейку',
  setRouteStep: 'Назначить операцию',
};

const ACTION_HINTS: Record<ActionId, string> = {
  unassign:
    'Паспорт перестанет быть закреплён за сотрудником. Используйте, если он висит на человеке по ошибке.',
  transfer:
    'Передать паспорт другому сотруднику. Если у него открыта смена на операции маршрута — шаг автоматически обновится.',
  returnToCell:
    'Вернуть паспорт в ячейку. CellContent увеличится на qtyCut. Используйте, если паспорт ошибочно выдан.',
  setRouteStep:
    'Перевести паспорт на конкретный шаг маршрута заказа. Текущий владелец сбросится.',
};

export function PassportActionsSheet({
  passport,
  ownerFullName,
  onClose,
  onSuccess,
  onError,
}: Props) {
  const [action, setAction] = useState<ActionId | null>(null);

  return (
    <ModalPortal>
    <div
      className="master-actions-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={`Действия с паспортом ${passport.number}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="master-actions-sheet__card">
        <header className="master-actions-sheet__header">
          <div>
            <h3 className="master-actions-sheet__title">
              Паспорт {passport.number}
            </h3>
            <p className="master-actions-sheet__subtitle">
              Заказ {passport.orderNumber} · {passport.size}
              {passport.color ? ` · ${passport.color}` : ''} · qty{' '}
              {passport.qtyCut}
            </p>
            <p className="master-actions-sheet__meta">
              На сотруднике: <strong>{ownerFullName}</strong>
              {passport.currentOperation
                ? ` · операция ${passport.currentOperation.name}`
                : ''}
              {passport.currentCell
                ? ` · ячейка ${passport.currentCell.code}`
                : ''}
            </p>
          </div>
          <button
            type="button"
            className="master-actions-sheet__close"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ×
          </button>
        </header>

        {action === null ? (
          <div className="master-actions-sheet__menu">
            {(['unassign', 'transfer', 'returnToCell', 'setRouteStep'] as ActionId[]).map(
              (id) => (
                <button
                  key={id}
                  type="button"
                  className="master-actions-sheet__menu-item"
                  onClick={() => setAction(id)}
                >
                  <span className="master-actions-sheet__menu-label">
                    {ACTION_LABELS[id]}
                  </span>
                  <span className="master-actions-sheet__menu-hint">
                    {ACTION_HINTS[id]}
                  </span>
                </button>
              ),
            )}
          </div>
        ) : (
          <ActionBody
            action={action}
            passport={passport}
            onBack={() => setAction(null)}
            onClose={onClose}
            onSuccess={onSuccess}
            onError={onError}
          />
        )}
      </div>
    </div>
    </ModalPortal>
  );
}

interface ActionBodyProps {
  action: ActionId;
  passport: MasterCallPassportDto;
  onBack: () => void;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

function ActionBody({
  action,
  passport,
  onBack,
  onClose,
  onSuccess,
  onError,
}: ActionBodyProps) {
  const [reason, setReason] = useState<MasterActionReason | ''>('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  // Action-specific state
  const [employeeQr, setEmployeeQr] = useState<string>('');
  const [cellQr, setCellQr] = useState<string>('');
  const [routeStepIndex, setRouteStepIndex] = useState<number | ''>(
    passport.currentRouteStepIndex ?? '',
  );
  const [scanner, setScanner] = useState<null | 'employee' | 'cell'>(null);

  const canConfirm = useMemo(() => {
    if (!reason) return false;
    if (action === 'transfer') return employeeQr.trim().length > 0;
    if (action === 'returnToCell') return cellQr.trim().length > 0;
    if (action === 'setRouteStep') return routeStepIndex !== '';
    return true;
  }, [action, reason, employeeQr, cellQr, routeStepIndex]);

  const handleScan = useCallback(
    (decoded: string) => {
      if (scanner === 'employee') {
        // Принимаем сырой QR — server action парсит сам.
        // Подсказку даём только если префикс не совпал (мастер
        // должен видеть, что отсканировал не того).
        const parsed = parseEmployeeQr(decoded);
        if (!parsed) {
          onError('QR не распознан как сотрудник (ожидается EMPLOYEE:<id>)');
          setScanner(null);
          return;
        }
        setEmployeeQr(decoded);
      } else if (scanner === 'cell') {
        setCellQr(decoded);
      }
      setScanner(null);
    },
    [scanner, onError],
  );

  const submit = useCallback(async () => {
    if (!canConfirm || busy) return;
    setBusy(true);
    let res: MasterActionResult;
    try {
      if (action === 'unassign') {
        res = await masterUnassignPassportAction(passport.id, {
          reason,
          comment: comment.trim() ? comment.trim() : undefined,
        });
      } else if (action === 'transfer') {
        res = await masterTransferToEmployeeAction(passport.id, {
          reason,
          comment: comment.trim() ? comment.trim() : undefined,
          employeeQr: employeeQr.trim(),
        });
      } else if (action === 'returnToCell') {
        res = await masterReturnToCellAction(passport.id, {
          reason,
          comment: comment.trim() ? comment.trim() : undefined,
          cellQr: cellQr.trim(),
        });
      } else {
        res = await masterSetRouteStepAction(passport.id, {
          reason,
          comment: comment.trim() ? comment.trim() : undefined,
          routeStepIndex:
            typeof routeStepIndex === 'number' ? routeStepIndex : undefined,
        });
      }
    } finally {
      setBusy(false);
    }
    if (res.ok) {
      onSuccess('Действие выполнено');
      onClose();
    } else {
      onError(res.error);
    }
  }, [
    action,
    busy,
    canConfirm,
    cellQr,
    comment,
    employeeQr,
    onClose,
    onError,
    onSuccess,
    passport.id,
    reason,
    routeStepIndex,
  ]);

  return (
    <div className="master-actions-sheet__body">
      <button
        type="button"
        className="master-actions-sheet__back"
        onClick={onBack}
      >
        ← Назад к списку действий
      </button>
      <h4 className="master-actions-sheet__action-title">
        {ACTION_LABELS[action]}
      </h4>
      <p className="master-actions-sheet__action-hint">{ACTION_HINTS[action]}</p>

      {action === 'transfer' && (
        <div className="master-actions-sheet__field">
          <label className="master-actions-sheet__label">Сотрудник</label>
          <div className="master-actions-sheet__row">
            <input
              type="text"
              className="master-actions-sheet__input"
              placeholder="EMPLOYEE:<id>"
              value={employeeQr}
              onChange={(e) => setEmployeeQr(e.target.value)}
            />
            <button
              type="button"
              className="master-actions-sheet__scan"
              onClick={() => setScanner('employee')}
            >
              Сканировать QR
            </button>
          </div>
        </div>
      )}

      {action === 'returnToCell' && (
        <div className="master-actions-sheet__field">
          <label className="master-actions-sheet__label">Ячейка</label>
          <div className="master-actions-sheet__row">
            <input
              type="text"
              className="master-actions-sheet__input"
              placeholder="cell:<id> или код ячейки"
              value={cellQr}
              onChange={(e) => setCellQr(e.target.value)}
            />
            <button
              type="button"
              className="master-actions-sheet__scan"
              onClick={() => setScanner('cell')}
            >
              Сканировать QR
            </button>
          </div>
        </div>
      )}

      {action === 'setRouteStep' && (
        <div className="master-actions-sheet__field">
          <label className="master-actions-sheet__label">Шаг маршрута</label>
          {passport.routeSteps.length === 0 ? (
            <p className="master-actions-sheet__error" role="alert">
              У заказа нет snapshot маршрута — назначать нечего.
            </p>
          ) : (
            <ul className="master-actions-sheet__steps">
              {passport.routeSteps.map((s) => {
                const checked = routeStepIndex === s.index;
                return (
                  <li key={s.index}>
                    <label
                      className={`master-actions-sheet__step${checked ? ' master-actions-sheet__step--active' : ''}`}
                    >
                      <input
                        type="radio"
                        name="routeStep"
                        value={s.index}
                        checked={checked}
                        onChange={() => setRouteStepIndex(s.index)}
                      />
                      <span>
                        Шаг {s.index + 1}: {s.operationName}
                        {s.isCurrent ? ' (текущий)' : ''}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="master-actions-sheet__field">
        <label className="master-actions-sheet__label" htmlFor="reason">
          Причина <span className="master-actions-sheet__required">*</span>
        </label>
        <select
          id="reason"
          className="master-actions-sheet__input"
          value={reason}
          onChange={(e) =>
            setReason((e.target.value || '') as MasterActionReason | '')
          }
        >
          <option value="">— выберите причину —</option>
          {MASTER_ACTION_REASONS.map((r) => (
            <option key={r} value={r}>
              {MASTER_ACTION_REASON_LABELS[r]}
            </option>
          ))}
        </select>
      </div>

      <div className="master-actions-sheet__field">
        <label className="master-actions-sheet__label" htmlFor="comment">
          Комментарий (необязательно)
        </label>
        <textarea
          id="comment"
          className="master-actions-sheet__textarea"
          rows={3}
          maxLength={500}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Например: пересменка, паспорт ушёл другой швее"
        />
      </div>

      <button
        type="button"
        className="master-actions-sheet__confirm"
        onClick={submit}
        disabled={!canConfirm || busy}
      >
        {busy ? 'Выполняем…' : 'Подтвердить'}
      </button>

      {scanner && (
        <QrScannerModal
          onScan={handleScan}
          onClose={() => setScanner(null)}
        />
      )}
    </div>
  );
}

