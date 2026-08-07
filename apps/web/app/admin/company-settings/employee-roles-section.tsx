'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Pencil, Save, Search, ShieldCheck, Star, X, XCircle } from 'lucide-react';
import type { AppRoleDto } from '@sewing/shared/app-roles';
import { EMPLOYEE_ROLES, type EmployeeListItemDto } from '@sewing/shared/employees';
import { buildRoleLabels, formatRole } from '@/lib/admin-labels';
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
  /**
   * Справочник ролей (`/admin/roles`) — и системные, и заведённые из
   * админки. Пустой список = справочник не отдался: откатываемся на
   * зашитые `EMPLOYEE_ROLES`, чтобы вкладка «Доступ» осталась рабочей.
   */
  roleOptions?: AppRoleDto[];
}

/**
 * Коды ролей, которые можно НАЗНАЧАТЬ. Архивные из справочника
 * отбрасываем: роль в архиве выведена из обращения, новые назначения
 * ей делать не надо (у тех, кому уже выдана, доступ сохраняется —
 * см. `AppRolesService.expand`).
 *
 * `DISPLAY`/`SUPERADMIN` в списке не появляются: у первой учётку
 * заводит раздел «Цеховой монитор», вторая — кросс-тенантная и
 * назначается только через control-plane. В справочнике они системные
 * и активные, поэтому фильтруем явно — как это делал `EMPLOYEE_ROLES`.
 */
const NOT_ASSIGNABLE = new Set(['DISPLAY', 'SUPERADMIN']);

function assignableRoles(
  roleOptions: AppRoleDto[] | undefined,
): { code: string; name: string }[] {
  if (!roleOptions || roleOptions.length === 0) {
    return EMPLOYEE_ROLES.map((code) => ({ code, name: formatRole(code) }));
  }
  return roleOptions
    .filter((r) => r.active && !NOT_ASSIGNABLE.has(r.code))
    .map((r) => ({ code: r.code, name: r.name }));
}

/** Роли сотрудника в порядке «основная → остальные» (без дублей). */
function orderedRoles(employee: EmployeeListItemDto): string[] {
  const set =
    employee.roles && employee.roles.length > 0
      ? employee.roles
      : [employee.role];
  return [employee.role, ...set.filter((r) => r !== employee.role)];
}

/** Роль в сводной ленте человека (склеена по всем его учётным записям). */
interface MergedRole {
  code: string;
  /** Логины учёток, где роль выдана (подсказка на чипе). */
  logins: string[];
  /** Основная (★) хотя бы в одной учётке. */
  primary: boolean;
}

/**
 * Один человек = одна строка списка. Учёток у него может быть
 * несколько: исторически одному сотруднику заводили отдельный логин на
 * каждый участок (Андашова Астра — `astra` ОТК + `astra1` упаковка),
 * и список показывал ФИО столько раз, сколько логинов.
 */
interface EmployeeGroup {
  key: string;
  fullName: string;
  /** Учётки, отсортированы по логину. Минимум одна. */
  accounts: EmployeeListItemDto[];
  /** Доступы всех учёток без дублей. */
  roles: MergedRole[];
}

/**
 * Ключ склейки — ФИО без регистра и лишних пробелов. Полных тёзок
 * (разные люди с одинаковым ФИО) это тоже склеит — поэтому у строки с
 * несколькими учётками логины выведены под именем, а редактор ролей
 * остаётся ПОУЧЁТОЧНЫМ: доступ живёт на `Employee`, а не на человеке.
 */
function groupKey(fullName: string): string {
  return fullName.trim().replace(/\s+/g, ' ').toLowerCase();
}

function groupEmployees(list: EmployeeListItemDto[]): EmployeeGroup[] {
  const groups = new Map<string, EmployeeGroup>();

  for (const employee of list) {
    const key = groupKey(employee.fullName);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        fullName: employee.fullName.trim(),
        accounts: [],
        roles: [],
      };
      groups.set(key, group);
    }
    group.accounts.push(employee);
  }

  for (const group of groups.values()) {
    group.accounts.sort((a, b) => a.login.localeCompare(b.login));
    const roles = new Map<string, MergedRole>();
    for (const account of group.accounts) {
      for (const code of orderedRoles(account)) {
        const hit = roles.get(code);
        if (hit) {
          if (!hit.logins.includes(account.login)) hit.logins.push(account.login);
          hit.primary = hit.primary || code === account.role;
        } else {
          roles.set(code, {
            code,
            logins: [account.login],
            primary: code === account.role,
          });
        }
      }
    }
    group.roles = [...roles.values()];
  }

  return [...groups.values()].sort((a, b) =>
    a.fullName.localeCompare(b.fullName, 'ru'),
  );
}

/**
 * Read-only чипы доступов человека: основная роль — с ★ и акцентом.
 * У человека с несколькими учётками ★ может быть на нескольких чипах —
 * рабочий экран по умолчанию свой у каждого логина.
 */
