'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Save } from 'lucide-react';
import {
  COMPENSATION_TYPES,
  EMPLOYEE_ROLES,
  type CompensationType,
  type EmployeeDetailDto,
} from '@sewing/shared/employees';
import {
  CASH_FLOW_DIRECTION_LABELS,
  type CashFlowItemDto,
} from '@sewing/shared/treasury';
import { formatRole } from '@/lib/admin-labels';
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
  /**
   * Активные статьи ДДС из казначейства для select-а «Статья ДДС
   * (выплаты)». Подгружается на странице карточки. Если массив пустой
   * (нет активных или backend упал) — select всё равно рендерится с
   * опцией «— из настроек казначейства —» (=снять привязку).
   */
  cashFlowItems?: CashFlowItemDto[];
  /**
   * Фича «несколько ролей»: может ли текущий пользователь выдавать/
   * снимать роль ADMIN (= он сам ADMIN). Для SHOP_MANAGER строка ADMIN
   * в списке ролей заблокирована (backend всё равно режет эскалацию).
   */
  canAssignAdmin?: boolean;
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
export function EmployeeEditForm({
  employee,
  divisionOptions = [],
  cashFlowItems = [],
  canAssignAdmin = false,
}: Props) {
  // Фича «несколько ролей»: набор ролей доступа (чекбоксы) + основная
  // роль (radio). Инвариант «основная всегда в наборе» держим в стейте
  // (нельзя снять чекбокс основной; выбор основной добавляет её в набор).
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(
    () =>
      new Set(
        employee.roles && employee.roles.length > 0
          ? employee.roles
          : [employee.role],
      ),
  );
  const [primaryRole, setPrimaryRole] = useState<string>(employee.role);

  function toggleRole(r: string) {
    setSelectedRoles((prev) => {
      if (prev.has(r)) {
        // Нельзя снять основную роль — сначала выберите другую основную.
        if (r === primaryRole) return prev;
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
      next.add(r); // основная всегда входит в набор
      return next;
    });
    setPrimaryRole(r);
  }

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
  // B2B-процент имеет смысл для основной роли CUTTER (так же читает
  // EarningsService). Реагируем на выбранную основную роль, а не на
  // сохранённую — чтобы поле появлялось сразу при смене основной.
  const isCutter = primaryRole === CUTTER_ROLE;

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

  // Если у сотрудника уже привязана статья ДДС, которой нет в активном
  // списке (например, её деактивировали) — добавим её отдельной опцией,
  // чтобы сохранение формы случайно не обнулило привязку.
  const salaryItemMissingCurrent =
    !!employee.salaryCashFlowItemId &&
    !cashFlowItems.some((i) => i.id === employee.salaryCashFlowItemId);

  return (
    <form action={formAction} className="admin-form">
      {/*
        Фича «несколько ролей»: чекбоксы всех assignable-ролей + radio
        «основная». Скрытый `rolesPresent` сообщает server-action, что
        форма ролей отрендерена (иначе роли не трогаем). Backend держит
        инвариант «набор содержит основную» и режет выдачу ADMIN
        не-админом — UI лишь прячет недоступное.
      */}
      <div className="admin-field admin-roles">
        <label>Роли доступа</label>
        <input type="hidden" name="rolesPresent" value="1" />
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
                {/*
                  Сохраняем текущую ADMIN-привязку, когда менеджер не
                  вправе её менять: disabled-инпуты не попадают в FormData,
                  поэтому без этих hidden значений сохранение «съело» бы
                  ADMIN и backend вернул бы ошибку эскалации.
                */}
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
          {!canAssignAdmin ? ' Роль «Администратор» назначает только администратор.' : ''}
        </span>
      </div>

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

        {/*
          Статья ДДС для выплат зарплаты этому сотруднику. Переопределяет
          глобальную «зарплатную» статью из настроек казначейства в
          расходной проводке журнала ДС при выдаче выплаты. Пустое
          значение → проводка берёт глобальную статью (или не пишется,
          если и она не задана). Показываем для всех — выплаты бывают и
          у сдельщиков, и у окладников. Список ведётся в разделе
          «Казначейство → Статьи ДДС».
        */}
        <div className="admin-field">
          <label htmlFor="emp-salary-dds-item">Статья ДДС (выплаты)</label>
          <select
            id="emp-salary-dds-item"
            name="salaryCashFlowItemId"
            defaultValue={employee.salaryCashFlowItemId ?? ''}
            aria-describedby="emp-salary-dds-item-hint"
          >
            <option value="">— из настроек казначейства —</option>
            {salaryItemMissingCurrent && employee.salaryCashFlowItemId && (
              <option value={employee.salaryCashFlowItemId}>
                {employee.salaryCashFlowItemName ?? 'Текущая статья'}{' '}
                (неактивна)
              </option>
            )}
            {cashFlowItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.direction
                  ? ` · ${CASH_FLOW_DIRECTION_LABELS[item.direction]}`
                  : ''}
                {item.code ? ` (${item.code})` : ''}
              </option>
            ))}
          </select>
          <span
            id="emp-salary-dds-item-hint"
            className="admin-field__hint admin-muted"
          >
            При выдаче зарплаты этому сотруднику проводка в кассу пойдёт
            по выбранной статье. «— из настроек казначейства —» — берётся
            общая зарплатная статья (Казначейство → Настройки).
          </span>
        </div>

        {/*
          PHASE 2 STEP 5: «ставка за смену» имеет смысл только для
          SALARY/MIXED — для PIECEWORK поле прятали и раньше через
          UI-подсказку, теперь скрываем по-настоящему. Для PIECEWORK
          FormData ничего не отправит и backend (`UpdateEmployeeSchema`)
          оставит `salaryPerShift = null` без правки. Если менеджер
          переключится на SALARY/MIXED, поле появится; обязательность
          гарантирует backend — без ставки PATCH вернёт
          `EMPLOYEE_SALARY_RATE_REQUIRED`.
        */}
        {requiresRate && (
          <div className="admin-field">
            <label htmlFor="emp-salary-per-shift">Ставка за смену, ₽</label>
            <input
              id="emp-salary-per-shift"
              name="salaryPerShift"
              type="text"
              inputMode="decimal"
              value={salaryPerShift}
              onChange={(e) => setSalaryPerShift(e.target.value)}
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
