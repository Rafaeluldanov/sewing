'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Plus, Save, X } from 'lucide-react';
import type { OperationLiteDto } from '@sewing/shared/shifts';
import { groupOperationsByCategory } from '@sewing/shared/operations';
import type { RouteTemplateDetailDto } from '@sewing/shared/routes';
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
import { CODE_PATTERN, CODE_PATTERN_TITLE } from '@/lib/code-pattern';

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
  /** «↕ параллельно с предыдущим шагом» — взаимозаменяемы по порядку. */
  parallelWithPrev: boolean;
  /**
   * Переопределённая сдельная расценка операции для этого изделия
   * (₽/шт) или `null` — расценка по дефолту операции. Значимо только
   * для `pricingMode = FIXED`.
   */
  rateOverride: number | null;
}

function SubmitButton({ mode }: { mode: Mode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      {mode === 'create' ? (
        <Plus size={16} strokeWidth={1.6} aria-hidden />
      ) : (
        <Save size={16} strokeWidth={1.6} aria-hidden />
      )}
      {pending
        ? 'Сохраняем…'
        : mode === 'create'
          ? 'Создать'
          : 'Сохранить'}
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
    const ordered = template.steps.slice().sort((a, b) => a.index - b.index);
    return ordered.map((s, i) => ({
      operationId: s.operationId,
      isOptional: s.isOptional,
      // Тумблер «↕ параллельно с предыдущим» выводим из общей
      // параллельной группы с шагом выше.
      parallelWithPrev:
        i > 0 &&
        s.parallelGroup != null &&
        s.parallelGroup === ordered[i - 1].parallelGroup,
      rateOverride: s.rateOverride,
    }));
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

  // Пул «добавить операции в маршрут» группируем по категории, чтобы
  // менеджеру было проще ориентироваться: «вот раздел Раскрой, вот
  // Пошив, вот ОТК…». Порядок групп — каноничный (см. ТЗ §3, §4).
  const availableGroups = useMemo(() => {
    const pool = sortedOperations.filter((op) => !selectedIds.has(op.id));
    return groupOperationsByCategory(pool);
  }, [sortedOperations, selectedIds]);

  const toggle = (operationId: string) => {
    setSelected((prev) => {
      const exists = prev.some((s) => s.operationId === operationId);
      if (exists) return prev.filter((s) => s.operationId !== operationId);
      return [
        ...prev,
        {
          operationId,
          isOptional: false,
          parallelWithPrev: false,
          rateOverride: null,
        },
      ];
    });
  };

  const setRate = (operationId: string, value: number | null) => {
    setSelected((prev) =>
      prev.map((s) =>
        s.operationId === operationId ? { ...s, rateOverride: value } : s,
      ),
    );
  };

  const setParallel = (operationId: string, value: boolean) => {
    setSelected((prev) =>
      prev.map((s) =>
        s.operationId === operationId ? { ...s, parallelWithPrev: value } : s,
      ),
    );
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
    <form action={formAction} className="admin-form">
      {mode === 'edit' && template && (
        <input type="hidden" name="id" value={template.id} />
      )}

      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="rt-code">Код</label>
          <input
            id="rt-code"
            name="code"
            type="text"
            maxLength={48}
            required
            autoComplete="off"
            defaultValue={template?.code ?? ''}
            placeholder="TSHIRT-BASIC"
            pattern={CODE_PATTERN}
            title={CODE_PATTERN_TITLE}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="rt-name">Название</label>
          <input
            id="rt-name"
            name="name"
            type="text"
            maxLength={120}
            required
            autoComplete="off"
            defaultValue={template?.name ?? ''}
            placeholder="Базовая футболка"
          />
        </div>
        <div className="admin-field admin-field--inline">
          <input
            id="rt-active"
            type="checkbox"
            name="isActive"
            value="on"
            defaultChecked={template?.isActive ?? true}
          />
          <label htmlFor="rt-active">Активен</label>
        </div>
      </div>

      <div className="admin-field">
        <label>
          Шаги маршрута
          <span className="admin-field__hint" style={{ marginLeft: 8 }}>
            Выбрано {selected.length} из {sortedOperations.length}
          </span>
        </label>

        {selected.length > 0 && (
          <ol className="admin-step-edit">
            {selected.map((step, i) => {
              const op = operationsById.get(step.operationId);
              if (!op) return null;
              const parallel = i > 0 && step.parallelWithPrev;
              return (
                <li
                  key={step.operationId}
                  className={`admin-step-edit__row${parallel ? ' admin-step-edit__row--parallel' : ''}`}
                >
                  <span className="admin-step-edit__num">{i + 1}</span>
                  <span className="admin-step-edit__name">
                    {op.name}
                    {parallel && (
                      <span
                        className="admin-step-edit__parallel-tag"
                        title="Параллельно с шагом выше: порядок любой, обе операции — один этап"
                      >
                        <ArrowUpDown size={12} strokeWidth={1.8} aria-hidden />{' '}
                        параллельно
                      </span>
                    )}
                  </span>
                  <label
                    className="admin-step-edit__opt"
                    title="Шаг помечен как опциональный"
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
                  {op.pricingMode === 'FIXED' && (
                    <label
                      className="admin-step-edit__rate"
                      title="Сдельная расценка этой операции для данного изделия. Пусто — берётся цена операции по умолчанию."
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: '0.82rem',
                      }}
                    >
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.01"
                        name={`stepRate[${step.operationId}]`}
                        value={step.rateOverride ?? ''}
                        placeholder={
                          op.fixedRate != null ? String(op.fixedRate) : '—'
                        }
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          setRate(
                            step.operationId,
                            raw === '' ? null : Number(raw),
                          );
                        }}
                        style={{ width: 80 }}
                        aria-label="Расценка операции для изделия, ₽/шт"
                      />
                      ₽/шт
                    </label>
                  )}
                  <button
                    type="button"
                    className={`admin-btn admin-btn--ghost admin-btn--icon${parallel ? ' admin-btn--active' : ''}`}
                    onClick={() =>
                      setParallel(step.operationId, !step.parallelWithPrev)
                    }
                    disabled={i === 0}
                    aria-pressed={parallel}
                    title="↕ Параллельно с предыдущим шагом (взаимозаменяемы по порядку)"
                    aria-label="Параллельно с предыдущим шагом"
                  >
                    <ArrowUpDown size={14} strokeWidth={1.6} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost admin-btn--icon"
                    onClick={() => move(step.operationId, -1)}
                    disabled={i === 0}
                    aria-label="Поднять шаг выше"
                  >
                    <ArrowUp size={14} strokeWidth={1.6} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost admin-btn--icon"
                    onClick={() => move(step.operationId, 1)}
                    disabled={i === selected.length - 1}
                    aria-label="Опустить шаг ниже"
                  >
                    <ArrowDown size={14} strokeWidth={1.6} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost admin-btn--icon"
                    onClick={() => toggle(step.operationId)}
                    aria-label="Удалить шаг"
                  >
                    <X size={14} strokeWidth={1.6} aria-hidden />
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
                  {parallel && (
                    <input
                      type="hidden"
                      name={`stepParallel[${step.operationId}]`}
                      value="on"
                    />
                  )}
                </li>
              );
            })}
          </ol>
        )}

        <details className="admin-step-edit__add">
          <summary>Добавить операции</summary>
          {availableGroups.length === 0 ? (
            <ul className="admin-step-edit__pool">
              <li className="admin-muted" style={{ fontSize: '0.88rem' }}>
                Все операции уже добавлены в маршрут.
              </li>
            </ul>
          ) : (
            availableGroups.map((group) => (
              <section
                key={group.category}
                className="admin-step-edit__pool-group"
                data-category={group.category}
                style={{ marginTop: '0.5rem' }}
              >
                <header
                  className="admin-step-edit__pool-group-header"
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                    color: 'var(--admin-muted-fg, #6b7280)',
                    margin: '0.4rem 0 0.2rem',
                  }}
                >
                  <span>{group.label}</span>
                  <span style={{ fontWeight: 400 }}>
                    {group.operations.length}
                  </span>
                </header>
                <ul className="admin-step-edit__pool">
                  {group.operations.map((op) => (
                    <li key={op.id}>
                      <label className="admin-step-edit__pool-row">
                        <input
                          type="checkbox"
                          checked={false}
                          onChange={() => toggle(op.id)}
                        />
                        <span>{op.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </details>
      </div>

      <div className="admin-actions-row">
        <SubmitButton mode={mode} />
      </div>

      {state.error && (
        <div
          role="alert"
          style={{ color: 'var(--admin-danger-fg)', fontSize: '0.88rem' }}
        >
          {state.error}
          {state.errorRequestId && (
            <span className="admin-muted" style={{ marginLeft: 6 }}>
              req: <code>{state.errorRequestId}</code>
            </span>
          )}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div role="status" className="admin-muted" style={{ fontSize: '0.88rem' }}>
          {state.successMessage}
        </div>
      )}
    </form>
  );
}
