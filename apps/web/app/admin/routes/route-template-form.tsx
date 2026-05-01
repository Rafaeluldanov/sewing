'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useMemo, useState } from 'react';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import type { RouteTemplateDetailDto } from '@sewing/shared/routes';
import { Icon } from '@/components/icon';
import {
  createRouteTemplateAction,
  updateRouteTemplateAction,
} from './actions';
import {
  initialCreateRouteTemplateState,
  initialUpdateRouteTemplateState,
  type CreateRouteTemplateState,
  type UpdateRouteTemplateState,
} from './form-state';

type Mode = 'create' | 'edit';

interface Props {
  mode: Mode;
  operations: readonly OperationLiteDto[];
  /** Только в режиме `edit` — текущее состояние шаблона. */
  template?: RouteTemplateDetailDto;
}

interface SelectedStep {
  operationId: string;
  isOptional: boolean;
}

function SubmitButton({ mode }: { mode: Mode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name={mode === 'create' ? 'plus' : 'success'} size={16} />
      {pending
        ? 'Сохраняем…'
        : mode === 'create'
        ? 'Создать шаблон'
        : 'Сохранить изменения'}
    </button>
  );
}

/**
 * Универсальная форма шаблона маршрута: используется и для создания
 * (`/admin/routes/new`), и для редактирования (`/admin/routes/[id]`).
 *
 * UI MVP:
 *   - чек-лист всех активных операций;
 *   - порядок отмеченных операций — отдельная управляемая
 *     последовательность (вверх/вниз) с подписью «Шаг N»;
 *   - чекбокс «опционально» для каждого выбранного шага (UI-only
 *     hint на MVP, backend хранит флаг, но не использует в enforcement).
 *
 * При submit действие парсит из FormData отмеченные `operationIds` и
 * скрытые `stepOrder[<id>]` — итоговый порядок шагов на бэкенде
 * нормализуется по `index = i` (см. `RoutesService.replaceSteps`).
 */
