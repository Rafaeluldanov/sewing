'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Layers, Save, XCircle } from 'lucide-react';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { CompanySettingsDto } from '@sewing/shared/company-settings';
import {
  AdminCard,
  AdminSectionHeader,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { updateCompanyDivisionOverridesAction } from './actions';
import {
  initialUpdateCompanyDivisionOverridesState,
  type UpdateCompanyDivisionOverridesState,
} from './form-state';

/**
 * Секция «Настройки по подразделениям» на странице
 * `/admin/company-settings` (рендерится ниже карточки «Материалы и
 * склад»; см. ТЗ «Division overrides»).
 *
 * Дизайн:
 *   - один select на каждую пару (`division` × override) с тремя
 *     значениями: `inherit` / `true` / `false`. Switch здесь
 *     сознательно НЕ используем — нужно третье состояние
 *     «наследовать», а у checkbox / switch такого нет;
 *   - каждая строка — отдельный `<form>` с собственным server
 *     action (`updateCompanyDivisionOverridesAction`). PATCH
 *     обновляет только 2 override-поля `CompanyDivision`, не
 *     трогая остальные;
 *   - effective-hint («Сейчас: включено / запрещено / выключено /
 *     разрешены») рассчитывается на клиенте из выбранного value и
 *     текущего global `CompanySettings`, поэтому сразу отражает,
 *     что именно сохранится.
 *
 * Нарочно НЕ создаём новую страницу и не добавляем пункт в sidebar —
 * вся логика живёт в уже существующем `/admin/company-settings`.
 */

export const DIVISION_OVERRIDE_INHERIT_VALUE = 'inherit';
export const DIVISION_OVERRIDE_TRUE_VALUE = 'true';
export const DIVISION_OVERRIDE_FALSE_VALUE = 'false';

type OverrideValue =
  | typeof DIVISION_OVERRIDE_INHERIT_VALUE
  | typeof DIVISION_OVERRIDE_TRUE_VALUE
  | typeof DIVISION_OVERRIDE_FALSE_VALUE;

function overrideToValue(override: boolean | null | undefined): OverrideValue {
  if (override === true) return DIVISION_OVERRIDE_TRUE_VALUE;
  if (override === false) return DIVISION_OVERRIDE_FALSE_VALUE;
  return DIVISION_OVERRIDE_INHERIT_VALUE;
}

function valueToOverride(value: OverrideValue): boolean | null {
  if (value === DIVISION_OVERRIDE_TRUE_VALUE) return true;
  if (value === DIVISION_OVERRIDE_FALSE_VALUE) return false;
  return null;
}

function effectiveFlag(
  override: boolean | null | undefined,
  companyValue: boolean,
): boolean {
  if (override === true) return true;
  if (override === false) return false;
  return companyValue;
}

function SubmitRowButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

function DivisionOverridesRow({
  division,
  settings,
}: {
  division: CompanyDivisionDto;
  settings: CompanySettingsDto;
}) {
  const [state, formAction] = useFormState<
    UpdateCompanyDivisionOverridesState,
    FormData
  >(
    updateCompanyDivisionOverridesAction.bind(null, division.id),
    initialUpdateCompanyDivisionOverridesState,
  );

  const autoIssueValue = overrideToValue(
    division.autoIssueMaterialsOnCutReleaseOverride,
  );
  const allowNegativeValue = overrideToValue(
    division.allowNegativeMaterialStockOverride,
  );

  const effectiveAutoIssue = effectiveFlag(
    division.autoIssueMaterialsOnCutReleaseOverride,
    settings.autoIssueMaterialsOnCutRelease,
  );
  const effectiveAllowNegative = effectiveFlag(
    division.allowNegativeMaterialStockOverride,
    settings.allowNegativeMaterialStock,
  );

  return (
    <form action={formAction} className="admin-form">
      <div
        className="admin-form-grid"
        style={{ alignItems: 'flex-start' }}
      >
        <div className="admin-field">
          <label
            htmlFor={`division-autoIssue-${division.id}`}
          >
            Автосписание при выдаче кроя
          </label>
          <select
            id={`division-autoIssue-${division.id}`}
            name="autoIssueMaterialsOnCutReleaseOverride"
            defaultValue={autoIssueValue}
          >
            <option value={DIVISION_OVERRIDE_INHERIT_VALUE}>
              Наследовать настройку компании
            </option>
            <option value={DIVISION_OVERRIDE_TRUE_VALUE}>Включено</option>
            <option value={DIVISION_OVERRIDE_FALSE_VALUE}>Выключено</option>
          </select>
          <span className="admin-field__hint">
            Сейчас: {effectiveAutoIssue ? 'включено' : 'выключено'}
          </span>
        </div>
        <div className="admin-field">
          <label
            htmlFor={`division-allowNegative-${division.id}`}
          >
            Отрицательные остатки
          </label>
          <select
            id={`division-allowNegative-${division.id}`}
            name="allowNegativeMaterialStockOverride"
            defaultValue={allowNegativeValue}
          >
            <option value={DIVISION_OVERRIDE_INHERIT_VALUE}>
              Наследовать настройку компании
            </option>
            <option value={DIVISION_OVERRIDE_TRUE_VALUE}>Разрешены</option>
            <option value={DIVISION_OVERRIDE_FALSE_VALUE}>Запрещены</option>
          </select>
          <span className="admin-field__hint">
            Сейчас: {effectiveAllowNegative ? 'разрешены' : 'запрещены'}
          </span>
        </div>
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
        </div>
      )}

      <div className="admin-actions-row">
        <SubmitRowButton />
      </div>
    </form>
  );
}

export function MaterialStockDivisionOverridesSection({
  divisions,
  settings,
}: {
  divisions: CompanyDivisionDto[];
  settings: CompanySettingsDto;
}) {
  const active = divisions.filter((d) => d.isActive);

  const columns: AdminTableColumn<CompanyDivisionDto>[] = [
    {
      key: 'name',
      header: 'Подразделение',
      render: (d) => (
        <div className="admin-stack" style={{ gap: 2 }}>
          <span className="admin-table__primary">{d.name}</span>
          <code style={{ fontSize: 12, color: 'var(--admin-muted)' }}>
            {d.code}
          </code>
        </div>
      ),
    },
    {
      key: 'overrides',
      header: 'Настройки материалов и склада',
      render: (d) => (
        <DivisionOverridesRow division={d} settings={settings} />
      ),
    },
  ];

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<Layers size={18} strokeWidth={1.6} aria-hidden />}
        title="Настройки по подразделениям"
        hint="Переопределяют глобальные флаги «Материалы и склад» для выбранного подразделения. «Наследовать» — использовать значение компании."
      />
      {active.length === 0 ? (
        <p className="admin-muted">
          Подразделения ещё не созданы. Используются настройки компании.
        </p>
      ) : (
        <AdminTable
          rows={active}
          columns={columns}
          rowKey={(d) => d.id}
        />
      )}
    </AdminCard>
  );
}
