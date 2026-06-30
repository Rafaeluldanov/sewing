'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Plus, XCircle } from 'lucide-react';
import {
  COMPENSATION_TYPES,
  EMPLOYEE_ROLES,
  type CompensationType,
  type EmployeeRole,
} from '@sewing/shared/employees';
import { createEmployeeAction } from './actions';
import {
  initialCreateEmployeeState,
  type CreateEmployeeState,
} from './form-state';

/**
 * Роль закройщика — единственная, для которой имеет смысл поле
 * «Процент от операций пошива B2B». Сравниваем строкой, чтобы UI
 * не зависел от Prisma `Role` enum-а.
 */
const CUTTER_ROLE: EmployeeRole = 'CUTTER';

const ROLE_LABELS: Record<EmployeeRole, string> = {
  ADMIN: 'Администратор',
  SHOP_MANAGER: 'Начальник цеха',
  CUTTER: 'Раскройщик',
  CUTTER_ASSISTANT: 'Помощник раскройщика',
  SEAMSTRESS: 'Швея',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
  SHOPFLOOR_MASTER: 'Мастер цеха',
  CONSTRUCTOR: 'Конструктор',
};

const COMPENSATION_LABEL: Record<CompensationType, string> = {
  PIECEWORK: 'Сдельная',
  SALARY: 'Оклад (почасовой)',
  MIXED: 'Оклад + сдельная',
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Plus size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Создаём…' : 'Создать'}
    </button>
  );
}

/**
 * PHASE 2 STEP 2: список подразделений для select-а «Подразделение».
 * Загружается на странице (`/admin/employees/new`) через
 * `listCompanyDivisions({ includeInactive: false })` и передаётся
 * сюда — компоненту-форме нужно только id/code/name.
 */
interface DivisionOption {
  id: string;
  code: string;
  name: string;
}

interface Props {
  divisionOptions?: DivisionOption[];
}

/**
 * Форма создания сотрудника на `/admin/employees/new`.
 *
 * Поля собраны из управленческой модели `Employee`. После успеха
 * action редиректит на карточку нового сотрудника, чтобы менеджер
 * сразу мог проверить и при необходимости подправить окладные поля.
 */
