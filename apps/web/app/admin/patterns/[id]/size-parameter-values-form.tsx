'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Save, XCircle } from 'lucide-react';
import type {
  PatternItemSizeParameterValueDto,
  PatternSizeRefDto,
} from '@sewing/shared/patterns';
import {
  getPatternCategoryInputUnitLabel,
  type PatternCategoryParameterDto,
} from '@sewing/shared/pattern-categories';
import { replacePatternItemSizeParameterValuesAction } from '../actions';
import {
  initialSizeParameterValuesState,
  type SizeParameterValuesState,
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
      {pending ? 'Сохраняем…' : 'Сохранить погонные метры'}
    </button>
  );
}

interface Props {
  patternId: string;
  /**
   * Активные размеры номенклатуры — те же, что использует таблица
   * «Площади материалов». Источник истины — `PatternSizeFile` со
   * `status = ACTIVE`, расчёт делает `pattern-sizes-manager.tsx`.
   */
  sizes: readonly PatternSizeRefDto[];
  /**
   * Активные параметры категории с `inputType = LINEAR_M_BY_SIZE`
   * (`status = ACTIVE`). Каждый параметр = одна колонка таблицы:
   * «Основное полотно», «Рибана / кашкорсе», «Дублерин» и т. д.
   * Параметры приходят предварительно отфильтрованными — компонент
   * дополнительно фильтрует defence-in-depth.
   */
  parameters: readonly PatternCategoryParameterDto[];
  /**
   * Текущие сохранённые значения. Маппятся по
   * `(categoryParameterId, sizeId)`, чтобы для каждой ячейки
   * рендерить defaultValue из существующего значения. Ячейки без
   * сохранённого значения рендерятся пустыми.
   */
  values: readonly PatternItemSizeParameterValueDto[];
}

/**
 * Форма «Погонные метры» (этап «Доработать параметры категорий
 * номенклатуры», см. ТЗ §5/§8/§9).
 *
 * Строки = активные размеры номенклатуры; колонки = активные
 * LINEAR_M_BY_SIZE-параметры категории лекала. Менеджер вводит
 * погонные метры в нужные ячейки; пустые ячейки — «не задано» и
 * не отправляются на backend.
 *
 * Единицы:
 *   - в ячейках всегда вводят м пог. (это semantics
 *     `inputType = LINEAR_M_BY_SIZE` — см. shared
 *     `getPatternCategoryInputUnitLabel`);
 *   - `parameter.unit` — это «единица потребности»: в чём строка
 *     попадёт в «Потребность цеха» (кг / м пог. / м²). Это НЕ
 *     единица ввода. UI показывает её отдельной подписью под
 *     заголовком колонки («в потребность: кг»);
 *   - пересчёт «м пог. → кг / м²» делает backend
 *     (`WorkshopNeedsService.computeLinearBySizeParameter`)
 *     через ширину рулона и плотность из техкарты.
 *
 * Семантика сохранения (full-replace):
 *   - заполненная ячейка → значение создаётся / обновляется;
 *   - пустая ячейка → значение стирается (если было).
 */
export function PatternItemSizeParameterValuesForm({
  patternId,
  sizes,
  parameters,
  values,
}: Props) {
  const [state, formAction] = useFormState<SizeParameterValuesState, FormData>(
    replacePatternItemSizeParameterValuesAction.bind(null, patternId),
    initialSizeParameterValuesState,
  );

  // Defence-in-depth: даже если родитель передал лишние параметры,
  // в форме рендерим только активные LINEAR_M_BY_SIZE.
  const visibleParameters = parameters.filter(
    (p) => p.inputType === 'LINEAR_M_BY_SIZE' && p.status === 'ACTIVE',
  );

  // Map (categoryParameterId, sizeId) → текущее value (для defaultValue).
  const valueByKey = new Map<string, PatternItemSizeParameterValueDto>();
  for (const v of values) {
    valueByKey.set(`${v.categoryParameterId}::${v.sizeId}`, v);
  }

  if (sizes.length === 0) {
    return (
      <div className="admin-muted" role="status">
        Сначала добавьте размеры номенклатуры — без активных размеров
        заполнить «Погонные метры» нечем.
      </div>
    );
  }

  if (visibleParameters.length === 0) {
    return (
      <div className="admin-muted" role="status">
        В категории нет параметров погонных метров. Добавьте параметры
        типа «Погонные метры по размерам» в категории.
      </div>
    );
  }

  return (
    <form action={formAction} className="admin-form">
      <input
        type="hidden"
        name="__sizeIds"
        value={sizes.map((s) => s.id).join(',')}
      />
      <input
        type="hidden"
        name="__parameterIds"
        value={visibleParameters.map((p) => p.id).join(',')}
      />
      <div style={{ overflowX: 'auto' }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Размер</th>
              {visibleParameters.map((p) => {
                // Для LINEAR_M_BY_SIZE единица ввода всегда «м пог.» —
                // это semantics типа ввода, а НЕ `parameter.unit`
                // (последняя задаёт единицу потребности).
                const inputUnit =
                  getPatternCategoryInputUnitLabel(p.inputType) ?? 'м пог.';
                const needUnit = p.unit && p.unit !== '' ? p.unit : null;
                return (
                  <th key={p.id}>
                    {p.label}
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
                    <div
                      className="admin-muted"
                      style={{ fontSize: '0.78rem', fontWeight: 400 }}
                    >
                      ввод: {inputUnit}
                      {needUnit && (
                        <> → потребность: {needUnit}</>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sizes.map((size) => (
              <tr key={size.id}>
                <td>
                  <strong>{size.code}</strong>
                </td>
                {visibleParameters.map((p) => {
                  const key = `value_${p.id}_${size.id}`;
                  const existing = valueByKey.get(`${p.id}::${size.id}`);
                  // Placeholder — единица ВВОДА (м пог.), а не
                  // `parameter.unit` (та может быть «кг» — это единица
                  // потребности, в ячейке её показывать нельзя).
                  const inputUnit =
                    getPatternCategoryInputUnitLabel(p.inputType) ?? 'м пог.';
                  return (
                    <td key={p.id}>
                      <input
                        name={key}
                        type="text"
                        inputMode="decimal"
                        defaultValue={existing?.value ?? ''}
                        placeholder={inputUnit}
                        title={`Введите расход в ${inputUnit} на одно изделие`}
                        style={{ width: 96 }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <small className="admin-muted">
        В ячейках вводятся погонные метры на одно изделие — целое или
        дробное число (до 4 знаков после точки). Пустая ячейка =
        «значение не задано», она не сохранится. При расчёте
        «Потребности цеха» по каждому параметру создаётся одна строка:
        значение умножается на количество в заказе по соответствующему
        размеру и суммируется. Если «Единица потребности» параметра —
        кг или м², backend пересчитывает погонные метры через ширину
        рулона и плотность материала из состава заказа.
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