export function RouteTemplateForm({ mode, operations, template }: Props) {
  const initialSelected: SelectedStep[] = useMemo(() => {
    if (mode !== 'edit' || !template) return [];
    return template.steps
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((s) => ({ operationId: s.operationId, isOptional: s.isOptional }));
  }, [mode, template]);

  const [selected, setSelected] = useState<SelectedStep[]>(initialSelected);

  const [createState, createAction] = useFormState<
    CreateRouteTemplateState,
    FormData
  >(createRouteTemplateAction, initialCreateRouteTemplateState);
  const [updateState, updateAction] = useFormState<
    UpdateRouteTemplateState,
    FormData
  >(updateRouteTemplateAction, initialUpdateRouteTemplateState);

  const formAction = mode === 'create' ? createAction : updateAction;
  const state = mode === 'create' ? createState : updateState;

  const operationsById = useMemo(() => {
    const m = new Map<string, OperationLiteDto>();
    for (const op of operations) m.set(op.id, op);
    return m;
  }, [operations]);

  const selectedIds = useMemo(
    () => new Set(selected.map((s) => s.operationId)),
    [selected],
  );

  const sortedOperations = useMemo(
    () => [...operations].sort((a, b) => a.sortOrder - b.sortOrder),
    [operations],
  );

  const toggle = (operationId: string) => {
    setSelected((prev) => {
      const exists = prev.some((s) => s.operationId === operationId);
      if (exists) return prev.filter((s) => s.operationId !== operationId);
      return [...prev, { operationId, isOptional: false }];
    });
  };

  const move = (operationId: string, direction: -1 | 1) => {
    setSelected((prev) => {
      const idx = prev.findIndex((s) => s.operationId === operationId);
      if (idx < 0) return prev;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = prev.slice();
      const [item] = next.splice(idx, 1);
      next.splice(newIdx, 0, item);
      return next;
    });
  };

  const setOptional = (operationId: string, value: boolean) => {
    setSelected((prev) =>
      prev.map((s) =>
        s.operationId === operationId ? { ...s, isOptional: value } : s,
      ),
    );
  };

  return (
    <form action={formAction} className="admin-equipment-form">
      {mode === 'edit' && template && (
        <input type="hidden" name="id" value={template.id} />
      )}

      <div className="admin-equipment-form__meta" style={{ flexWrap: 'wrap' }}>
        <label htmlFor="rt-code" className="meta-line">
          Код шаблона
        </label>
        <input
          id="rt-code"
          name="code"
          type="text"
          maxLength={48}
          required
          autoComplete="off"
          defaultValue={template?.code ?? ''}
          placeholder="например, TSHIRT-BASIC"
          pattern="[A-Z0-9][A-Z0-9_-]*"
          title="Латинские заглавные буквы, цифры, '-' и '_'"
          style={{ padding: '6px 10px', minWidth: 220 }}
        />
        <label htmlFor="rt-name" className="meta-line">
          Название
        </label>
        <input
          id="rt-name"
          name="name"
          type="text"
          maxLength={120}
          required
          autoComplete="off"
          defaultValue={template?.name ?? ''}
          placeholder="например, Базовая футболка"
          style={{ padding: '6px 10px', minWidth: 280 }}
        />
        <label
          className="meta-line"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <input
            type="checkbox"
            name="isActive"
            value="on"
            defaultChecked={template?.isActive ?? true}
          />
          Активен
        </label>
      </div>

      <div>
        <div
          className="meta-line"
          style={{ marginBottom: 8, display: 'flex', gap: '0.75rem' }}
        >
          <span>
            <strong>Шаги маршрута</strong> — отметьте операции и расставьте
            порядок. Эти шаги фиксируются snapshot-ом на заказе при запуске.
          </span>
          <span>
            Выбрано: <strong>{selected.length}</strong> из{' '}
            {sortedOperations.length}
          </span>
        </div>

        {selected.length > 0 && (
          <ol className="option-list" style={{ marginBottom: '0.75rem' }}>
            {selected.map((step, i) => {
              const op = operationsById.get(step.operationId);
              if (!op) return null;
              return (
                <li
                  key={step.operationId}
                  className="option-list__row is-active"
                  style={{ gap: '0.5rem' }}
                >
                  <span
                    className="meta-line"
                    style={{ minWidth: 64, fontWeight: 600 }}
                  >
                    Шаг {i + 1}
                  </span>
                  <span style={{ flex: 1 }}>
                    <span className="option-list__row-name">{op.name}</span>
                    <span className="option-list__row-meta">
                      <code>{op.code}</code> · {op.category.toLowerCase()}
                    </span>
                  </span>
                  <label
                    className="meta-line"
                    style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                    title="UI-подсказка: шаг помечен как опциональный"
                  >
                    <input
                      type="checkbox"
                      name={`stepOptional[${step.operationId}]`}
                      checked={step.isOptional}
                      onChange={(e) =>
                        setOptional(step.operationId, e.target.checked)
                      }
                    />
                    опц.
                  </label>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: '2px 8px', minHeight: 0 }}
                    onClick={() => move(step.operationId, -1)}
                    disabled={i === 0}
                    aria-label="Поднять шаг выше"
                    title="Выше"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: '2px 8px', minHeight: 0 }}
                    onClick={() => move(step.operationId, 1)}
                    disabled={i === selected.length - 1}
                    aria-label="Опустить шаг ниже"
                    title="Ниже"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: '2px 8px', minHeight: 0 }}
                    onClick={() => toggle(step.operationId)}
                    aria-label="Удалить шаг"
                    title="Убрать"
                  >
                    ×
                  </button>
                  <input
                    type="hidden"
                    name="operationIds"
                    value={step.operationId}
                  />
                  <input
                    type="hidden"
                    name={`stepOrder[${step.operationId}]`}
                    value={i}
                  />
                </li>
              );
            })}
          </ol>
        )}

        <details>
          <summary className="meta-line" style={{ cursor: 'pointer' }}>
            Добавить операции в маршрут
          </summary>
          <ul className="option-list" style={{ marginTop: '0.5rem' }}>
            {sortedOperations
              .filter((op) => !selectedIds.has(op.id))
              .map((op) => (
                <li key={op.id} className="option-list__row">
                  <label>
                    <input
                      type="checkbox"
                      checked={false}
                      onChange={() => toggle(op.id)}
                    />
                    <span className="option-list__row-name">{op.name}</span>
                    <span className="option-list__row-meta">
                      <code>{op.code}</code> · {op.category.toLowerCase()}
                    </span>
                  </label>
                </li>
              ))}
            {sortedOperations.filter((op) => !selectedIds.has(op.id))
              .length === 0 && (
              <li className="option-list__row meta-line">
                Все операции уже добавлены в маршрут.
              </li>
            )}
          </ul>
        </details>
      </div>

      <div className="detail-form__actions">
        <SubmitButton mode={mode} />
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
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          {state.successMessage}
        </div>
      )}
    </form>
  );
}
