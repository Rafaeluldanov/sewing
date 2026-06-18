'use client';

import { useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Save, ShieldCheck } from 'lucide-react';
import {
  EMPLOYEE_ROLES,
  type EmployeeListItemDto,
} from '@sewing/shared/employees';
import { formatRole } from '@/lib/admin-labels';
import { AdminCard, AdminSectionHeader } from '@/components/admin';
import { updateEmployeeRolesAction } from '../employees/actions';
import {
  initialUpdateEmployeeState,
  type UpdateEmployeeState,
} from '../employees/form-state';

interface Props {
  employees: EmployeeListItemDto[];
  /**
   * Может ли текущий пользователь выдавать/снимать роль ADMIN (= он сам
   * ADMIN). Для SHOP_MANAGER строка ADMIN заблокирована (backend всё
   * равно режет эскалацию привилегий).
   */
  canAssignAdmin: boolean;
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить роли'}
    </button>
  );
}

/**
 * Редактор ролей одного сотрудника: чекбоксы всех assignable-ролей +
 * radio «основная». Вынесен отдельным компонентом и монтируется заново
 * (через `key={employee.id}` у родителя) при смене сотрудника — так
 * `useFormState`/локальный стейт чекбоксов сбрасываются на нового.
 */
function EmployeeRolesEditor({
  employee,
  canAssignAdmin,
}: {
  employee: EmployeeListItemDto;
  canAssignAdmin: boolean;
}) {
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(
    () =>
      new Set(
        employee.roles && employee.roles.length > 0
          ? employee.roles
          : [employee.role],
      ),
  );
  const [primaryRole, setPrimaryRole] = useState<string>(employee.role);

  const action = updateEmployeeRolesAction.bind(null, employee.id);
  const [state, formAction] = useFormState<UpdateEmployeeState, FormData>(
    action,
    initialUpdateEmployeeState,
  );

  function toggleRole(r: string) {
    setSelectedRoles((prev) => {
      if (prev.has(r)) {
        if (r === primaryRole) return prev; // основную не снять
        const next = new Set(prev);
        next.delete(r);
        return next;
      }
      const next = new Set(prev);
      next.add(r);
      return next;
    });
  }

  function setPrimary(r: string) {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      next.add(r);
      return next;
    });
    setPrimaryRole(r);
  }

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-field admin-roles">
        <div className="admin-roles__list">
          {EMPLOYEE_ROLES.map((r) => {
            const checked = selectedRoles.has(r);
            const isPrimary = primaryRole === r;
            const adminLocked = r === 'ADMIN' && !canAssignAdmin;
            return (
              <div key={r} className="admin-roles__row">
                <label className="admin-roles__check">
                  <input
                    type="checkbox"
                    name={adminLocked ? undefined : 'roles'}
                    value={r}
                    checked={checked}
                    disabled={adminLocked}
                    onChange={adminLocked ? undefined : () => toggleRole(r)}
                  />
                  <span>{formatRole(r)}</span>
                </label>
                <label className="admin-roles__primary admin-muted">
                  <input
                    type="radio"
                    name={adminLocked ? undefined : 'primaryRole'}
                    value={r}
                    checked={isPrimary}
                    disabled={adminLocked || !checked}
                    onChange={adminLocked ? undefined : () => setPrimary(r)}
                  />
                  <span>основная</span>
                </label>
                {adminLocked && checked && (
                  <input type="hidden" name="roles" value="ADMIN" />
                )}
                {adminLocked && isPrimary && (
                  <input type="hidden" name="primaryRole" value="ADMIN" />
                )}
              </div>
            );
          })}
        </div>
        <span className="admin-field__hint admin-muted">
          Отметьте все роли, к которым у сотрудника есть доступ. «Основная»
          определяет рабочий экран по умолчанию; переключаться между
          участками сотрудник может сканом рабочего места.
          {!canAssignAdmin
            ? ' Роль «Администратор» назначает только администратор.'
            : ''}
        </span>
      </div>

      <div className="admin-actions-row">
        <SaveButton />
      </div>

      {state.successMessage && (
        <div role="status" className="admin-muted" style={{ fontSize: '0.88rem' }}>
          {state.successMessage}
        </div>
      )}
      {state.error && (
        <div
          role="alert"
          style={{ color: 'var(--admin-danger-fg)', fontSize: '0.88rem' }}
        >
          {state.error}
          {state.errorRequestId && (
            <span className="admin-muted" style={{ marginLeft: 6 }}>
              req: <code>{state.errorRequestId}</code>
            </span>
          )}
        </div>
      )}
    </form>
  );
}

/**
 * Секция «Роли сотрудников» в «Настройках компании»
 * (`/admin/company-settings`). По ТЗ редактирование ролей живёт в меню
 * настроек, а не в карточке сотрудника: выбираем сотрудника из списка и
 * прикрепляем к нему роли (несколько ролей, фича 18.06.2026).
 *
 * Источник истины — backend `PATCH /api/employees/:id` (поля
 * `role`/`roles`). RBAC (`SHOP_MANAGER`/`ADMIN`, запрет эскалации
 * ADMIN, защита последнего админа) — на сервере.
 */
export function EmployeeRolesSection({ employees, canAssignAdmin }: Props) {
  const active = useMemo(
    () =>
      employees
        .filter((e) => e.active)
        .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru')),
    [employees],
  );
  const [selectedId, setSelectedId] = useState<string>('');
  const selected = active.find((e) => e.id === selectedId) ?? null;

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<ShieldCheck size={18} strokeWidth={1.6} aria-hidden />}
        title="Роли сотрудников"
      />
      <p className="admin-muted" style={{ marginTop: 0, fontSize: '0.9rem' }}>
        Выберите сотрудника и прикрепите роли доступа. Одна из ролей —
        основная (рабочий экран по умолчанию).
      </p>

      <div className="admin-field">
        <label htmlFor="role-employee">Сотрудник</label>
        <select
          id="role-employee"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          <option value="">— выберите сотрудника —</option>
          {active.map((e) => (
            <option key={e.id} value={e.id}>
              {e.fullName} · {formatRole(e.role)}
              {e.roles && e.roles.length > 1 ? ` (+${e.roles.length - 1})` : ''}
            </option>
          ))}
        </select>
      </div>

      {selected ? (
        <EmployeeRolesEditor
          key={selected.id}
          employee={selected}
          canAssignAdmin={canAssignAdmin}
        />
      ) : (
        <p className="admin-muted" style={{ fontSize: '0.88rem' }}>
          Сотрудник не выбран.
        </p>
      )}
    </AdminCard>
  );
}
