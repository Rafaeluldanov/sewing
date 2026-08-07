'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Flame,
  Package,
  Plus,
  Save,
  Scissors,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { EquipmentDetailDto } from '@sewing/shared/equipment';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import { EMPLOYEE_ROLES } from '@sewing/shared/employees';
import { GroupedOperationSelect } from '@/components/admin';
import { formatRole } from '@/lib/admin-labels';
import {
  updateEquipmentDisplayNumberAction,
  updateEquipmentNameAction,
  updateEquipmentOperationsAction,
  updateEquipmentRoleAction,
} from './actions';
import {
  initialUpdateDisplayNumberState,
  initialUpdateNameState,
  initialUpdateOperationsState,
  initialUpdateRoleState,
  type UpdateDisplayNumberState,
  type UpdateNameState,
  type UpdateOperationsState,
  type UpdateRoleState,
} from './form-state';

/**
 * Роли, назначаемые «рабочему месту» для скан-переключения (фича
 * «смена роли сканом»). Управленческие роли исключены — это не
 * сканируемые участки.
 */
const WORKPLACE_ROLE_OPTIONS = EMPLOYEE_ROLES.filter(
  (r) => r !== 'ADMIN' && r !== 'SHOP_MANAGER',
);

interface Props {
  equipment: EquipmentDetailDto;
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

function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : label}
    </button>
  );
}

/**
 * Точечная форма переименования оборудования.
 *
 * Сознательно живёт отдельно от номера и чек-листа операций — у
 * каждой секции свой Save и своё success/error-состояние, чтобы
 * менеджер не путался, что именно он только что сохранил.
 */
export function EquipmentNameForm({
  equipment,
}: {
  equipment: EquipmentDetailDto;
}) {
  const action = updateEquipmentNameAction.bind(null, equipment.id);
  const [state, formAction] = useFormState<UpdateNameState, FormData>(
    action,
    initialUpdateNameState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-field">
        <label htmlFor="equipment-name">Название</label>
        <input
          id="equipment-name"
          name="name"
          type="text"
          maxLength={120}
          defaultValue={equipment.name}
          placeholder="например, Оверлок 03"
          required
          autoComplete="off"
        />
      </div>

      <div className="admin-actions-row">
        <SaveButton label="Сохранить" />
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
      {state.ok && (
        <div role="status" className="admin-muted" style={{ fontSize: '0.88rem' }}>
          Сохранено.
        </div>
      )}
    </form>
  );
}

/**
 * Точечная форма редактирования `displayNumber` оборудования.
 *
 * Пустое поле сохраняется как `null` (сброс номера) — backend
 * Zod-схема делает то же самое, см. `UpdateEquipmentSchema`.
 */
export function EquipmentDisplayNumberForm({
  equipment,
}: {
  equipment: EquipmentDetailDto;
}) {
  const action = updateEquipmentDisplayNumberAction.bind(null, equipment.id);
  const [state, formAction] = useFormState<UpdateDisplayNumberState, FormData>(
    action,
    initialUpdateDisplayNumberState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-field">
        <label htmlFor="displayNumber">Номер</label>
        <input
          id="displayNumber"
          name="displayNumber"
          type="text"
          maxLength={16}
          defaultValue={equipment.displayNumber ?? ''}
          placeholder="например, 1"
          autoComplete="off"
        />
      </div>

      <div className="admin-actions-row">
        <SaveButton label="Сохранить" />
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
      {state.ok && (
        <div role="status" className="admin-muted" style={{ fontSize: '0.88rem' }}>
          Сохранено.
        </div>
      )}
    </form>
  );
}

/**
 * Точечная форма роли «рабочего места» (`Equipment.role`, фича «смена
 * роли сканом»). Пустое значение = снять привязку (`null`). Если роль
 * задана, сотрудник, отсканировав QR этого оборудования в кабинете,
 * переключается на терминал указанной роли.
 */
export function EquipmentRoleForm({
  equipment,
}: {
  equipment: EquipmentDetailDto;
}) {
  const action = updateEquipmentRoleAction.bind(null, equipment.id);
  const [state, formAction] = useFormState<UpdateRoleState, FormData>(
    action,
    initialUpdateRoleState,
  );

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-field">
        <label htmlFor="equipment-role">Роль участка</label>
        <select
          id="equipment-role"
          name="role"
          defaultValue={equipment.role ?? ''}
        >
          <option value="">— без роли —</option>
          {WORKPLACE_ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {formatRole(r)}
            </option>
          ))}
        </select>
        <span className="admin-field__hint admin-muted">
          Сканируя QR этого рабочего места, сотрудник переключается на
          терминал выбранной роли (если она входит в его роли доступа).
          «— без роли —» — рабочее место не участвует в переключении.
        </span>
      </div>

      <div className="admin-actions-row">
        <SaveButton label="Сохранить" />
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
      {state.ok && (
        <div role="status" className="admin-muted" style={{ fontSize: '0.88rem' }}>
          Сохранено.
        </div>
      )}
    </form>
  );
}

