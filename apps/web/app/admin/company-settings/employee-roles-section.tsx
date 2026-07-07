'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Pencil, Save, Search, ShieldCheck, Star, X, XCircle } from 'lucide-react';
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
   * ADMIN). Для SHOP_MANAGER чип ADMIN заблокирован (backend всё равно
   * режет эскалацию привилегий).
   */
  canAssignAdmin: boolean;
}

/** Роли сотрудника в порядке «основная → остальные» (без дублей). */
function orderedRoles(employee: EmployeeListItemDto): string[] {
  const set =
    employee.roles && employee.roles.length > 0
      ? employee.roles
      : [employee.role];
  return [employee.role, ...set.filter((r) => r !== employee.role)];
}

/** Read-only чипы ролей: основная — с ★ и акцентом. */
function RoleChipsReadonly({ employee }: { employee: EmployeeListItemDto }) {
  return (
    <div className="admin-chip-list">
      {orderedRoles(employee).map((r) => {
        const isPrimary = r === employee.role;
        return (
          <span
            key={r}
            className={'admin-chip' + (isPrimary ? ' admin-chip--primary' : '')}
          >
            {isPrimary && (
              <Star
                className="admin-chip__icon"
                size={13}
                strokeWidth={1.6}
                fill="currentColor"
                aria-hidden
              />
            )}
            {formatRole(r)}
          </span>
        );
      })}
    </div>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={15} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

/**
 * Инлайн-редактор ролей одного сотрудника. Роли — переключаемые чипы:
 * клик по телу чипа включает/выключает доступ, ★ на выбранном чипе делает
 * роль основной. Значения уходят в server action скрытыми input'ами
 * (`roles` — много, `primaryRole` — один), поэтому disabled/ADMIN-логика
 * не завязана на нативные form-контролы.
 */
function EmployeeRolesEditor({
  employee,
  canAssignAdmin,
  onDone,
}: {
  employee: EmployeeListItemDto;
  canAssignAdmin: boolean;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(orderedRoles(employee)),
  );
  const [primary, setPrimary] = useState<string>(employee.role);

  const [state, formAction] = useFormState<UpdateEmployeeState, FormData>(
    updateEmployeeRolesAction.bind(null, employee.id),
    initialUpdateEmployeeState,
  );

  // Успех → закрываем редактор. Обзор обновится сам: action ревалидирует
  // /admin/company-settings, страница перечитает сотрудников.
  useEffect(() => {
    if (state.ok) onDone();
  }, [state.ok, onDone]);

  function toggle(r: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(r)) {
        next.delete(r);
        if (r === primary) {
          // Сняли основную — переносим ★ на первую из оставшихся.
          const fallback = [...next][0];
          if (fallback) setPrimary(fallback);
        }
      } else {
        next.add(r);
      }
      return next;
    });
  }

  function makePrimary(r: string) {
    setSelected((prev) => (prev.has(r) ? prev : new Set(prev).add(r)));
    setPrimary(r);
  }

  return (
    <form action={formAction} className="admin-stack" style={{ gap: 10 }}>
      <div className="admin-role-chips">
        {EMPLOYEE_ROLES.map((r) => {
          const on = selected.has(r);
          const isPrimary = on && primary === r;
          const adminLocked = r === 'ADMIN' && !canAssignAdmin;
          return (
            <span
              key={r}
              className={
                'admin-role-chip' +
                (on ? ' admin-role-chip--on' : '') +
                (isPrimary ? ' admin-role-chip--primary' : '')
              }
            >
              <button
                type="button"
                className="admin-role-chip__toggle"
                disabled={adminLocked}
                aria-pressed={on}
                onClick={() => toggle(r)}
              >
                {formatRole(r)}
              </button>
              {on && (
                <button
                  type="button"
                  className="admin-role-chip__star"
                  disabled={adminLocked}
                  aria-pressed={isPrimary}
                  title={isPrimary ? 'Основная роль' : 'Сделать основной'}
                  onClick={() => makePrimary(r)}
                >
                  <Star
                    size={13}
                    strokeWidth={1.6}
                    fill={isPrimary ? 'currentColor' : 'none'}
                    aria-hidden
                  />
                </button>
              )}
            </span>
          );
        })}
      </div>

      {/* Значения для server action */}
      {[...selected].map((r) => (
        <input key={r} type="hidden" name="roles" value={r} />
      ))}
      <input type="hidden" name="primaryRole" value={primary} />

      <span className="admin-field__hint admin-muted">
        Клик по роли — доступ вкл/выкл. ★ — основная роль (рабочий экран по
        умолчанию); переключаться между участками сотрудник может сканом
        рабочего места.
        {!canAssignAdmin
          ? ' Роль «Администратор» назначает только администратор.'
          : ''}
      </span>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
          {state.errorRequestId && (
            <span className="admin-muted" style={{ marginLeft: 6 }}>
              req: <code>{state.errorRequestId}</code>
            </span>
          )}
        </div>
      )}

      <div className="admin-actions-row">
        <SaveButton />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={onDone}
        >
          <X size={15} strokeWidth={1.6} aria-hidden />
          Отмена
        </button>
      </div>
    </form>
  );
}

