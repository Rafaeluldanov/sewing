'use client';

import { useState, useTransition } from 'react';
import { Icon } from '@/components/icon';
import { deletePassportFromDetailAction } from '@/app/orders/[id]/passports/actions';

interface Props {
  passportId: string;
  orderId: string;
  passportNumber: string;
}

/**
 * «Удалить паспорт» в карточке `/passports/[id]` рядом с «К заказу».
 *
 * Отдельный client-component нужен, потому что после успешного
 * удаления сама страница исчезает — `deletePassportFromDetailAction`
 * редиректит на `/orders/<orderId>`, где паспорта уже нет в списке.
 * Inline-вариант для таблицы заказа (`DeletePassportButton`)
 * остаётся на месте и просто ревалидирует страницу.
 *
 * RBAC проверяет backend (`@Roles('SHOP_MANAGER', 'ADMIN')`),
 * но кнопка рендерится только серверной страницей под условием
 * менеджерской роли — не-менеджеру в HTML она не приходит.
 */
export function DeleteFromDetailButton({
  passportId,
  orderId,
  passportNumber,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    const ok = window.confirm(
      `Удалить паспорт ${passportNumber}? Данные паспорта (события, сдельные начисления в статусе «Ожидает выпуск», записи брака) будут удалены.`,
    );
    if (!ok) return;
    startTransition(async () => {
      // `deletePassportFromDetailAction` при успехе бросает
      // NEXT_REDIRECT — это нормальный flow, transition его
      // обработает сам. Если backend отказал, action возвращает
      // `{ error }` без редиректа, и мы кладём текст в error-box.
      const result = await deletePassportFromDetailAction(
        passportId,
        orderId,
      );
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        className="btn btn-danger"
        disabled={pending}
        onClick={handleClick}
      >
        <Icon name="trash" size={16} />
        {pending ? 'Удаляем…' : 'Удалить паспорт'}
      </button>
      {error && (
        <span
          className="meta-line"
          style={{ color: 'var(--color-danger-fg)' }}
        >
          {error}
        </span>
      )}
    </span>
  );
}