/**
 * Компактный chip-list разрешённых операций для оборудования
 * (Admin UI 2.6).
 *
 * Источник истины — backend (`PATCH /api/equipment/:id/operations`).
 * Каждая выбранная операция — chip с иконкой категории и крестиком.
 * Добавление новой — compact `<select>` + `<button>`. Никаких code,
 * никаких длинных описаний.
 */
export function EquipmentOperationsEditor({ equipment, operations }: Props) {
  const action = updateEquipmentOperationsAction.bind(null, equipment.id);
  const [state, formAction] = useFormState<UpdateOperationsState, FormData>(
    action,
    initialUpdateOperationsState,
  );

  const initiallyChecked = useMemo(
    () =>
      new Set(equipment.allowedOperations.map((l) => l.operationId)),
    [equipment.allowedOperations],
  );

  // Локальный state вместо чистого useMemo: операция может быть создана
  // «на лету» из селекта (creatable) — merge с дедупом по id.
  const [extraOps, setExtraOps] = useState<OperationLiteDto[]>([]);
  const sortedOperations = useMemo(
    () =>
      [
        ...operations,
        ...extraOps.filter((x) => !operations.some((o) => o.id === x.id)),
      ].sort((a, b) => a.sortOrder - b.sortOrder),
    [operations, extraOps],
  );

  const initialOrder = useMemo(() => {
    const present = new Set<string>();
    const ordered: string[] = [];
    for (const op of sortedOperations) {
      if (initiallyChecked.has(op.id)) {
        ordered.push(op.id);
        present.add(op.id);
      }
    }
    for (const id of initiallyChecked) {
      if (!present.has(id)) ordered.push(id);
    }
    return ordered;
  }, [sortedOperations, initiallyChecked]);

  const [selectedIds, setSelectedIds] = useState<string[]>(initialOrder);
  const [pendingId, setPendingId] = useState<string>('');

  const operationsById = useMemo(() => {
    const m = new Map<string, OperationLiteDto>();
    for (const op of sortedOperations) m.set(op.id, op);
    return m;
  }, [sortedOperations]);

  const availableOptions = sortedOperations.filter(
    (op) => !selectedIds.includes(op.id),
  );

  function addOperation() {
    if (!pendingId) return;
    if (selectedIds.includes(pendingId)) return;
    setSelectedIds((prev) => [...prev, pendingId]);
    setPendingId('');
  }

  function removeOperation(id: string) {
    setSelectedIds((prev) => prev.filter((x) => x !== id));
  }

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-field__hint" style={{ display: 'flex', gap: 8 }}>
        <span>
          Включено: <strong>{selectedIds.length}</strong> из{' '}
          {sortedOperations.length}
        </span>
        {selectedIds.length === 0 && (
          <span style={{ color: 'var(--admin-warn-fg, #92400e)' }}>
            <AlertTriangle size={14} strokeWidth={1.6} aria-hidden /> Без
            операций швея не сможет начать смену.
          </span>
        )}
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
      {state.ok && (
        <div role="status" className="admin-muted" style={{ fontSize: '0.88rem' }}>
          Сохранено.
        </div>
      )}

      <ul className="admin-chip-list" aria-label="Разрешённые операции">
        {selectedIds.length === 0 && (
          <li className="admin-muted" style={{ fontSize: '0.88rem' }}>
            Пока ничего не выбрано.
          </li>
        )}
        {selectedIds.map((id) => {
          const op = operationsById.get(id);
          if (!op) return null;
          const Icon = categoryIcon(op.category);
          return (
            <li key={id} className="admin-chip">
              <span className="admin-chip__icon" aria-hidden>
                <Icon size={13} strokeWidth={1.7} />
              </span>
              <span className="admin-chip__label">{op.name}</span>
              <button
                type="button"
                className="admin-chip__remove"
                onClick={() => removeOperation(id)}
                aria-label={`Убрать ${op.name}`}
              >
                <X size={12} strokeWidth={1.8} aria-hidden />
              </button>
              <input type="hidden" name="operationIds" value={id} />
              <input type="hidden" name="operationOrder" value={id} />
            </li>
          );
        })}
      </ul>

      <div className="admin-actions-row" style={{ justifyContent: 'flex-start' }}>
        <GroupedOperationSelect
          operations={availableOptions}
          name="pendingOperationId"
          value={pendingId}
          onChange={setPendingId}
          placeholder="— выбрать операцию —"
          ariaLabel="Добавить операцию"
          className="admin-chip-add__select"
          creatable
          onCreatedOperation={(created) =>
            setExtraOps((prev) => [
              ...prev.filter((o) => o.id !== created.id),
              {
                id: created.id,
                code: created.code,
                name: created.name,
                category: created.category,
                sortOrder: created.sortOrder,
                active: created.isActive,
                pricingMode: created.pricingMode,
              },
            ])
          }
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

      <div className="admin-actions-row">
        <SaveButton label="Сохранить набор" />
      </div>
    </form>
  );
}
