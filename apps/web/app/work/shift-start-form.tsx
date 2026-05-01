'use client';

import { useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import type {
  EmployeeLiteDto,
  ShiftMetaDto,
} from '@sewing/shared/shifts';
import { groupOperationsByCategory } from '@sewing/shared/operations';
import { startShiftAction } from './actions';
import { initialWorkFormState } from './state';

interface Props {
  meta: ShiftMetaDto;
  employee: EmployeeLiteDto;
}

function StartButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary btn-lg btn-block"
      disabled={pending}
    >
      {pending ? 'Старт смены…' : 'Начать смену'}
    </button>
  );
}

export function ShiftStartForm({ meta, employee }: Props) {
  const [state, action] = useFormState(startShiftAction, initialWorkFormState);

  const sortedOps = useMemo(
    () =>
      [...meta.operations].sort((a, b) => a.sortOrder - b.sortOrder),
    [meta.operations],
  );
  const operationGroups = useMemo(
    () => groupOperationsByCategory(sortedOps),
    [sortedOps],
  );
  const sortedEq = useMemo(
    () => [...meta.equipment].sort((a, b) => a.code.localeCompare(b.code)),
    [meta.equipment],
  );

  const [operationId, setOperationId] = useState<string>(
    sortedOps.find((o) => o.category === 'SEWING')?.id ?? sortedOps[0]?.id ?? '',
  );
  const [equipmentId, setEquipmentId] = useState<string>(
    sortedEq[0]?.id ?? '',
  );

  return (
    <form action={action} className="scan-card" aria-label="Начать смену">
      <div>
        <h2 className="scan-card__title">Начать смену</h2>
        <p className="scan-card__hint">
          Выберите оборудование и операцию — после старта смены откроются
          сценарии «Получить крой» и «Сканировать паспорт».
        </p>
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <div className="error-box__msg">{state.error}</div>
          {state.errorRequestId && (
            <div className="error-box__rid">
              req: <code>{state.errorRequestId}</code>
            </div>
          )}
        </div>
      )}

      <label className="scan-card__input" htmlFor="equipmentId">
        <span className="scan-card__input-label">Оборудование</span>
        <select
          id="equipmentId"
          name="equipmentId"
          value={equipmentId}
          onChange={(e) => setEquipmentId(e.target.value)}
        >
          <option value="">— выбрать —</option>
          {sortedEq.map((q) => (
            <option key={q.id} value={q.id}>
              {q.code} · {q.name}
            </option>
          ))}
        </select>
      </label>

      <label className="scan-card__input" htmlFor="operationId">
        <span className="scan-card__input-label">Операция</span>
        <select
          id="operationId"
          name="operationId"
          value={operationId}
          onChange={(e) => setOperationId(e.target.value)}
        >
          <option value="">— выбрать —</option>
          {operationGroups.map((group) => (
            <optgroup
              key={group.category}
              label={group.label}
              data-category={group.category}
            >
              {group.operations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {o.code}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <StartButton />
      <p className="scan-card__hint" style={{ marginBottom: 0 }}>
        Сотрудник: <strong style={{ color: 'var(--color-fg)' }}>{employee.fullName}</strong>
      </p>
    </form>
  );
}
