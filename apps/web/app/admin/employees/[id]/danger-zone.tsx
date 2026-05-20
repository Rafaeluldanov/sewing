'use client';

/**
 * Блок «Опасная зона» для карточки сотрудника
 * (`/admin/employees/[id]`). Содержит две кнопки:
 *
 *   - «Архивировать» / «Восстановить» — soft delete через
 *     `archiveEmployeeAction` / `restoreEmployeeAction`. Простой
 *     confirm() — больше трения не требуется, операция обратима.
 *   - «Удалить навсегда» — hard delete через `deleteEmployeeAction`,
 *     открывается модалка с вводом login (anti-bumblefuck). Доступна
 *     только для роли `viewerRole = 'ADMIN'`. Кроме того, если
 *     `blockers.hardDeleteAllowed === false`, кнопка disabled с
 *     подсказкой «у сотрудника есть история».
 *
 * Сам preflight (`getEmployeeBlockers`) приходит из RSC — здесь
 * мы только рендерим UI и зовём server actions. После успешного
 * hard-delete делаем `router.push('/admin/employees')`, чтобы не
 * остаться на 404-странице удалённого сотрудника.
 *
 * См. `docs/employee-deletion-recon.md §6.2`, §6.3.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { AlertTriangle, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import type {
  EmployeeBlockersResponse,
  EmployeeDetailDto,
} from '@sewing/shared/employees';
import { ModalPortal } from '@/components/modal-portal';
import {
  archiveEmployeeAction,
  deleteEmployeeAction,
  restoreEmployeeAction,
} from '../actions';
import { describeArchiveBlocker, describeHardDeleteBlocker } from './blocker-labels';

interface Props {
  employee: EmployeeDetailDto;
  blockers: EmployeeBlockersResponse;
  /** Роль текущего viewer'а — нужна для гейта hard-delete (ADMIN only). */
  viewerRole: string;
  /** Сам себя архивировать/удалять нельзя — гейт UI-кнопок. */
  isSelf: boolean;
}

