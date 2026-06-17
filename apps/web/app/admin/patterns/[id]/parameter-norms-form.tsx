'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Save, XCircle } from 'lucide-react';
import type {
  PatternItemParameterNormDto,
} from '@sewing/shared/patterns';
import type { PatternCategoryParameterDto } from '@sewing/shared/pattern-categories';
import { replacePatternItemParameterNormsAction } from '../actions';
import {
  initialParameterNormsState,
  type ParameterNormsState,
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
      {pending ? 'Сохраняем…' : 'Сохранить нормы'}
    </button>
  );
}

interface Props {
  patternId: string;
  /**
   * Активные параметры категории с `inputType = QTY_PER_ITEM`
   * (`status = ACTIVE`). Каждый параметр = одна строка формы:
   * Люверсы, Шнур, Наконечники и т.д. Параметры приходят
   * предварительно отфильтрованными — компонент дополнительно
   * фильтрует defence-in-depth.
   */
  parameters: readonly PatternCategoryParameterDto[];
  /**
   * Текущие сохранённые нормы. Маппятся по `categoryParameterId`,
   * чтобы для каждой строки рендерить defaultValue из существующей
   * нормы. Параметры без сохранённой нормы рендерят пустые input-ы.
   */
  norms: readonly PatternItemParameterNormDto[];
}

/**
 * Форма «Фурнитура и нормы» (см. ТЗ §5/§6, этап «Фурнитура и нормы»).
 *
 * Строки = активные QTY_PER_ITEM-параметры категории лекала;
 * `roleKey` пользователю НЕ показывается — UI говорит на языке
 * `label` («Люверсы», «Шнур», «Наконечники»). Несколько параметров
 * с одинаковым `roleKey = PACKAGING` отображаются как разные
 * строки — это и есть требование ТЗ §«QTY_PER_ITEM параметры могут
 * иметь одинаковый roleKey, поэтому хранить нормы нужно по
 * categoryParameterId».
 *
 * `unit` рисуем read-only (берём из `parameter.unit` — обычно «шт»);
 * пользователь не редактирует единицу — она часть параметра
 * категории. Backend всё равно подставит `parameter.unit` как
 * default.
 *
 * Семантика сохранения (full-replace):
 *   - заполненная строка → норма создаётся / обновляется;
 *   - пустая строка → норма стирается (если была).
 */
export function PatternItemParameterNormsForm({
  patternId,
  parameters,
  norms,
}: Props) {
  const [state, formAction] = useFormState<ParameterNormsState, FormData>(
    replacePatternItemParameterNormsAction.bind(null, patternId),
    initialParameterNormsState,
  );

  // Defence-in-depth: даже если родитель передал лишние параметры,
  // в форме рендерим только те, что подходят (`QTY_PER_ITEM` +
  // `ACTIVE`). См. ТЗ §«Показывать в нём только параметры категории
  // с inputType = QTY_PER_ITEM».
  const visibleParameters = parameters.filter(
    (p) => p.inputType === 'QTY_PER_ITEM' && p.status === 'ACTIVE',
  );

  // Map parameterId → текущая норма (для defaultValue).
  const normByParamId = new Map<string, PatternItemParameterNormDto>();
  for (const n of norms) {
    normByParamId.set(n.categoryParameterId, n);
  }

  if (visibleParameters.length === 0) {
    return (
      <div className="admin-muted" role="status">
        В категории нет параметров с вводом «Количество на изделие».
        Добавьте такие параметры (нитки, наполнитель, фурнитура,
        маркировка) в категории.
      </div>
    );
  }

  return (
    <form action={formAction} className="admin-form">
      <input
        type="hidden"
        name="__parameterIds"
        value={visibleParameters.map((p) => p.id).join(',')}
      />
      <div style={{ overflowX: 'auto' }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Параметр</th>
              <th style={{ width: 140 }}>Норма на изделие</th>
              <th style={{ width: 80 }}>Единица</th>
              <th>Комментарий</th>
            </tr>
          </thead>
          <tbody>
            {visibleParameters.map((p) => {
              const existing = normByParamId.get(p.id);
              const qtyName = `norm_${p.id}_qtyPerItem`;
              const commentName = `norm_${p.id}_comment`;
              const unit = existing?.unit ?? p.unit;
              return (
                <tr key={p.id}>
                  <td>
                    <strong>{p.label}</strong>
                    {p.isRequired && (
                      <span
                        aria-label="обязательное поле"
                        title="обязательное"
                        style={{
                          color: 'var(--admin-tone-warn, #d97706)',
                          marginLeft: 4,
                        }}
                      >
                        *
                      </span>
                    )}
                  </td>
                  <td>
                    <input
                      name={qtyName}
                      type="text"
                      inputMode="decimal"
                      defaultValue={existing?.qtyPerItem ?? ''}
                      placeholder={unit}
                      style={{ width: 120 }}
                    />
                  </td>
                  <td>
                    <span className="admin-muted">{unit}</span>
                  </td>
                  <td>
                    <input
                      name={commentName}
                      type="text"
                      defaultValue={existing?.comment ?? ''}
                      placeholder="—"
                      style={{ width: '100%' }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <small className="admin-muted">
        Норма «количество на изделие» — целое или дробное число (до 4
        знаков после точки). Пустое значение = «норма не задана» —
        строка не сохранится. При переводе заказа в «Расчёт» по
        каждой заполненной норме создаётся отдельная строка
        «Потребности цеха».
      </small>

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
