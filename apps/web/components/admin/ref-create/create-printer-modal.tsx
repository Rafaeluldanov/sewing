'use client';

import { useState, type FormEvent } from 'react';
import { EMPLOYEE_ROLES, type EmployeeRole } from '@sewing/shared/employees';
import { SYSTEM_ROLE_LABELS } from '@sewing/shared/app-roles';
import type { PrinterDetailDto } from '@sewing/shared/printers';
import { AdminModal } from '../admin-modal';
import { RefModalForm } from './ref-modal-form';
import { createPrinterInlineAction } from './actions';

/** «＋ Добавить принтер» из select-а печати. */
export function CreatePrinterModal({
  zIndex,
  onCancel,
  onCreated,
}: {
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: PrinterDetailDto) => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<'' | EmployeeRole>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createPrinterInlineAction({
      name,
      role: role === '' ? null : role,
    });
    setSubmitting(false);
    if (!result.ok || !result.dto) {
      setError(result.error ?? 'Не удалось создать принтер');
      return;
    }
    onCreated(result.dto);
  }

  return (
    <AdminModal
      title="Новый принтер"
      subtitle="Принтер офлайн, пока к нему не подключится агент печати."
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
          <label htmlFor="ref-printer-name">Название</label>
          <input
            id="ref-printer-name"
            type="text"
            required
            autoFocus
            maxLength={120}
            placeholder="Например: Принтер раскроя"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ref-printer-role">Роль (для автопечати по смене)</label>
          <select
            id="ref-printer-role"
            value={role}
            onChange={(e) => setRole(e.target.value as '' | EmployeeRole)}
          >
            <option value="">— без привязки —</option>
            {EMPLOYEE_ROLES.map((r) => (
              <option key={r} value={r}>
                {SYSTEM_ROLE_LABELS[r] ?? r}
              </option>
            ))}
          </select>
        </div>
      </RefModalForm>
    </AdminModal>
  );
}