/**
 * Секция «Роли сотрудников» в «Настройках компании» (вкладка «Доступ»).
 * По ТЗ редактирование ролей живёт в настройках, а не в карточке
 * сотрудника.
 *
 * UX: обзор-список всех активных сотрудников — сразу видно, у кого какие
 * роли (чипы, ★ = основная). Поиск по имени; правка — инлайн по кнопке
 * «Изменить» (одна строка за раз). Источник истины — backend
 * `PATCH /api/employees/:id` (`role`/`roles`); RBAC (SHOP_MANAGER/ADMIN,
 * запрет эскалации ADMIN, защита последнего админа) — на сервере.
 */
export function EmployeeRolesSection({ employees, canAssignAdmin }: Props) {
  const active = useMemo(
    () =>
      employees
        .filter((e) => e.active)
        .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru')),
    [employees],
  );

  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string>('');
  const stopEditing = useCallback(() => setEditingId(''), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return active;
    return active.filter((e) => e.fullName.toLowerCase().includes(q));
  }, [active, query]);

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<ShieldCheck size={18} strokeWidth={1.6} aria-hidden />}
        title="Роли сотрудников"
        hint="Доступы каждого сотрудника. Основная роль (★) — рабочий экран по умолчанию."
      />

      <div className="admin-role-search">
        <Search size={16} strokeWidth={1.6} aria-hidden />
        <input
          type="search"
          placeholder="Поиск по имени…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Поиск сотрудника"
        />
        <span className="admin-muted admin-role-search__count">
          {filtered.length} из {active.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="admin-muted" style={{ fontSize: '0.9rem', marginTop: 8 }}>
          {active.length === 0
            ? 'Активных сотрудников нет.'
            : 'Никого не нашлось.'}
        </p>
      ) : (
        <ul className="admin-role-rows">
          {filtered.map((e) => {
            const editing = editingId === e.id;
            return (
              <li
                key={e.id}
                className={
                  'admin-role-row' + (editing ? ' admin-role-row--editing' : '')
                }
              >
                <div className="admin-role-row__name">{e.fullName}</div>
                <div className="admin-role-row__body">
                  {editing ? (
                    <EmployeeRolesEditor
                      employee={e}
                      canAssignAdmin={canAssignAdmin}
                      onDone={stopEditing}
                    />
                  ) : (
                    <RoleChipsReadonly employee={e} />
                  )}
                </div>
                {!editing && (
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost admin-role-row__edit"
                    onClick={() => setEditingId(e.id)}
                  >
                    <Pencil size={14} strokeWidth={1.6} aria-hidden />
                    Изменить
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </AdminCard>
  );
}
