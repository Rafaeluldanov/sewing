'use client';

import { useState, type FormEvent } from 'react';
import type { AppRoleDto } from '@sewing/shared/app-roles';
import { AdminModal } from '../admin-modal';
import { RefModalForm } from './ref-modal-form';
import { createAppRoleInlineAction } from './actions';

/**
 * «＋ Добавить роль» из select-а роли сотрудника. Наследование прав и
 * рабочее пространство настраиваются в /admin/roles (дефолт — без
 * наследования, workspace «/»).
 */
export function CreateAppRoleModal({
  zIndex,
  onCancel,
  onCreated,
}: {
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: AppRoleDto) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createAppRoleInlineAction({ code, name });
    setSubmitting(false);
    if (!result.ok || !result.dto) {
      setError(result.error ?? 'Не удалось создать роль');
      return;
    }
    onCreated(result.dto);
  }

  return (
    <AdminModal
      title="Новая роль"
      subtitle="Наследование прав и рабочее пространство — в разделе «Роли»."
      onClose={onCancel}
      zIndex={zIndex}
      closeDisabled={submitting}
    >
      <RefModalForm
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitting={submitting}
        error={error}
      >
        <div className="admin-field">
          <label htmlFor="ref-role-code">Код</label>
          <input
            id="ref-role-code"
            type="text"
            required
            autoFocus
            maxLength={40}
            placeholder="Например: BRIGADIER"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <p className="admin-field__hint admin-muted">
            Латиница, цифры и подчёркивание; менять код потом нельзя.
          </p>
        </div>
        <div className="admin-field">
          <label htmlFor="ref-role-name">Название</label>
          <input
            id="ref-role-name"
            type="text"
            required
            maxLength={120}
            placeholder="Например: Бригадир"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </RefModalForm>
    </AdminModal>
  );
}
