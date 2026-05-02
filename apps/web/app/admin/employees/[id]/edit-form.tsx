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

interface DivisionOption {
  id: string;
  code: string;
  name: string;
}

interface Props {
  employee: EmployeeDetailDto;
  /**
   * PHASE 2 STEP 2: список активных подразделений для select-а
   * «Подразделение». Подгружается на странице карточки. Если
   * массив пустой (нет активных или backend упал) — поле
   * прячется. Если у сотрудника установлено soft-deleted
   * подразделение — оно остаётся в DTO, но в select его не
   * будет; чтобы не «потерять» текущую привязку, мы добавляем
   * её к опциям, помеченную меткой `(отключено)`.
   */
  divisionOptions?: DivisionOption[];
}

/**
 * Форма редактирования management-полей сотрудника
 * (`/admin/employees/[id]`, Admin UI 2.5).
 *
 * Меняет только то, что MVP даёт менеджеру (см. ADR-0021):
 *   - `compensationType` (PIECEWORK | SALARY | MIXED)
 *   - `salaryPerShift`   (обязательна для SALARY/MIXED)
 *   - `active`           (мягкий «архив»)
 *   - `companyDivisionId` (PHASE 2 STEP 2)
 */
export function EmployeeEditForm({ employee, divisionOptions = [] }: Props) {
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
  // PHASE 2 STEP 2: подразделение. Дефолт — текущая привязка
  // карточки (если она есть и не дропнулась).
  const [companyDivisionId, setCompanyDivisionId] = useState<string>(
    employee.companyDivisionId ?? '',
  );
  const isCutter = employee.role === CUTTER_ROLE;

  // Если текущая привязка указывает на soft-deleted подразделение
  // (его нет в `divisionOptions`), добавим запись «(отключено)»,
  // чтобы менеджер видел текущее значение и мог его убрать.
  const currentDivisionInOptions =
    !employee.companyDivisionId ||
    divisionOptions.some((d) => d.id === employee.companyDivisionId);
  const optionsWithCurrent = currentDivisionInOptions
    ? divisionOptions
    : [
        ...divisionOptions,
        {
          id: employee.companyDivisionId!,
          code: employee.companyDivision?.code ?? '???',
          name: `${employee.companyDivision?.name ?? '???'} (отключено)`,
        },
      ];

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
        PHASE 2 STEP 2: подразделение. Если у проекта есть хотя бы
        одно активное подразделение — рендерим select; иначе поле
        прячется (форма работает как раньше). Пустое значение в
        select-е → `null` в DTO → стираем привязку.
      */}
      {optionsWithCurrent.length > 0 && (
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
              {optionsWithCurrent.map((d) => (
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
              окладной части (смены, дневной оклад). Сдельные
              начисления автоматически попадают в подразделение
              заказа независимо от этого выбора.
            </span>
          </div>
        </div>
      )}

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
