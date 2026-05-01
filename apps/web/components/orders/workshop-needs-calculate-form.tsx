'use client';

/**
 * Client-form для action «Просчитать потребность» в карточке заказа.
 *
 * Этап 4А «Потребность цеха». Сама action-логика живёт в
 * `/admin/workshop-needs/actions::calculateOrderWorkshopNeedsAction`,
 * сюда подключаем её через `useFormState` для in-place feedback
 * (success-toast / error-box / WORKSHOP_NEEDS_ALREADY_REVIEWED-warning).
 *
 * `force`-пересчёт сознательно НЕ выставляем UI-кнопкой на этом
 * этапе (см. ТЗ Этапа 4А): если backend вернул
 * `WORKSHOP_NEEDS_ALREADY_REVIEWED`, показываем понятное сообщение
 * и предлагаем менеджеру сначала почистить руками.
 */

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Play, XCircle } from 'lucide-react';
import { calculateOrderWorkshopNeedsAction } from '@/app/admin/workshop-needs/actions';
import { initialCalculateWorkshopNeedsState } from '@/app/admin/workshop-needs/form-state';

interface Props {
  orderId: string;
  hasNeeds: boolean;
}

function SubmitButton({ hasNeeds }: { hasNeeds: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Play size={16} strokeWidth={1.6} aria-hidden />
      {pending
        ? 'Считаем…'
        : hasNeeds
          ? 'Пересчитать потребность'
          : 'Просчитать потребность'}
    </button>
  );
}

export function CalculateWorkshopNeedsForm({ orderId, hasNeeds }: Props) {
  const [state, formAction] = useFormState(
    calculateOrderWorkshopNeedsAction.bind(null, orderId),
    initialCalculateWorkshopNeedsState,
  );

  return (
    <form
      action={formAction}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginBottom: 8,
      }}
    >
      <div className="admin-actions-row">
        <SubmitButton hasNeeds={hasNeeds} />
      </div>

      {state.alreadyReviewed && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> Есть проверенные
          потребности. Пересчёт может удалить ручные данные. Очистите
          неактуальные строки руками или используйте force-пересчёт через
          API.
        </div>
      )}

      {state.error && !state.alreadyReviewed && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}

      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
          {state.summary && state.summary.warnings.length > 0 && (
            <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
              {state.summary.warnings.map((w, i) => (
                <li key={i} style={{ fontSize: '0.82rem' }}>
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
