'use client';

/**
 * Блок «Опасная зона» для карточки операции
 * (`/admin/operations/[id]`). Физическое удаление операции.
 *
 * Двухуровневая модель удаления (см. `OperationsService`):
 *   - мягкое — тумблер «Активна» в форме слева (`isActive = false`):
 *     история и тарифы сохраняются, операция уходит из рабочих списков;
 *   - физическое (этот блок) — доступно только `ADMIN` и только когда
 *     на операцию нет ни одной ссылки (`blockers.hardDeleteAllowed`).
 *     Иначе кнопка disabled и под ней список блокеров с предложением
 *     деактивировать операцию.
 *
 * Кнопка «Удалить навсегда» открывает модалку подтверждения с вводом
 * кода операции (anti-bumblefuck), по тому же паттерну, что и
 * `EmployeeDangerZone`. После успешного удаления уводим на список
 * (`router.push('/admin/operations')`), чтобы не остаться на 404
 * удалённой операции.
 *
 * Preflight (`getOperationBlockers`) приходит из RSC — здесь только
 * рендер и вызов server action.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import type {
  OperationBlockersResponse,
  OperationDeleteBlockerDto,
  OperationDeleteBlockerKind,
  OperationDetailDto,
} from '@sewing/shared/operations';
import { ModalPortal } from '@/components/modal-portal';
import { deleteOperationAction } from '../actions';

/**
 * Человекочитаемые подписи блокеров удаления (см.
 * `OPERATION_DELETE_BLOCKER_KINDS` в `@sewing/shared/operations`).
 */
const BLOCKER_LABELS: Record<OperationDeleteBlockerKind, string> = {
  OperationEntry: 'Сдельные начисления (зарплата)',
  PassportEvent: 'События паспортов (история)',
  OrderRouteStep: 'Шаги в маршрутах заказов',
  RouteTemplateStep: 'Шаги в шаблонах маршрутов',
  ShiftSession: 'Смены на этой операции',
  CurrentPassport: 'Паспорта стоят на операции сейчас',
  MasterCall: 'Вызовы мастера',
  OperationSubstitution: 'Substitute-правила параллельной группы',
};

function describeBlocker(b: OperationDeleteBlockerDto): string {
  return `${BLOCKER_LABELS[b.kind] ?? b.kind}: ${b.count}`;
}

interface Props {
  operation: OperationDetailDto;
  blockers: OperationBlockersResponse;
  /** Роль текущего viewer'а — гейт hard-delete (ADMIN only). */
  viewerRole: string;
}

export function OperationDangerZone({ operation, blockers, viewerRole }: Props) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  const canHardDelete = viewerRole === 'ADMIN';

  return (
    <section className="employee-danger-zone" aria-labelledby="op-danger-title">
      <div className="employee-danger-zone__head">
        <AlertTriangle size={16} strokeWidth={1.8} aria-hidden />
        <h2 id="op-danger-title" className="employee-danger-zone__title">
          Опасная зона
        </h2>
      </div>

      <div className="employee-danger-zone__row">
        <div className="employee-danger-zone__text">
          <strong>Удалить навсегда</strong>
          <p className="admin-muted">
            Доступно только для операций без истории и маршрутов. Запись
            пропадёт из БД вместе с тарифами, нормами времени и привязкой
            к станкам; в журнале аудита останется снимок. Чтобы просто
            убрать операцию из рабочих списков, выключите тумблер
            «Активна» в форме слева — это обратимо.
          </p>
          {blockers.blockers.length > 0 && (
            <ul className="employee-danger-zone__blockers" role="status">
              {blockers.blockers.map((b) => (
                <li key={b.kind}>{describeBlocker(b)}</li>
              ))}
            </ul>
          )}
          {!canHardDelete && (
            <p className="employee-danger-zone__hint">
              Удаление доступно только пользователю с ролью администратора.
            </p>
          )}
        </div>
        <button
          type="button"
          className="admin-btn admin-btn--danger"
          onClick={() => setOpen(true)}
          disabled={!canHardDelete || !blockers.hardDeleteAllowed}
          title={
            !canHardDelete
              ? 'Только для администратора'
              : !blockers.hardDeleteAllowed
                ? 'У операции есть история или маршруты — только деактивация'
                : undefined
          }
        >
          <Trash2 size={16} strokeWidth={1.6} aria-hidden />
          Удалить навсегда
        </button>
      </div>

      {open && (
        <HardDeleteModal
          operation={operation}
          onClose={() => setOpen(false)}
          onDeleted={() => {
            setOpen(false);
            router.push('/admin/operations');
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

interface ModalProps {
  operation: OperationDetailDto;
  onClose: () => void;
  onDeleted: () => void;
}

function HardDeleteModal({ operation, onClose, onDeleted }: ModalProps) {
  const [codeInput, setCodeInput] = useState('');
  const [pending, startPending] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const codeMatches =
    codeInput.trim().toUpperCase() === operation.code.toUpperCase();
  const canSubmit = codeMatches && !pending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);
    startPending(async () => {
      const res = await deleteOperationAction(operation.id);
      if (res.error) {
        setError(res.error);
        return;
      }
      onDeleted();
    });
  };

  return (
    <ModalPortal>
      <div
        className="qr-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="op-hard-delete-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="qr-modal__card hard-delete-modal__card">
          <div className="qr-modal__header">
            <h3 className="qr-modal__title" id="op-hard-delete-title">
              Удалить операцию навсегда?
            </h3>
            <button
              type="button"
              className="qr-modal__close"
              onClick={onClose}
              aria-label="Закрыть"
            >
              ×
            </button>
          </div>

          <dl className="hard-delete-modal__summary">
            <dt>Название</dt>
            <dd>{operation.name}</dd>
            <dt>Код</dt>
            <dd>
              <code>{operation.code}</code>
            </dd>
          </dl>

          <div className="hard-delete-modal__field">
            <label htmlFor="op-hard-delete-code">
              Для подтверждения введите код операции:
            </label>
            <input
              id="op-hard-delete-code"
              type="text"
              autoComplete="off"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder={operation.code}
              disabled={pending}
            />
          </div>

          {error && (
            <div className="qr-modal__error" role="alert">
              <p className="qr-modal__error-title">{error}</p>
            </div>
          )}

          <div className="hard-delete-modal__actions">
            <button
              type="button"
              className="admin-btn"
              onClick={onClose}
              disabled={pending}
            >
              Отмена
            </button>
            <button
              type="button"
              className="admin-btn admin-btn--danger"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              <Trash2 size={16} strokeWidth={1.6} aria-hidden />
              {pending ? 'Удаление…' : 'Удалить навсегда'}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