export function EmployeeDangerZone({
  employee,
  blockers,
  viewerRole,
  isSelf,
}: Props) {
  const router = useRouter();
  const [archivePending, startArchive] = useTransition();
  const [hardDeleteOpen, setHardDeleteOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const canHardDelete = viewerRole === 'ADMIN';
  const isArchived = !employee.active;

  const handleArchive = () => {
    setArchiveError(null);
    if (
      !window.confirm(
        `Архивировать сотрудника «${employee.fullName}»? Карточка переедет во вкладку «Архив», её можно вернуть в любой момент.`,
      )
    ) {
      return;
    }
    startArchive(async () => {
      const res = await archiveEmployeeAction(employee.id);
      if (res.error) setArchiveError(res.error);
    });
  };

  const handleRestore = () => {
    setArchiveError(null);
    startArchive(async () => {
      const res = await restoreEmployeeAction(employee.id);
      if (res.error) setArchiveError(res.error);
    });
  };

  return (
    <section className="employee-danger-zone" aria-labelledby="danger-zone-title">
      <div className="employee-danger-zone__head">
        <AlertTriangle size={16} strokeWidth={1.8} aria-hidden />
        <h2 id="danger-zone-title" className="employee-danger-zone__title">
          Опасная зона
        </h2>
      </div>

      <div className="employee-danger-zone__row">
        <div className="employee-danger-zone__text">
          <strong>{isArchived ? 'Восстановить из архива' : 'Архивировать'}</strong>
          <p className="admin-muted">
            {isArchived
              ? 'Карточка снова появится во вкладке «Активные», логин начнёт работать.'
              : 'Карточка переедет во вкладку «Архив». История и финансовые начисления сохранятся. Действие обратимо.'}
          </p>
          {blockers.archiveBlockers.length > 0 && !isArchived && (
            <ul className="employee-danger-zone__blockers" role="status">
              {blockers.archiveBlockers.map((b) => (
                <li key={b.kind}>{describeArchiveBlocker(b)}</li>
              ))}
            </ul>
          )}
        </div>
        {isArchived ? (
          <button
            type="button"
            className="admin-btn"
            onClick={handleRestore}
            disabled={archivePending || isSelf}
            title={isSelf ? 'Нельзя выполнить действие над собственной карточкой' : undefined}
          >
            <ArchiveRestore size={16} strokeWidth={1.6} aria-hidden />
            {archivePending ? 'Восстановление…' : 'Восстановить'}
          </button>
        ) : (
          <button
            type="button"
            className="admin-btn"
            onClick={handleArchive}
            disabled={
              archivePending ||
              isSelf ||
              !blockers.archiveAllowed
            }
            title={
              isSelf
                ? 'Нельзя выполнить действие над собственной карточкой'
                : !blockers.archiveAllowed
                ? 'Сначала закройте указанные ниже зависимости'
                : undefined
            }
          >
            <Archive size={16} strokeWidth={1.6} aria-hidden />
            {archivePending ? 'Архивирование…' : 'Архивировать'}
          </button>
        )}
      </div>

      <div className="employee-danger-zone__row">
        <div className="employee-danger-zone__text">
          <strong>Удалить навсегда</strong>
          <p className="admin-muted">
            Доступно только для пустых карточек без начислений, паспортов
            и смен. Запись пропадёт из БД; в журнале аудита останется
            снимок.
          </p>
          {blockers.hardDeleteBlockers.length > 0 && (
            <ul className="employee-danger-zone__blockers" role="status">
              {blockers.hardDeleteBlockers.map((b) => (
                <li key={b.kind}>{describeHardDeleteBlocker(b)}</li>
              ))}
            </ul>
          )}
          {!canHardDelete && (
            <p className="employee-danger-zone__hint">
              Удаление доступно только пользователю с ролью администратора.
            </p>
          )}
          {blockers.hasDisplayScreenConfig && canHardDelete && (
            <p className="employee-danger-zone__hint">
              Это DISPLAY-учётка с привязанным экраном. Удаление каскадом
              снесёт конфиг экрана.
            </p>
          )}
        </div>
        <button
          type="button"
          className="admin-btn admin-btn--danger"
          onClick={() => setHardDeleteOpen(true)}
          disabled={
            isSelf ||
            !canHardDelete ||
            !blockers.hardDeleteAllowed
          }
          title={
            isSelf
              ? 'Нельзя выполнить действие над собственной карточкой'
              : !canHardDelete
              ? 'Только для администратора'
              : !blockers.hardDeleteAllowed
              ? 'У сотрудника есть история — удалить нельзя, только архив'
              : undefined
          }
        >
          <Trash2 size={16} strokeWidth={1.6} aria-hidden />
          Удалить навсегда
        </button>
      </div>

      {archiveError && (
        <div className="employee-danger-zone__error" role="alert">
          {archiveError}
        </div>
      )}

      {hardDeleteOpen && (
        <HardDeleteModal
          employee={employee}
          blockers={blockers}
          onClose={() => setHardDeleteOpen(false)}
          onDeleted={() => {
            setHardDeleteOpen(false);
            router.push('/admin/employees');
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

interface ModalProps {
  employee: EmployeeDetailDto;
  blockers: EmployeeBlockersResponse;
  onClose: () => void;
  onDeleted: () => void;
}

function HardDeleteModal({ employee, blockers, onClose, onDeleted }: ModalProps) {
  const [loginInput, setLoginInput] = useState('');
  const [ackCascade, setAckCascade] = useState(false);
  const [pending, startPending] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const loginMatches = loginInput.trim().toLowerCase() === employee.login.toLowerCase();
  const cascadeOk = !blockers.hasDisplayScreenConfig || ackCascade;
  const canSubmit = loginMatches && cascadeOk && !pending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);
    startPending(async () => {
      const res = await deleteEmployeeAction(employee.id, {
        ackDisplayCascade: blockers.hasDisplayScreenConfig,
      });
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
        aria-labelledby="hard-delete-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="qr-modal__card hard-delete-modal__card">
          <div className="qr-modal__header">
            <h3 className="qr-modal__title" id="hard-delete-title">
              Удалить сотрудника навсегда?
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
            <dt>ФИО</dt>
            <dd>{employee.fullName}</dd>
            <dt>Логин</dt>
            <dd><code>{employee.login}</code></dd>
            <dt>Роль</dt>
            <dd><code>{employee.role}</code></dd>
            <dt>Создан</dt>
            <dd>{new Date(employee.createdAt).toLocaleString('ru-RU')}</dd>
          </dl>

          {blockers.hasDisplayScreenConfig && (
            <label className="hard-delete-modal__ack">
              <input
                type="checkbox"
                checked={ackCascade}
                onChange={(e) => setAckCascade(e.target.checked)}
              />
              <span>
                Понимаю, что также удалится привязанный <code>DisplayScreenConfig</code>.
              </span>
            </label>
          )}

          <div className="hard-delete-modal__field">
            <label htmlFor="hard-delete-login">
              Для подтверждения введите логин сотрудника:
            </label>
            <input
              id="hard-delete-login"
              type="text"
              autoComplete="off"
              value={loginInput}
              onChange={(e) => setLoginInput(e.target.value)}
              placeholder={employee.login}
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
