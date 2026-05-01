'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Save } from 'lucide-react';
import {
  COMPENSATION_TYPES,
  type CompensationType,
  type EmployeeDetailDto,
} from '@sewing/shared/employees';
import { updateEmployeeAction } from '../actions';
import {
  initialUpdateEmployeeState,
  type UpdateEmployeeState,
} from '../form-state';

const COMPENSATION_LABEL: Record<CompensationType, string> = {
  PIECEWORK: 'Сдельная',
  SALARY: 'Оклад за смену',
  MIXED: 'Оклад + сдельная',
};

/**
 * Роль закройщика — единственная, для которой имеет смысл
 * `cutterB2bSewingPercent`. Сравниваем строкой, чтобы не тащить
 * сюда `EmployeeRole`-enum (поле `Employee.role` приходит как
 * `string` в DTO и гарантированно совпадает с Prisma enum-значением).
 */
const CUTTER_ROLE = 'CUTTER';

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="admin-btn admin-btn--primary" disabled={pending}>
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

interface Props {
  employee: EmployeeDetailDto;
}

/**
 * Форма редактирования management-полей сотрудника
 * (`/admin/employees/[id]`, Admin UI 2.5).
 *
 * Меняет только то, что MVP даёт менеджеру (см. ADR-0021):
 *   - `compensationType` (PIECEWORK | SALARY | MIXED)
 *   - `salaryPerShift`   (обязательна для SALARY/MIXED)
 *   - `active`           (мягкий «архив»)
 *
 * Backend / DTO не меняем — server action `updateEmployeeAction`
 * принимает тот же FormData, что и раньше.
 */
export function EmployeeEditForm({ employee }: Props) {
  const [compensationType, setCompensationType] = useState<CompensationType>(
    employee.compensationType,
  );
  const [salaryPerShift, setSalaryPerShift] = useState<string>(
    employee.salaryPerShift !== null
      ? employee.salaryPerShift.toString()
      : '',
  );
  // B2B-процент закройщика. См.
  // `docs/payroll-cutter-compensation-recon.md`. Поле имеет смысл
  // только для роли CUTTER — для остальных ролей UI его не
  // показывает, в FormData ничего не уходит.
  const [cutterB2bPercent, setCutterB2bPercent] = useState<string>(
    employee.cutterB2bSewingPercent !== null &&
      employee.cutterB2bSewingPercent !== undefined
      ? String(employee.cutterB2bSewingPercent)
      : '',
  );
  const isCutter = employee.role === CUTTER_ROLE;

  const update = updateEmployeeAction.bind(null, employee.id);
  const [state, formAction] = useFormState<UpdateEmployeeState, FormData>(
    update,
    initialUpdateEmployeeState,
  );

  const requiresRate =
    compensationType === 'SALARY' || compensationType === 'MIXED';

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
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

        <div className="admin-field">
          <label htmlFor="emp-salary-per-shift">Ставка за смену, ₽</label>
          <input
            id="emp-salary-per-shift"
            name="salaryPerShift"
            type="text"
            inputMode="decimal"
            value={salaryPerShift}
            onChange={(e) => setSalaryPerShift(e.target.value)}
            placeholder={requiresRate ? 'обязательно' : '—'}
            required={requiresRate}
            autoComplete="off"
          />
        </div>

        <div className="admin-field admin-field--inline">
          <input
            id="emp-active"
            type="checkbox"
            name="active"
            defaultChecked={employee.active}
          />
          <label htmlFor="emp-active">Активен</label>
        </div>
      </div>

      {/*
        Поле «Процент от операций пошива B2B» — только для роли CUTTER.
        Использует ту же FormData-точку (`cutterB2bSewingPercent`),
        что и server-action `updateEmployeeAction`. Для остальных
        ролей поле просто не рендерится — FormData не пишется и
        backend колонку не трогает (`undefined` ветка в DTO).
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
        <SaveButton />
      </div>

      {state.successMessage && (
        <div role="status" className="admin-muted" style={{ fontSize: '0.88rem' }}>
          {state.successMessage}
        </div>
      )}
      {state.error && (
        <div role="alert" style={{ color: 'var(--admin-danger-fg)', fontSize: '0.88rem' }}>
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
