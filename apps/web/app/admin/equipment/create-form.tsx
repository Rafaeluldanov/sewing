'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Flame,
  Package,
  Plus,
  Scissors,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import { EMPLOYEE_ROLES } from '@sewing/shared/employees';
import { GroupedOperationSelect } from '@/components/admin';
import { formatRole } from '@/lib/admin-labels';
import { createEquipmentAction } from './actions';

/**
 * Роли, которые имеет смысл назначать «рабочему месту» для
 * скан-переключения (фича «смена роли сканом»). Управленческие роли
 * (ADMIN/SHOP_MANAGER) — это не сканируемые участки, поэтому исключены.
 */
const WORKPLACE_ROLE_OPTIONS = EMPLOYEE_ROLES.filter(
  (r) => r !== 'ADMIN' && r !== 'SHOP_MANAGER',
);
import {
  initialCreateEquipmentState,
  type CreateEquipmentState,
} from './form-state';

interface Props {
  operations: readonly OperationLiteDto[];
}

const CATEGORY_ICON: Record<string, LucideIcon> = {
  CUTTING: Scissors,
  SEWING: Activity,
  QC: CheckCircle2,
  IRONING: Flame,
  PACKING: Package,
};

function categoryIcon(category: string): LucideIcon {
  return CATEGORY_ICON[category.toUpperCase()] ?? Activity;
}

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
 * Форма создания оборудования (Admin UI 2.6).
 *
 * Backend / DTO не меняем. Поля:
 *   - Название — обязательное;
 *   - Номер — опциональный ручной `displayNumber`;
 *   - Операции — компактный chip-список (тот же UX, что и на
 *     карточке оборудования). Без code, без длинных описаний.
 */
export function CreateEquipmentForm({ operations }: Props) {
  const [state, formAction] = useFormState<CreateEquipmentState, FormData>(
    createEquipmentAction,
    initialCreateEquipmentState,
  );

  const sortedOperations = [...operations].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pendingId, setPendingId] = useState<string>('');

  const opsById = new Map(sortedOperations.map((op) => [op.id, op]));
  const availableOptions = sortedOperations.filter(
    (op) => !selectedIds.includes(op.id),
  );

  function addOperation() {
    if (!pendingId || selectedIds.includes(pendingId)) return;
    setSelectedIds((prev) => [...prev, pendingId]);
    setPendingId('');
  }

  function removeOperation(id: string) {
    setSelectedIds((prev) => prev.filter((x) => x !== id));
  }

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="eq-name">Название</label>
          <input
            id="eq-name"
            name="name"
            type="text"
            maxLength={120}
            placeholder="например, Оверлок 03"
            required
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="eq-display-number">Номер</label>
          <input
            id="eq-display-number"
            name="displayNumber"
            type="text"
            maxLength={16}
            placeholder="опционально"
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="eq-role">Роль участка</label>
          <select id="eq-role" name="role" defaultValue="">
            <option value="">— без роли —</option>
            {WORKPLACE_ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {formatRole(r)}
              </option>
            ))}
          </select>
          <span className="admin-field__hint admin-muted">
            Если задана, сотрудник со сканом QR этого рабочего места
            переключается на терминал этой роли (нужна для участков
            ОТК/ВТО/Упаковка/Крой).
          </span>
        </div>
      </div>

      <div className="admin-field">
        <label>Разрешённые операции</label>
        <ul className="admin-chip-list">
          {selectedIds.length === 0 && (
            <li className="admin-muted" style={{ fontSize: '0.88rem' }}>
              Пока ничего не выбрано.
            </li>
          )}
          {selectedIds.map((id) => {
            const op = opsById.get(id);
            if (!op) return null;
            const Icon = categoryIcon(op.category);
            return (
              <li key={id} className="admin-chip">
                <span className="admin-chip__icon" aria-hidden>
                  <Icon size={13} strokeWidth={1.7} />
                </span>
                <span>{op.name}</span>
                <button
                  type="button"
                  className="admin-chip__remove"
                  onClick={() => removeOperation(id)}
                  aria-label={`Убрать ${op.name}`}
                >
                  ×
                </button>
                <input type="hidden" name="operationIds" value={id} />
              </li>
            );
          })}
        </ul>
        <div
          className="admin-actions-row"
          style={{ justifyContent: 'flex-start' }}
        >
          <GroupedOperationSelect
            operations={availableOptions}
            name="pendingOperationId"
            value={pendingId}
            onChange={setPendingId}
            placeholder="— выбрать операцию —"
            ariaLabel="Добавить операцию"
            className="admin-chip-add__select"
          />
          <button
            type="button"
            className="admin-btn"
            onClick={addOperation}
            disabled={!pendingId}
          >
            <Plus size={14} strokeWidth={1.6} aria-hidden />
            Добавить
          </button>
        </div>
      </div>

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
