'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Save, XCircle } from 'lucide-react';
import {
  PATTERN_ITEM_STATUSES,
  PATTERN_ITEM_STATUS_LABELS,
  type PatternDetailDto,
  type PatternItemStatus,
} from '@sewing/shared/patterns';
import type { PatternCategoryListItemDto } from '@sewing/shared/pattern-categories';
import { updatePatternAction } from '../actions';
import {
  initialUpdatePatternState,
  type UpdatePatternState,
} from '../form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

interface Props {
  pattern: PatternDetailDto;
  /** Активные категории справочника (для select). */
  categories: PatternCategoryListItemDto[];
}

/**
 * Форма редактирования основных полей карточки лекала.
 * Превью и DXF-файлы редактируются отдельными формами на той же
 * странице — каждый upload-эндпоинт самостоятельный.
 *
 * Этап «Категории номенклатуры»: select «Категория» — основной
 * способ задать категорию. Legacy `categoryCode` показывается только
 * если он непустой и помогает менеджеру увидеть «старая категория».
 */
export function EditPatternForm({ pattern, categories }: Props) {
  const [state, formAction] = useFormState<UpdatePatternState, FormData>(
    updatePatternAction.bind(null, pattern.id),
    initialUpdatePatternState,
  );
  const status = (PATTERN_ITEM_STATUSES as readonly string[]).includes(
    pattern.status,
  )
    ? (pattern.status as PatternItemStatus)
    : ('ACTIVE' as PatternItemStatus);

  // Если у лекала уже есть categoryId, но эта категория архивирована
  // (нет в active списке), всё равно подложим её в select — иначе
  // менеджер увидит «не выбрано» и при submit потеряет привязку.
  const currentCategoryArchived =
    pattern.categoryId && !categories.some((c) => c.id === pattern.categoryId)
      ? pattern.category
      : null;

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
            defaultValue={pattern.name}
            maxLength={200}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="pattern-article">Артикул</label>
          <input
            id="pattern-article"
            name="article"
            type="text"
            required
            defaultValue={pattern.article}
            maxLength={64}
          />
        </div>
        <div className="admin-field">
          <label htmlFor="pattern-categoryId">Категория</label>
          <select
            id="pattern-categoryId"
            name="categoryId"
            defaultValue={pattern.categoryId ?? ''}
          >
            <option value="">— не выбрана —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {currentCategoryArchived && (
              <option value={currentCategoryArchived.id}>
                {currentCategoryArchived.name} (архив)
              </option>
            )}
          </select>
          {pattern.categoryId === null && pattern.categoryCode && (
            <small className="admin-muted">
              Старая категория: <strong>{pattern.categoryCode}</strong>.
              Выберите актуальную категорию из справочника, чтобы UI
              «Площади материалов» использовал её параметры.
            </small>
          )}
          {categories.length === 0 && pattern.categoryId === null && (
            <small className="admin-muted">
              Нет активных категорий. Создайте категорию на странице
              «Номенклатура».
            </small>
          )}
        </div>
        <div className="admin-field">
          <label htmlFor="pattern-status">Статус</label>
          <select id="pattern-status" name="status" defaultValue={status}>
            {PATTERN_ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {PATTERN_ITEM_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {/* Legacy categoryCode: hidden input, чтобы при сохранении не
          обнулять историческое поле. UI его не редактирует — показ
          только в hint выше. */}
      <input
        type="hidden"
        name="categoryCode"
        value={pattern.categoryCode ?? ''}
      />
      <div className="admin-field">
        <label htmlFor="pattern-description">Описание</label>
        <textarea
          id="pattern-description"
          name="description"
          defaultValue={pattern.description ?? ''}
          maxLength={4000}
          rows={3}
        />
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
        <SubmitButton />
      </div>
    </form>
  );
}
