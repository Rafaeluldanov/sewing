'use client';

/**
 * Кнопка «Материал поступил» в карточке заказа (этап «Ручная отметка
 * поступления материала», см.
 * `apps/api/src/modules/order-material-arrivals/*`,
 * `apps/web/app/admin/orders/[id]/material-arrivals-actions.ts`,
 * `apps/web/components/orders/cut-readiness-card.tsx`).
 *
 * UX:
 *   - Открывает inline-форму с обязательным комментарием. Пока форма
 *     не открыта — компактная кнопка, чтобы не растягивать карточку.
 *   - Сабмит идёт через `markOrderMaterialArrivedAction` (см.
 *     `material-arrivals-actions.ts`); после успеха — `revalidatePath`
 *     перерисует `CutReadinessCard` с актуальными overrides.
 *   - Текст «Эта отметка разблокирует крой вручную, но не создаёт
 *     складскую приёмку и не меняет остатки» — обязательное
 *     предупреждение, требуемое ТЗ.
 *
 * Сознательная простота:
 *   - не показываем чекбоксы по конкретным `WorkshopNeed` — backend
 *     по умолчанию применит ко всем blocking-потребностям (см.
 *     `OrderMaterialArrivalsService.markArrived`). Если в будущем
 *     понадобится точечная отметка, фронт сможет передать
 *     `workshopNeedId` через скрытое поле без изменений API.
 *   - не делаем отдельный confirm — сама форма с комментарием
 *     (нельзя нажать без текста) — достаточная защита от случайного
 *     клика.
 */

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, PackageOpen, XCircle } from 'lucide-react';
import { useState } from 'react';
import { markOrderMaterialArrivedAction } from '@/app/admin/orders/[id]/material-arrivals-actions';
import { initialOrderMaterialArrivalsFormState } from '@/app/admin/orders/[id]/material-arrivals-form-state';

interface Props {
  orderId: string;
  /**
   * Если фронт уже знает про конкретные blocking-`WorkshopNeed` —
   * можно прокинуть их id, чтобы создать override строго по ним.
   * На MVP не используется (передаём пустой массив), но контракт
   * оставляем — в будущем можно подключить чекбоксы по строкам.
   */
  workshopNeedIds?: string[];
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <CheckCircle size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Подтвердить'}
    </button>
  );
}

export function MaterialArrivedButton({
  orderId,
  workshopNeedIds = [],
}: Props) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useFormState(
    markOrderMaterialArrivedAction.bind(null, orderId),
    initialOrderMaterialArrivalsFormState,
  );

  if (!open) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={() => setOpen(true)}
        >
          <PackageOpen size={16} strokeWidth={1.6} aria-hidden />
          Материал поступил
        </button>
        {state.ok && state.successMessage && (
          <div className="success-box" role="status">
            <CheckCircle size={14} strokeWidth={1.6} aria-hidden />{' '}
            {state.successMessage}
          </div>
        )}
      </div>
    );
  }

  return (
    <form
      action={formAction}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div
        style={{
          fontSize: '0.85rem',
          fontWeight: 600,
        }}
      >
        Материал поступил
      </div>
      <div
        className="admin-muted"
        style={{ fontSize: '0.78rem', lineHeight: 1.4 }}
      >
        Эта отметка разблокирует крой вручную, но не создаёт складскую
        приёмку и не меняет остатки.
      </div>

      {workshopNeedIds.map((id) => (
        <input
          key={id}
          type="hidden"
          name="workshopNeedId"
          value={id}
        />
      ))}

      <label
        style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <span style={{ fontSize: '0.78rem', fontWeight: 500 }}>
          Комментарий / причина <span style={{ color: '#dc2626' }}>*</span>
        </span>
        <textarea
          name="comment"
          required
          minLength={2}
          rows={3}
          placeholder="Например: «Материал на складе, приёмку оформим позже»"
          style={{
            fontSize: '0.85rem',
            padding: '6px 8px',
            border: '1px solid var(--admin-border, #d4d4d8)',
            borderRadius: 4,
            fontFamily: 'inherit',
          }}
        />
        {state.fieldErrors?.comment && (
          <span style={{ fontSize: '0.75rem', color: '#dc2626' }}>
            {state.fieldErrors.comment}
          </span>
        )}
      </label>

      <div style={{ display: 'flex', gap: 6 }}>
        <SubmitButton />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={() => setOpen(false)}
        >
          Отмена
        </button>
      </div>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
    </form>
  );
}
