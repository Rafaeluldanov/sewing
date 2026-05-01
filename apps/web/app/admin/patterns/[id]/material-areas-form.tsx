'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Save, XCircle } from 'lucide-react';
import {
  MATERIAL_ROLES,
  MATERIAL_ROLE_LABELS,
  type PatternMaterialAreaDto,
  type PatternSizeRefDto,
} from '@sewing/shared/patterns';
import type { PatternCategoryParameterDto } from '@sewing/shared/pattern-categories';
import { replacePatternMaterialAreasAction } from '../actions';
import {
  initialMaterialAreasState,
  type MaterialAreasState,
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
      {pending ? 'Сохраняем…' : 'Сохранить площади'}
    </button>
  );
}

interface Column {
  /** materialRole / roleKey — сохраняется в БД. */
  roleKey: string;
  /** Подпись колонки в шапке. */
  label: string;
  /** Единица (м²). На MVP UI рисует только AREA_M2_BY_SIZE. */
  unit: string;
  /** Подсказка «обязательное поле» — на MVP только декоративная. */
  isRequired: boolean;
}

interface Props {
  patternId: string;
  sizes: PatternSizeRefDto[];
  areas: PatternMaterialAreaDto[];
  /**
   * Активные параметры категории с `inputType = AREA_M2_BY_SIZE`
   * (этап «Категории номенклатуры»). Если задано — рендерим колонки
   * именно по ним (label = parameter.label, materialRole =
   * parameter.roleKey). Если нет / у лекала нет категории —
   * fallback на глобальные `MATERIAL_ROLES`.
   */
  categoryAreaParameters?: readonly PatternCategoryParameterDto[];
  /**
   * У лекала есть категория. Если true и
   * `categoryAreaParameters.length === 0` — показываем empty-state
   * («В категории нет параметров площади») вместо fallback на
   * `MATERIAL_ROLES` (это обеспечивает требование ТЗ §10 «не
   * показывать всё для всех» для лекал с категорией).
   */
  hasCategory?: boolean;
}

/**
 * Editable таблица «Площади материалов».
 *
 * Строки = **активные размеры** номенклатуры (`PatternSizeRefDto`),
 * колонки =
 *   - параметры категории с `inputType = AREA_M2_BY_SIZE` (если у
 *     лекала задан `categoryId`); пример Худи: «Основной материал»,
 *     «Кашкорсе»;
 *   - глобальный `MATERIAL_ROLES` (fallback для лекал без категории
 *     — старые карточки продолжают работать).
 *
 * Менеджер вводит площадь в м² в нужные ячейки; пустые ячейки —
 * «не задано» и не отправляются на backend.
 *
 * При сохранении server action собирает все непустые ячейки из формы
 * и шлёт `PUT /api/patterns/:id/material-areas` (full-replace).
 * Скрытые `__sizeIds` и `__roleKeys` — CSV списки id размеров и
 * roleKey-ов, по которым action итерируется.
 */
export function PatternMaterialAreasForm({
  patternId,
  sizes,
  areas,
  categoryAreaParameters,
  hasCategory,
}: Props) {
  const [state, formAction] = useFormState<MaterialAreasState, FormData>(
    replacePatternMaterialAreasAction.bind(null, patternId),
    initialMaterialAreasState,
  );

  // Defence-in-depth: backend уже фильтрует `categoryAreaParameters`
  // до `inputType = AREA_M2_BY_SIZE` в `PatternsService.toDetailDto`,
  // но фильтруем и здесь — чтобы UI «Площади материалов» гарантированно
  // не показывал колонки фурнитуры (`QTY_PER_ITEM`) и описаний
  // (`TEXT_ONLY`). См. ТЗ §7 «Material areas» — фурнитура не должна
  // попадать в таблицу м².
  const areaColumnsFromCategory = (categoryAreaParameters ?? []).filter(
    (p) => p.inputType === 'AREA_M2_BY_SIZE' && p.status === 'ACTIVE',
  );
  const useCategoryColumns =
    Boolean(hasCategory) && areaColumnsFromCategory.length > 0;

  const columns: Column[] = useCategoryColumns
    ? areaColumnsFromCategory.map((p) => ({
        roleKey: p.roleKey,
        label: p.label,
        unit: p.unit,
        isRequired: p.isRequired,
      }))
    : (MATERIAL_ROLES as readonly string[]).map((role) => ({
        roleKey: role,
        label: MATERIAL_ROLE_LABELS[role as keyof typeof MATERIAL_ROLE_LABELS],
        unit: 'м²',
        isRequired: false,
      }));

  // Map (sizeId, role) → текущее значение для defaultValue ячеек.
  const initialMap = new Map<string, string>();
  for (const a of areas) {
    initialMap.set(`${a.sizeId}::${a.materialRole}`, a.areaM2);
  }

  if (sizes.length === 0) {
    // Fallback: обычно пустое состояние перехватывает родительский
    // `PatternSizesManager` и показывает empty-state с кнопкой
    // «Добавить размер». Сюда попадаем только если форма случайно
    // отрендерилась без активных размеров.
    return (
      <div className="admin-muted">
        Сначала добавьте размеры и загрузите DXF.
      </div>
    );
  }

  // Этап «Категории номенклатуры»: если у лекала есть category, но в
  // ней нет AREA_M2_BY_SIZE параметров — рисуем явный empty-state.
  // Иначе таблица была бы пустой без колонок и менеджер не понимал
  // бы, что нужно сделать. Фурнитурные параметры (`QTY_PER_ITEM`)
  // здесь не считаются — они в таблицу м² не попадают.
  if (hasCategory && areaColumnsFromCategory.length === 0) {
    return (
      <div className="admin-muted" role="status">
        В категории нет параметров площади (тип «Площадь по размерам, м²»).
        Добавьте параметры в категории — нажмите «Добавить категорию» в
        списке номенклатуры.
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
        name="__roleKeys"
        value={columns.map((c) => c.roleKey).join(',')}
      />
      <div style={{ overflowX: 'auto' }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Размер</th>
              {columns.map((col) => (
                <th key={col.roleKey}>
                  {col.label}
                  {col.isRequired && (
                    <span aria-label="обязательное поле" title="обязательное"
                          style={{ color: 'var(--admin-tone-warn, #d97706)', marginLeft: 4 }}>
                      *
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sizes.map((size) => (
              <tr key={size.id}>
                <td>
                  <strong>{size.code}</strong>
                </td>
                {columns.map((col) => {
                  const key = `area_${size.id}_${col.roleKey}`;
                  const initial =
                    initialMap.get(`${size.id}::${col.roleKey}`) ?? '';
                  return (
                    <td key={col.roleKey}>
                      <input
                        name={key}
                        type="text"
                        inputMode="decimal"
                        defaultValue={initial}
                        placeholder="м²"
                        title={col.unit ? `Единица: ${col.unit}` : undefined}
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
        {useCategoryColumns ? (
          <>
            Колонки построены по параметрам категории «
            {categoryAreaParameters && categoryAreaParameters.length > 0
              ? categoryAreaParameters[0]?.categoryId
              : ''}
            ». Площадь в м², дробная часть до 4 знаков после точки. Пустая
            ячейка = «значение не задано», она не сохранится.
          </>
        ) : (
          <>
            Категория не выбрана — показан общий набор ролей (legacy
            fallback). Выберите категорию в форме редактирования карточки,
            чтобы видеть только нужные колонки.
            Площадь в м², дробная часть до 4 знаков после точки. Пустая
            ячейка = «значение не задано», она не сохранится.
          </>
        )}
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
