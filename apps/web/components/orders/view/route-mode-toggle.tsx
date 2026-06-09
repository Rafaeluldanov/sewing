'use client';

/**
 * Тумблер адаптивного режима сплит-распошива заказа (route-mode, Вариант B).
 *
 * AUTO — режим SPLIT/COLLAPSED вычисляется на лету по активным сменам на
 * выделенном низ-станке (монитор цеха сам сливает/раздваивает колонки
 * распошива). FORCE_SPLIT / FORCE_COLLAPSED — мастер фиксирует режим вручную
 * (страховка от залипших смен и дребезга). Снапшот маршрута не меняется.
 *
 * Показывается только для заказов на сплит-маршруте (или если режим уже
 * зафиксирован вручную). Три submit-кнопки шлют значение через
 * `setOrderRouteModeAction`.
 */
import { useFormState, useFormStatus } from 'react-dom';
import type { RouteModeOverride } from '@sewing/shared/orders';
import {
  setOrderRouteModeAction,
  type SetRouteModeActionState,
} from '@/app/admin/orders/[id]/basic-actions';

const OPTIONS: { value: RouteModeOverride; label: string; hint: string }[] = [
  { value: 'AUTO', label: 'Авто', hint: 'по сменам' },
  { value: 'FORCE_SPLIT', label: 'Сплит', hint: 'две колонки' },
  { value: 'FORCE_COLLAPSED', label: 'Схлоп', hint: 'одна колонка' },
];

function ModeButton({
  value,
  label,
  hint,
  active,
}: {
  value: RouteModeOverride;
  label: string;
  hint: string;
  active: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="routeModeOverride"
      value={value}
      disabled={pending || active}
      aria-pressed={active}
      className={`route-mode-toggle__btn${active ? ' route-mode-toggle__btn--active' : ''}`}
      title={hint}
    >
      <span className="route-mode-toggle__btn-label">{label}</span>
      <span className="route-mode-toggle__btn-hint">{hint}</span>
    </button>
  );
}

export function RouteModeToggle({
  orderId,
  current,
}: {
  orderId: string;
  current: RouteModeOverride;
}) {
  const action = setOrderRouteModeAction.bind(null, orderId);
  const [state, formAction] = useFormState<SetRouteModeActionState, FormData>(
    action,
    {},
  );
  return (
    <form action={formAction} className="route-mode-toggle">
      <div className="route-mode-toggle__row" role="group" aria-label="Режим распошива">
        {OPTIONS.map((o) => (
          <ModeButton key={o.value} {...o} active={current === o.value} />
        ))}
      </div>
      {state.error ? (
        <p className="admin-form-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
