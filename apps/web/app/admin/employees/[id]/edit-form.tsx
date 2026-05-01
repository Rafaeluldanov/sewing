'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  COMPENSATION_TYPES,
  type CompensationType,
  type EmployeeDetailDto,
} from '@sewing/shared/employees';
import { Icon } from '@/components/icon';
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

const COMPENSATION_HINT: Record<CompensationType, string> = {
  PIECEWORK:
    'Окладные начисления автоматически создаваться не будут. Оплата — через сдельные начисления (`/earnings`).',
  SALARY:
    'За каждый день, в который у сотрудника есть хотя бы одна смена, автоматически создаётся запись в `/earnings`. Сдельные начисления для этого сотрудника не создаются.',
  MIXED:
    'Оклад начисляется за день со сменой, плюс сохраняются обычные сдельные начисления по операциям.',
};

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="save" size={16} />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

interface Props {
  employee: EmployeeDetailDto;
}

/**
 * Форма редактирования management-полей сотрудника
 * (`/admin/employees/[id]`).
 *
 * Меняем только то, что MVP даёт менеджеру (см. `docs/screens.md §11`,
 * ADR-0021):
 *   - `compensationType` (PIECEWORK | SALARY | MIXED)
 *   - `salaryPerShift`   (обязательна для SALARY/MIXED)
 *   - `active`           (мягкий «архив»)
 *
 * `login`, `pinHash`, `role`, `fullName`, `paymentType` и `salaryBase`
 * на этой форме read-only — их меняет seed/админ через Prisma. Это
 * сознательное ограничение шага 19, чтобы не делать пол-ауф-flow за
 * один спринт.
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

  const update = updateEmployeeAction.bind(null, employee.id);
  const [state, formAction] = useFormState<UpdateEmployeeState, FormData>(
    update,
    initialUpdateEmployeeState,
  );

  const requiresRate =
    compensationType === 'SALARY' || compensationType === 'MIXED';

  return (
    <form action={formAction} className="detail-form">
      <div className="detail-form__grid">
        <div className="detail-form__field">
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

        <div className="detail-form__field">
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

        <div className="detail-form__field detail-form__field--inline">
          <input
            id="emp-active"
            type="checkbox"
            name="active"
            defaultChecked={employee.active}
          />
          <label htmlFor="emp-active">Активен</label>
        </div>
      </div>

      <p className="detail-form__hint">{COMPENSATION_HINT[compensationType]}</p>

      <div className="detail-form__actions">
        <SaveButton />
      </div>

      {state.successMessage && (
        <div className="detail-form__success" role="status">
          <Icon name="success" size={16} />
          <span>{state.successMessage}</span>
        </div>
      )}
      {state.error && (
        <div className="detail-form__error" role="alert">
          <Icon name="error" size={16} />
          <span>
            {state.error}
            {state.errorRequestId && (
              <span className="detail-form__error-rid">
                req: <code>{state.errorRequestId}</code>
              </span>
            )}
          </span>
        </div>
      )}
    </form>
  );
}
