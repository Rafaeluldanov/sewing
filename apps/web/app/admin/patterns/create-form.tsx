'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Plus, XCircle } from 'lucide-react';
import {
  PATTERN_ITEM_STATUSES,
  PATTERN_ITEM_STATUS_LABELS,
  type PatternItemStatus,
} from '@sewing/shared/patterns';
import type { PatternCategoryListItemDto } from '@sewing/shared/pattern-categories';
import { createPatternAction } from './actions';
import {
  initialCreatePatternState,
  type CreatePatternState,
} from './form-state';

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

interface Props {
  /**
   * Активные категории (этап «Категории номенклатуры»). Если пусто
   * — рисуем подсказку «Создайте категорию на странице Номенклатура».
   */
  categories: PatternCategoryListItemDto[];
}

/**
 * Форма создания лекала (`/admin/patterns/new`).
 *
 * Минимально достаточный набор полей: название, артикул, категория
 * (этап «Категории номенклатуры» — FK), описание, статус. После
 * успеха server action редиректит на карточку нового лекала.
 *
 * Legacy `categoryCode` поле скрыто из основного UI: новые карточки
 * привязываются к типизированной категории (`categoryId`); сама
 * колонка `categoryCode` сохранена в БД ради обратной совместимости
 * (см. ТЗ §«Не делать»: `categoryCode` не удалять).
 */
export function CreatePatternForm({ categories }: Props) {
  const [state, formAction] = useFormState<CreatePatternState, FormData>(
    createPatternAction,
    initialCreatePatternState,
  );

  const noCategories = categories.length === 0;

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="pattern-name">Название</label>
          <input
            id="pattern-name"
            name="name"
            type="text"
            required
            maxLength={200}
            placeholder="Например: Футболка-классика"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="pattern-article">Артикул</label>
          <input
            id="pattern-article"
            name="article"
            type="text"
            required
            maxLength={64}
            placeholder="Например: TS-CLASSIC-001"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="pattern-categoryId">Категория</label>
          <select
            id="pattern-categoryId"
            name="categoryId"
            defaultValue=""
            disabled={noCategories}
          >
            <option value="">— не выбрана —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {noCategories && (
            <small className="admin-muted">
              Нет активных категорий. Создайте категорию на странице
              «Номенклатура» — кнопка «Добавить категорию».
            </small>
          )}
        </div>
        <div className="admin-field">
          <label htmlFor="pattern-status">Статус</label>
          <select
            id="pattern-status"
            name="status"
            defaultValue={'ACTIVE' satisfies PatternItemStatus}
          >
            {PATTERN_ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {PATTERN_ITEM_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="admin-field">
        <label htmlFor="pattern-description">Описание</label>
        <textarea
          id="pattern-description"
          name="description"
          maxLength={4000}
          rows={3}
          placeholder="Свободное описание конструкции"
        />
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}

      <div className="admin-actions-row">
        <SubmitButton />
      </div>
    </form>
  );
}
