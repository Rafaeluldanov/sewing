'use client';

/**
 * Reusable inline-форма «Сохранить цвет позиции» (этап «Указать в
 * заказе», см. ТЗ §4).
 *
 * Используется:
 *   - legacy /orders/[id] (через re-export wrapper в
 *     `apps/web/app/orders/[id]/material-color-form.tsx`);
 *   - новой управленческой карточке /admin/orders/[id], во вкладке
 *     «План» — primary input для `selectedColorText` строк
 *     `OrderMaterialRequirement.requiresColorSelection = true`.
 *
 * Source of truth: `OrderMaterialRequirement.selectedColorText`.
 * `WorkshopNeed` остаётся **derived view + warning**, а не source of
 * truth — поэтому форма пишет именно в backend через server-action
 * `updateOrderMaterialRequirementColorAction` (PATCH
 * `/api/orders/:id/material-requirements/:requirementId/color`),
 * никаких новых endpoint-ов.
 *
 * RBAC: action разрешён `ADMIN`/`SHOP_MANAGER`; backend сам
 * валидирует. На UI компонент показывается там, где caller решил
 * (вкладка «План» в admin / `MaterialsSnapshotCard` в legacy).
 *
 * Стилистика подсказки минимальная: текст «Цвет нужно указать в
 * заказе» сознательно идёт здесь — чтобы legacy-вёрстка выглядела
 * так же, как раньше. На вкладке «План» в admin текст прячется
 * через prop `hideHelperText`, потому что сам блок уже даёт
 * status-badge «Нужно указать цвет».
 */
import { useFormState, useFormStatus } from 'react-dom';
import { Check } from 'lucide-react';
import {
  updateOrderMaterialRequirementColorAction,
  type UpdateOrderMaterialRequirementColorActionState,
} from '@/app/orders/actions';

interface Props {
  orderId: string;
  requirementId: string;
  initialValue: string | null;
  /**
   * Скрыть встроенную подсказку «Цвет нужно указать в заказе».
   * Используется на вкладке «План» в новой карточке: там
   * status-badge даёт ту же информацию, дублировать в форме не
   * хочется.
   */
  hideHelperText?: boolean;
  /**
   * Внешний disabled — UI-стороной можем заблокировать форму
   * (например, для DONE/CANCELLED-снапшотов). Backend по-прежнему
   * сам остаётся source of truth по правилам валидации.
   */
  disabled?: boolean;
}

const initialState: UpdateOrderMaterialRequirementColorActionState = {};

export function MaterialColorForm({
  orderId,
  requirementId,
  initialValue,
  hideHelperText,
  disabled,
}: Props) {
  const action = updateOrderMaterialRequirementColorAction.bind(
    null,
    orderId,
    requirementId,
  );
  const [state, formAction] = useFormState(action, initialState);
  const inputId = `mreq-${requirementId}-color`;
  return (
    <form
      action={formAction}
      className="material-color-form"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '0.4rem',
        marginTop: '0.25rem',
      }}
      data-testid="material-color-form"
      data-requirement-id={requirementId}
    >
      <label
        htmlFor={inputId}
        className="meta-line"
        style={{ marginRight: 4 }}
      >
        Цвет:
      </label>
      <input
        id={inputId}
        name="selectedColorText"
        type="text"
        defaultValue={initialValue ?? ''}
        placeholder="например, графит-меланж"
        maxLength={120}
        disabled={disabled}
        style={{ minWidth: 180 }}
      />
      <SubmitButton disabled={disabled} />
      {!hideHelperText && (
        <span
          className="meta-line"
          style={{ fontSize: '0.8rem', fontStyle: 'italic' }}
        >
          Цвет нужно указать в заказе
        </span>
      )}
      {state.error && (
        <span className="error-box__msg" role="alert">
          {state.error}
        </span>
      )}
      {state.ok && (
        <span
          className="meta-line"
          role="status"
          style={{ color: '#1f7a1f', display: 'inline-flex', gap: 4 }}
        >
          <Check size={12} strokeWidth={1.7} aria-hidden /> Сохранено
        </span>
      )}
    </form>
  );
}

function SubmitButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending || disabled}>
      {pending ? 'Сохраняем…' : 'Сохранить цвет'}
    </button>
  );
}
