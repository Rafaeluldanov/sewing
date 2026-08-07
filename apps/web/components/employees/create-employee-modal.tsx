'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { EMPLOYEE_ROLES } from '@sewing/shared/employees';
import { SYSTEM_ROLE_LABELS } from '@sewing/shared/app-roles';
import type { EmployeeDetailDto } from '@sewing/shared/employees';
import { AdminModal } from '@/components/admin/admin-modal';
import { RefModalForm } from '@/components/admin/ref-create/ref-modal-form';
import {
  createEmployeeInlineAction,
  loadEmployeeRoleOptionsAction,
} from '@/app/admin/employees/inline-actions';

interface RoleOption {
  code: string;
  name: string;
}

/**
 * Fallback, если справочник ролей не отдался: те же системные роли,
 * что у полной формы `/admin/employees/new`. ADMIN исключён всегда —
 * админскую учётку из быстрой модалки не заводят (полная форма +
 * серверный гейт `EMPLOYEE_ADMIN_TARGET_FORBIDDEN`).
 */
const FALLBACK_ROLE_OPTIONS: RoleOption[] = EMPLOYEE_ROLES.filter(
  (code) => code !== 'ADMIN',
).map((code) => ({ code, name: SYSTEM_ROLE_LABELS[code] ?? code }));

/**
 * Минимальная модалка «＋ Добавить сотрудника» из select-ов других форм
 * (payroll-документы, раскройщик в форме паспорта). Только обязательные
 * поля `CreateEmployeeSchema`: ФИО, логин, PIN, роль; оплата — сдельная
 * по умолчанию. Оклад, подразделение и доп. роли доводятся в карточке.
 *
 * `lockedRole` — зафиксировать роль (например, `CUTTER` из формы
 * паспорта): select заморожен на ней.
 */
export function CreateEmployeeModal({
  lockedRole,
  zIndex,
  onCancel,
  onCreated,
}: {
  lockedRole?: string;
  zIndex?: number;
  onCancel: () => void;
  onCreated: (employee: EmployeeDetailDto) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [login, setLogin] = useState('');
  const [pin, setPin] = useState('');
  const [role, setRole] = useState(lockedRole ?? 'SEAMSTRESS');
  const [roleOptions, setRoleOptions] =
    useState<RoleOption[]>(FALLBACK_ROLE_OPTIONS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (lockedRole) return;
    let cancelled = false;
    loadEmployeeRoleOptionsAction().then((appRoles) => {
      if (cancelled || appRoles.length === 0) return;
      const options = appRoles
        .filter(
          (r) =>
            r.active &&
            r.code !== 'DISPLAY' &&
            r.code !== 'SUPERADMIN' &&
            r.code !== 'ADMIN',
        )
        .map((r) => ({ code: r.code, name: r.name }));
      if (options.length > 0) setRoleOptions(options);
    });
    return () => {
      cancelled = true;
    };
  }, [lockedRole]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await createEmployeeInlineAction({
      fullName,
      login,
      pin,
      role,
    });
    setSubmitting(false);
    if (!result.ok || !result.employee) {
      setError(result.error ?? 'Не удалось создать сотрудника');
      return;
    }
    onCreated(result.employee);
  }

  const lockedRoleLabel = lockedRole
    ? (roleOptions.find((r) => r.code === lockedRole)?.name ??
      SYSTEM_ROLE_LABELS[lockedRole] ??
      lockedRole)
    : null;

  return (
    <AdminModal
      title="Новый сотрудник"
      subtitle="Тип оплаты — сдельная. Оклад, подразделение и доп. роли настраиваются в карточке сотрудника."
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
          <label htmlFor="ref-emp-fullname">ФИО</label>
          <input
            id="ref-emp-fullname"
            type="text"
            required
            autoFocus
            maxLength={200}
            placeholder="Иванова Мария"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ref-emp-login">Логин</label>
          <input
            id="ref-emp-login"
            type="text"
            required
            minLength={2}
            maxLength={64}
            placeholder="m.ivanova"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            autoComplete="off"
            style={{ textTransform: 'lowercase' }}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ref-emp-pin">PIN</label>
          <input
            id="ref-emp-pin"
            type="text"
            required
            minLength={4}
            maxLength={100}
            placeholder="не менее 4 символов"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ref-emp-role">Роль</label>
          {lockedRole ? (
            <input
              id="ref-emp-role"
              type="text"
              value={lockedRoleLabel ?? lockedRole}
              disabled
            />
          ) : (
            <select
              id="ref-emp-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              required
            >
              {roleOptions.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </RefModalForm>
    </AdminModal>
  );
}
