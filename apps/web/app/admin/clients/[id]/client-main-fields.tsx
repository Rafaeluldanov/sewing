'use client';

/**
 * Inline-редактирование блока «Основное» карточки клиента
 * (`/admin/clients/[id]`).
 *
 * Каждое поле показывается как «значение + карандашик»: по клику на
 * карандаш строка превращается в input/textarea с кнопками ✓/✗ (Enter —
 * сохранить, Esc — отмена). Активность (`isActive`) вынесена сюда же
 * отдельной строкой-переключателем «Активировать / В архив».
 *
 * Сохранение — тот же server-action `updateClientAction`, что и раньше
 * (partial-update: в FormData кладём ТОЛЬКО правленое поле, `buildUpdateDto`
 * трогает лишь присутствующие ключи). После успеха action делает
 * `revalidatePath`, RSC перерисовывает страницу и отдаёт свежий `client` —
 * поэтому отображаемое значение всегда берём из пропа, а локальный стейт
 * держит лишь «редактируется ли поле» и черновик ввода.
 */

import { useEffect, useState, useTransition } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import { AdminStatusBadge } from '@/components/admin';
import { formatStatus, statusTone } from '@/lib/admin-labels';
import { updateClientAction } from '../actions';
import { initialUpdateClientState } from '../form-state';

type FieldKey = 'name' | 'phone' | 'email' | 'comment';

interface EditableFieldProps {
  clientId: string;
  field: FieldKey;
  label: string;
  value: string | null;
  type?: 'text' | 'email' | 'textarea';
  maxLength?: number;
  placeholder?: string;
}

function EditableField({
  clientId,
  field,
  label,
  value,
  type = 'text',
  maxLength,
  placeholder = '—',
}: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Пока поле не редактируется — подтягиваем свежее значение из пропа
  // (после сохранения RSC отдаёт обновлённого клиента).
  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  const startEdit = () => {
    setDraft(value ?? '');
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setError(null);
    setEditing(false);
  };
  const save = () => {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set(field, draft);
      const res = await updateClientAction(clientId, initialUpdateClientState, fd);
      if (res.error) {
        setError(res.error);
      } else {
        setEditing(false);
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && type !== 'textarea') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  const hasValue = (value ?? '').trim().length > 0;

  return (
    <div className="client-field">
      <div className="client-field__label">{label}</div>
      {editing ? (
        <div className="client-field__edit">
          {type === 'textarea' ? (
            <textarea
              autoFocus
              value={draft}
              maxLength={maxLength}
              rows={3}
              disabled={pending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
          ) : (
            <input
              autoFocus
              type={type}
              value={draft}
              maxLength={maxLength}
              disabled={pending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
          )}
          <div className="client-field__actions">
            <button
              type="button"
              className="client-field__btn client-field__btn--save"
              onClick={save}
              disabled={pending}
              title="Сохранить"
              aria-label="Сохранить"
            >
              {pending ? '…' : <Check size={16} strokeWidth={2} aria-hidden />}
            </button>
            <button
              type="button"
              className="client-field__btn client-field__btn--cancel"
              onClick={cancel}
              disabled={pending}
              title="Отмена"
              aria-label="Отмена"
            >
              <X size={16} strokeWidth={2} aria-hidden />
            </button>
          </div>
          {error && <p className="client-field__error">{error}</p>}
        </div>
      ) : (
        <div className="client-field__view">
          <span
            className={`client-field__value${
              hasValue ? '' : ' admin-muted'
            }`}
          >
            {hasValue ? value : placeholder}
          </span>
          <button
            type="button"
            className="client-field__pencil"
            onClick={startEdit}
            title={`Изменить: ${label}`}
            aria-label={`Изменить: ${label}`}
          >
            <Pencil size={14} strokeWidth={1.7} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

function StatusField({
  clientId,
  isActive,
}: {
  clientId: string;
  isActive: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set('isActive', isActive ? 'off' : 'on');
      const res = await updateClientAction(clientId, initialUpdateClientState, fd);
      if (res.error) setError(res.error);
    });
  };

  return (
    <div className="client-field">
      <div className="client-field__label">Статус</div>
      <div className="client-field__view">
        <AdminStatusBadge tone={statusTone(isActive)}>
          {formatStatus(isActive)}
        </AdminStatusBadge>
        <button
          type="button"
          className="admin-btn admin-btn--ghost client-field__toggle"
          onClick={toggle}
          disabled={pending}
          title={
            isActive
              ? 'Перевести клиента в архив (isActive=false)'
              : 'Вернуть клиента в активные'
          }
        >
          {pending ? '…' : isActive ? 'В архив' : 'Активировать'}
        </button>
        {error && <p className="client-field__error">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Список inline-редактируемых полей блока «Основное». Оборачивается в
 * `AdminCard` на стороне страницы (`page.tsx`).
 */
export function ClientMainFields({ client }: { client: ClientDto }) {
  return (
    <div className="client-field-list">
      <EditableField
        clientId={client.id}
        field="name"
        label="Название"
        value={client.name}
        maxLength={200}
        placeholder="Название клиента"
      />
      <StatusField clientId={client.id} isActive={client.isActive} />
      <EditableField
        clientId={client.id}
        field="phone"
        label="Телефон"
        value={client.phone}
        maxLength={64}
      />
      <EditableField
        clientId={client.id}
        field="email"
        label="Email"
        value={client.email}
        type="email"
        maxLength={200}
      />
      <EditableField
        clientId={client.id}
        field="comment"
        label="Комментарий"
        value={client.comment}
        type="textarea"
        maxLength={2000}
      />
    </div>
  );
}
