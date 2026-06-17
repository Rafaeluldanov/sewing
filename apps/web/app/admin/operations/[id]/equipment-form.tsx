'use client';

import { useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import type { OperationDetailDto } from '@sewing/shared/operations';
import type { EquipmentSummaryDto } from '@sewing/shared/equipment';
import { CheckCircle2, Save, XCircle } from 'lucide-react';
import { updateOperationEquipmentAction } from '../actions';
import {
  initialUpdateOperationState,
  type UpdateOperationState,
} from '../form-state';

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="admin-btn admin-btn--primary" disabled={pending}>
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить оборудование'}
    </button>
  );
}

interface Props {
  operation: OperationDetailDto;
  equipment: readonly EquipmentSummaryDto[];
}

/**
 * Блок «Оборудование» на карточке операции (`/admin/operations/[id]`).
 *
 * Закрывает кейс «завели новый станок → надо разрешить на нём операцию,
 * иначе её нельзя выбрать в `/work`»: менеджер отмечает станки галочками
 * прямо в карточке операции, без похода в `/admin/equipment/[id]` и без
 * пересоздания операции. Это вторая ручка к таблице `EquipmentOperation`
 * — та же связь редактируется и со стороны оборудования.
 *
 * Отдельная форма со своим Save (не смешивается с правкой тарифа/нормы
 * в `OperationEditForm`) — по тому же принципу, что три раздельные формы
 * в карточке оборудования. Сохранение шлёт полный набор отмеченных id в
 * `PATCH /api/operations/:id/equipment` (replace-all по операции).
 *
 * В списке показываем активные станки плюс уже привязанные (даже если
 * станок деактивирован) — чтобы привязку к выключенному станку можно
 * было снять, а не «потерять» её из виду.
 */
export function OperationEquipmentForm({ operation, equipment }: Props) {
  const boundIds = useMemo(
    () => new Set(operation.equipment.map((e) => e.equipmentId)),
    [operation.equipment],
  );

  // Активные станки + уже привязанные (вкл. деактивированные). Карта,
  // чтобы не задвоить станок, который и активен, и привязан.
  const rows = useMemo(() => {
    const byId = new Map<
      string,
      { id: string; name: string; displayNumber: string | null; active: boolean }
    >();
    for (const eq of equipment) {
      if (eq.active || boundIds.has(eq.id)) {
        byId.set(eq.id, {
          id: eq.id,
          name: eq.name,
          displayNumber: eq.displayNumber,
          active: eq.active,
        });
      }
    }
    // Привязанные станки, которых нет в списке summary (edge-case) —
    // добираем из самой операции, чтобы галочку можно было снять.
    for (const link of operation.equipment) {
      if (!byId.has(link.equipmentId)) {
        byId.set(link.equipmentId, {
          id: link.equipmentId,
          name: link.name,
          displayNumber: link.displayNumber,
          active: link.isActive,
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) =>
      a.name.localeCompare(b.name, 'ru'),
    );
  }, [equipment, boundIds, operation.equipment]);

  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const id of boundIds) init[id] = true;
    return init;
  });
  const checkedCount = useMemo(
    () => Object.values(checked).filter(Boolean).length,
    [checked],
  );

  const action = updateOperationEquipmentAction.bind(null, operation.id);
  const [state, formAction] = useFormState<UpdateOperationState, FormData>(
    action,
    initialUpdateOperationState,
  );

  if (rows.length === 0) {
    return (
      <p className="admin-muted" style={{ margin: 0, fontSize: '0.9rem' }}>
        В справочнике нет активного оборудования. Заведите станок в разделе
        «Оборудование», затем вернитесь сюда, чтобы разрешить на нём операцию.
      </p>
    );
  }

  return (
    <form action={formAction} className="admin-form">
      <p className="admin-muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
        Отметьте станки, на которых разрешена эта операция. Без привязки
        операцию нельзя выбрать в смене (<code>/work</code>). Те же привязки
        можно вести и со стороны оборудования.
        {checkedCount > 0 && (
          <>
            {' '}
            Выбрано: <strong>{checkedCount}</strong>.
          </>
        )}
      </p>

      <ul className="admin-chip-list" style={{ marginTop: '0.4rem' }}>
        {rows.map((eq) => {
          const isChecked = !!checked[eq.id];
          return (
            <li key={eq.id}>
              <label
                className="admin-chip"
                style={{
                  cursor: 'pointer',
                  opacity: eq.active ? 1 : 0.6,
                  ...(isChecked
                    ? {
                        background: 'var(--admin-primary-soft)',
                        color: 'var(--admin-primary-fg)',
                        borderColor: 'transparent',
                      }
                    : {}),
                }}
              >
                <input
                  type="checkbox"
                  name="equipmentIds"
                  value={eq.id}
                  checked={isChecked}
                  onChange={(e) =>
                    setChecked((prev) => ({
                      ...prev,
                      [eq.id]: e.target.checked,
                    }))
                  }
                  style={{ margin: 0 }}
                />
                <span>
                  {eq.displayNumber ? `№${eq.displayNumber} · ` : ''}
                  {eq.name}
                  {!eq.active && (
                    <span className="admin-muted" style={{ marginLeft: 6 }}>
                      (неактивен)
                    </span>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="admin-actions-row">
        <SaveButton />
      </div>

      {state.successMessage && (
        <div
          role="status"
          className="admin-muted"
          style={{
            display: 'inline-flex',
            gap: 8,
            alignItems: 'center',
            color: 'var(--admin-success, #166534)',
            fontSize: '0.9rem',
          }}
        >
          <CheckCircle2 size={16} strokeWidth={1.6} aria-hidden />
          <span>{state.successMessage}</span>
        </div>
      )}
      {state.error && (
        <div
          role="alert"
          style={{
            display: 'inline-flex',
            gap: 8,
            alignItems: 'center',
            color: 'var(--admin-danger, #b91c1c)',
            fontSize: '0.9rem',
          }}
        >
          <XCircle size={16} strokeWidth={1.6} aria-hidden />
          <span>
            {state.error}
            {state.errorRequestId && (
              <span className="admin-muted" style={{ marginLeft: 8 }}>
                req: <code>{state.errorRequestId}</code>
              </span>
            )}
          </span>
        </div>
      )}
    </form>
  );
}