function RoleChipsReadonly({
  roles,
  showLogins,
  labels,
}: {
  roles: MergedRole[];
  /** Дописывать ли к чипу, какой учётке принадлежит доступ. */
  showLogins: boolean;
  labels: Readonly<Record<string, string>>;
}) {
  return (
    <div className="admin-chip-list">
      {roles.map((role) => (
        <span
          key={role.code}
          className={
            'admin-chip' + (role.primary ? ' admin-chip--primary' : '')
          }
          title={
            showLogins
              ? `Учётная запись: ${role.logins.join(', ')}`
              : undefined
          }
        >
          {role.primary && (
            <Star
              className="admin-chip__icon"
              size={13}
              strokeWidth={1.6}
              fill="currentColor"
              aria-hidden
            />
          )}
          {formatRole(role.code, labels)}
          {showLogins && (
            <span className="admin-chip__login">
              · {role.logins.join(', ')}
            </span>
          )}
        </span>
      ))}
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
 * Инлайн-редактор ролей ОДНОЙ учётной записи. Роли — переключаемые чипы:
 * клик по телу чипа включает/выключает доступ, ★ на выбранном чипе делает
 * роль основной. Значения уходят в server action скрытыми input'ами
 * (`roles` — много, `primaryRole` — один), поэтому disabled/ADMIN-логика
 * не завязана на нативные form-контролы.
 *
 * Подсказка про клик/★ живёт на уровне строки, а не внутри формы: у
 * человека с несколькими учётками редакторов несколько, а текст один.
 */
function EmployeeRolesEditor({
  employee,
  canAssignAdmin,
  options,
  onDone,
}: {
  employee: EmployeeListItemDto;
  canAssignAdmin: boolean;
  options: { code: string; name: string }[];
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
        {options.map((option) => {
          const r = option.code;
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
                {option.name}
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
 * UX: обзор-список — строка на ЧЕЛОВЕКА (ФИО), а не на учётную запись.
 * Одному человеку исторически заводили отдельный логин на каждый
 * участок, из-за чего ФИО повторялось в списке столько раз, сколько у
 * него логинов; теперь такие строки склеены, а доступы всех учёток
 * собраны в одну ленту чипов (★ = основная роль учётки).
 *
 * Правка при этом остаётся ПОУЧЁТОЧНОЙ — `roles` лежат на `Employee`:
 * у склеенной строки «Изменить» разворачивает по редактору на логин.
 * Поиск — по ФИО и по логину. Источник истины — backend
 * `PATCH /api/employees/:id` (`role`/`roles`); RBAC (SHOP_MANAGER/ADMIN,
 * запрет эскалации ADMIN, защита последнего админа) — на сервере.
 */
export function EmployeeRolesSection({
  employees,
  canAssignAdmin,
  roleOptions,
}: Props) {
  const options = useMemo(() => assignableRoles(roleOptions), [roleOptions]);
  const labels = useMemo(
    () => buildRoleLabels(roleOptions ?? []),
    [roleOptions],
  );

  const groups = useMemo(
    () => groupEmployees(employees.filter((e) => e.active)),
    [employees],
  );

  const [query, setQuery] = useState('');
  const [editingKey, setEditingKey] = useState<string>('');
  const stopEditing = useCallback(() => setEditingKey(''), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        g.fullName.toLowerCase().includes(q) ||
        g.accounts.some((a) => a.login.toLowerCase().includes(q)),
    );
  }, [groups, query]);

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
          placeholder="Поиск по имени или логину…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Поиск сотрудника"
        />
        <span className="admin-muted admin-role-search__count">
          {filtered.length} из {groups.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="admin-muted" style={{ fontSize: '0.9rem', marginTop: 8 }}>
          {groups.length === 0
            ? 'Активных сотрудников нет.'
            : 'Никого не нашлось.'}
        </p>
      ) : (
        <ul className="admin-role-rows">
          {filtered.map((g) => {
            const editing = editingKey === g.key;
            const multi = g.accounts.length > 1;
            return (
              <li
                key={g.key}
                className={
                  'admin-role-row' + (editing ? ' admin-role-row--editing' : '')
                }
              >
                <div className="admin-role-row__name">
                  {g.fullName}
                  {multi && (
                    <span className="admin-role-row__logins admin-muted">
                      Учётные записи:{' '}
                      {g.accounts.map((a) => a.login).join(' · ')}
                    </span>
                  )}
                </div>
                <div className="admin-role-row__body">
                  {editing ? (
                    <div className="admin-stack" style={{ gap: 12 }}>
                      {g.accounts.map((account) => (
                        <div key={account.id} className="admin-role-account">
                          {multi && (
                            <div className="admin-role-account__login">
                              Логин <code>{account.login}</code>
                            </div>
                          )}
                          <EmployeeRolesEditor
                            employee={account}
                            canAssignAdmin={canAssignAdmin}
                            options={options}
                            onDone={stopEditing}
                          />
                        </div>
                      ))}
                      <span className="admin-field__hint admin-muted">
                        Клик по роли — доступ вкл/выкл. ★ — основная роль
                        (рабочий экран по умолчанию); переключаться между
                        участками сотрудник может сканом рабочего места.
                        {multi
                          ? ' У сотрудника несколько учётных записей — доступы правятся и сохраняются для каждой отдельно.'
                          : ''}
                        {!canAssignAdmin
                          ? ' Роль «Администратор» назначает только администратор.'
                          : ''}
                      </span>
                    </div>
                  ) : (
                    <RoleChipsReadonly
                      roles={g.roles}
                      showLogins={multi}
                      labels={labels}
                    />
                  )}
                </div>
                {!editing && (
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost admin-role-row__edit"
                    onClick={() => setEditingKey(g.key)}
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