export function CreateEmployeeForm({ divisionOptions = [] }: Props) {
  const [role, setRole] = useState<EmployeeRole>('SEAMSTRESS');
  const [compensationType, setCompensationType] = useState<CompensationType>(
    'PIECEWORK',
  );
  const [salaryPerHour, setSalaryPerHour] = useState<string>('');
  // B2B-процент закройщика. Поле имеет смысл только для роли
  // CUTTER (см. `docs/payroll-cutter-compensation-recon.md`); UI
  // прячет его для всех остальных ролей.
  const [cutterB2bPercent, setCutterB2bPercent] = useState<string>('');
  // PHASE 2 STEP 2: подразделение. По умолчанию — пусто
  // (`null`), чтобы менеджер сознательно сделал выбор.
  const [companyDivisionId, setCompanyDivisionId] = useState<string>('');

  const [state, formAction] = useFormState<CreateEmployeeState, FormData>(
    createEmployeeAction,
    initialCreateEmployeeState,
  );

  const requiresRate =
    compensationType === 'SALARY' || compensationType === 'MIXED';
  const isCutter = role === CUTTER_ROLE;

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="emp-full-name">ФИО</label>
          <input
            id="emp-full-name"
            name="fullName"
            type="text"
            maxLength={200}
            placeholder="например, Иванова Анна Петровна"
            required
            autoComplete="off"
          />
        </div>

        <div className="admin-field">
          <label htmlFor="emp-login">Логин</label>
          <input
            id="emp-login"
            name="login"
            type="text"
            maxLength={64}
            minLength={2}
            placeholder="например, ivanova"
            required
            autoComplete="off"
            style={{ textTransform: 'lowercase' }}
          />
        </div>

        <div className="admin-field">
          <label htmlFor="emp-pin">PIN</label>
          <input
            id="emp-pin"
            name="pin"
            type="text"
            minLength={4}
            maxLength={100}
            placeholder="минимум 4 символа"
            required
            autoComplete="off"
          />
        </div>
      </div>

      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="emp-role">Роль</label>
          <select
            id="emp-role"
            name="role"
            value={role}
            onChange={(e) => setRole(e.target.value as EmployeeRole)}
            required
          >
            {EMPLOYEE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>

        <div className="admin-field">
          <label htmlFor="emp-comp-type">Тип компенсации</label>
          <select
            id="emp-comp-type"
            name="compensationType"
            value={compensationType}
            onChange={(e) =>
              setCompensationType(e.target.value as CompensationType)
            }
          >
            {COMPENSATION_TYPES.map((c) => (
              <option key={c} value={c}>
                {COMPENSATION_LABEL[c]}
              </option>
            ))}
          </select>
        </div>

        {/*
          Почасовая ставка — только для SALARY/MIXED (повременная
          оплата). Для PIECEWORK поле не рендерится — FormData чистая,
          backend получит `salaryPerHour = null` и сохранит без ставки.
        */}
        {requiresRate && (
          <div className="admin-field">
            <label htmlFor="emp-salary-per-hour">Ставка, ₽/час</label>
            <input
              id="emp-salary-per-hour"
              name="salaryPerHour"
              type="text"
              inputMode="decimal"
              value={salaryPerHour}
              onChange={(e) => setSalaryPerHour(e.target.value)}
              placeholder="обязательно"
              required
              autoComplete="off"
            />
          </div>
        )}

        <div className="admin-field admin-field--inline">
          <input
            id="emp-active"
            type="checkbox"
            name="active"
            defaultChecked
          />
          <label htmlFor="emp-active">Активен</label>
        </div>
      </div>

      {/*
        PHASE 2 STEP 2: подразделение сотрудника
        (`Employee.companyDivisionId`). Источник опций — активные
        записи `CompanyDivision` (см. `/admin/company-settings`).
        Если у проекта нет ни одного активного подразделения,
        select прячется — форма работает как раньше.
      */}
      {divisionOptions.length > 0 && (
        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="emp-company-division">Подразделение</label>
            <select
              id="emp-company-division"
              name="companyDivisionId"
              value={companyDivisionId}
              onChange={(e) => setCompanyDivisionId(e.target.value)}
            >
              <option value="">— без привязки —</option>
              {divisionOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.code})
                </option>
              ))}
            </select>
            <span
              id="emp-company-division-hint"
              className="admin-field__hint admin-muted"
            >
              Используется payroll-фильтром «Подразделение» для
              окладной части. Сдельные начисления уходят в
              подразделение заказа независимо от этой привязки.
            </span>
          </div>
        </div>
      )}

      {/*
        Поле «Процент от операций пошива B2B» — только для роли
        CUTTER. См. `docs/payroll-cutter-compensation-recon.md`.
        Для остальных ролей UI поле не рендерит — FormData чистая,
        backend колонку не трогает.
      */}
      {isCutter && (
        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="emp-cutter-b2b-percent">
              Процент от операций пошива B2B, %
            </label>
            <input
              id="emp-cutter-b2b-percent"
              name="cutterB2bSewingPercent"
              type="number"
              step="0.01"
              min="0"
              max="100"
              inputMode="decimal"
              value={cutterB2bPercent}
              onChange={(e) => setCutterB2bPercent(e.target.value)}
              placeholder="—"
              autoComplete="off"
              aria-describedby="emp-cutter-b2b-percent-hint"
            />
            <span
              id="emp-cutter-b2b-percent-hint"
              className="admin-field__hint admin-muted"
            >
              Используется только для B2B-заказов. Marketplace продолжает
              использовать старую схему начисления. Если поле пустое —
              backend берёт fallback из переменной окружения
              <code style={{ marginLeft: 4 }}>CUTTER_B2B_SEWING_PERCENT</code>.
            </span>
          </div>
        </div>
      )}

      <div className="admin-actions-row">
        <SubmitButton />
      </div>

      {state.error && (
        <div
          role="alert"
          style={{ color: 'var(--admin-danger-fg)', fontSize: '0.88rem' }}
        >
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
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
