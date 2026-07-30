'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Lock, Save, XCircle } from 'lucide-react';
import {
  ROLE_WORKSPACES,
  ROLE_WORKSPACE_LABELS,
  type AppRoleDto,
  type RoleWorkspace,
} from '@sewing/shared/app-roles';
import { createAppRoleAction, updateAppRoleAction } from './actions';
import { initialAppRoleFormState, type AppRoleFormState } from './form-state';

interface Props {
  /** Роль для правки. `undefined` — форма создания. */
  role?: AppRoleDto;
  /**
   * Кандидаты в доноры прав. Сама редактируемая роль сюда не попадает
   * (роль не может наследовать себя), архивные — тоже: наследоваться от
   * выведенной из обращения роли значит закладывать мину.
   */
  candidates: AppRoleDto[];
}

function SubmitButton({ create }: { create: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : create ? 'Создать роль' : 'Сохранить'}
    </button>
  );
}

/**
 * Форма роли — одна и для создания (`/admin/roles/new`), и для правки
 * (`/admin/roles/[id]`).
 *
 * Модель прав — НАСЛЕДОВАНИЕ: роль не перечисляет разрешения поимённо,
 * а отмечает галочками роли-доноры. Права доноров она получает целиком
 * и транзитивно (донор донора тоже считается).
 *
 * Системная роль редактируется только по названию: её код зашит в
 * декораторах бэкенда и в терминалах цеха, менять ей права или экран
 * из админки нельзя (backend вернёт `APP_ROLE_SYSTEM_IMMUTABLE`).
 */
export function RoleForm({ role, candidates }: Props) {
  const create = !role;
  const system = role?.system ?? false;

  const [inherits, setInherits] = useState<Set<string>>(
    () => new Set(role?.inherits ?? []),
  );
  const [workspace, setWorkspace] = useState<string>(role?.workspace ?? '/');
  const [singleWorkspace, setSingleWorkspace] = useState(
    role?.singleWorkspace ?? false,
  );
  const [lockToWorkspace, setLockToWorkspace] = useState(
    role?.lockToWorkspace ?? false,
  );

  const [state, formAction] = useFormState<AppRoleFormState, FormData>(
    create ? createAppRoleAction : updateAppRoleAction,
    initialAppRoleFormState,
  );

  function toggleInherit(code: string) {
    setInherits((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  return (
    <form action={formAction} className="admin-form">
      {role && <input type="hidden" name="id" value={role.id} />}
      {role && <input type="hidden" name="system" value={system ? '1' : '0'} />}

      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="role-code">Код роли</label>
          <input
            id="role-code"
            name="code"
            type="text"
            maxLength={40}
            placeholder="например, TECHNOLOGIST"
            required={create}
            readOnly={!create}
            defaultValue={role?.code ?? ''}
            autoComplete="off"
            style={!create ? { opacity: 0.7 } : undefined}
          />
          <span className="admin-field__hint admin-muted">
            {create
              ? 'Латиница, цифры и подчёркивание. После создания не меняется — код записывается сотрудникам и в их сессии.'
              : 'Код роли неизменяем: он уже записан сотрудникам и в выданные сессии.'}
          </span>
        </div>

        <div className="admin-field">
          <label htmlFor="role-name">Название</label>
          <input
            id="role-name"
            name="name"
            type="text"
            maxLength={80}
            placeholder="например, Технолог"
            required
            defaultValue={role?.name ?? ''}
            autoComplete="off"
          />
          <span className="admin-field__hint admin-muted">
            Как роль называется в интерфейсе и в карточке сотрудника.
          </span>
        </div>
      </div>

      {system ? (
        <div className="admin-note" role="note">
          <Lock size={15} strokeWidth={1.6} aria-hidden /> Это системная роль.
          Её права и рабочий экран заданы в коде приложения — из админки
          меняется только название.
        </div>
      ) : (
        <>
          <fieldset className="admin-field" style={{ minWidth: 0 }}>
            <legend style={{ fontWeight: 600, fontSize: '0.88rem' }}>
              Наследует права ролей
            </legend>
            <div className="admin-role-chips">
              {candidates.map((c) => {
                const on = inherits.has(c.code);
                return (
                  <span
                    key={c.code}
                    className={
                      'admin-role-chip' + (on ? ' admin-role-chip--on' : '')
                    }
                  >
                    <button
                      type="button"
                      className="admin-role-chip__toggle"
                      aria-pressed={on}
                      onClick={() => toggleInherit(c.code)}
                    >
                      {c.name}
                    </button>
                  </span>
                );
              })}
            </div>
            {[...inherits].map((c) => (
              <input key={c} type="hidden" name="inherits" value={c} />
            ))}
            <span className="admin-field__hint admin-muted">
              Роль получает ВСЕ права отмеченных ролей — и того, что
              наследуют они сами. Ничего не отмечено — роль даёт только вход
              в систему и свой рабочий экран.
            </span>
          </fieldset>

          <div className="admin-field">
            <label htmlFor="role-workspace">Рабочий экран</label>
            <select
              id="role-workspace"
              name="workspace"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
            >
              {ROLE_WORKSPACES.map((w) => (
                <option key={w} value={w}>
                  {ROLE_WORKSPACE_LABELS[w as RoleWorkspace]}
                </option>
              ))}
            </select>
            <span className="admin-field__hint admin-muted">
              Куда попадает сотрудник после входа. Экран должен быть доступен
              роли — иначе отметьте выше роль, которая его открывает.
            </span>
          </div>

          <fieldset className="admin-field" style={{ minWidth: 0 }}>
            <legend style={{ fontWeight: 600, fontSize: '0.88rem' }}>
              Поведение навигации
            </legend>

            <label className="admin-field--inline" htmlFor="role-single">
              <input
                id="role-single"
                type="checkbox"
                name="singleWorkspace"
                checked={singleWorkspace || lockToWorkspace}
                disabled={lockToWorkspace}
                onChange={(e) => setSingleWorkspace(e.target.checked)}
              />
              <span>Одно рабочее окно</span>
            </label>
            <span className="admin-field__hint admin-muted">
              Прятать общее меню — экран выглядит как отдельный терминал.
              Действует, только если у сотрудника ровно одна роль.
            </span>

            <label className="admin-field--inline" htmlFor="role-lock">
              <input
                id="role-lock"
                type="checkbox"
                name="lockToWorkspace"
                checked={lockToWorkspace}
                onChange={(e) => {
                  setLockToWorkspace(e.target.checked);
                  if (e.target.checked) setSingleWorkspace(true);
                }}
              />
              <span>Запереть на рабочем экране</span>
            </label>
            <span className="admin-field__hint admin-muted">
              Любая другая страница будет уводить обратно. Так работают
              раскройщик, конструктор, мастер цеха и цеховой монитор.
            </span>
          </fieldset>
        </>
      )}

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
      {state.ok && !create && (
        <div className="success-box" role="status">
          Сохранено. Права применятся сразу — перелогин сотрудникам не нужен.
        </div>
      )}

      <div className="admin-actions-row">
        <SubmitButton create={create} />
      </div>
    </form>
  );
}
