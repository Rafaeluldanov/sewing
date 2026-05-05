'use client';

import { useState, useTransition } from 'react';
import { Icon } from '@/components/icon';
import { deleteMyPassportAction } from './actions';

interface Props {
  passportId: string;
  orderId: string;
  passportNumber: string;
}

/**
 * Кнопка «Удалить» (мусорная корзина) для строки списка
 * `/work/passports`. Подтверждает действие в `window.confirm`
 * — серийная правка серьёзная, лишний сабмит без подтверждения
 * терять серверные сдельные начисления слишком дорого.
 *
 * RBAC enforce-ит backend: `CUTTER_ASSISTANT` / `CUTTER` могут
 * удалять только свои паспорта (`creatorId === me`) и только пока
 * `editable = true` (status=CREATED, без ячейки, без событий
 * кроме CREATED). Серверная страница рендерит кнопку только на
 * строках с `item.editable`, чтобы пользователь не получал
 * глухую 409-ку при попытке удалить «двинувшийся» паспорт.
 */
export function DeleteMyPassportButton({
  passportId,
  orderId,
  passportNumber,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    const ok = window.confirm(
      `Удалить паспорт ${passportNumber}? Если паспорт ещё не размещён в ячейку, он удалится вместе с начислением раскройщику за этот выпуск.`,
    );
    if (!ok) return;
    startTransition(async () => {
      const result = await deleteMyPassportAction(passportId, orderId);
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        gap: 4,
        alignItems: 'flex-end',
      }}
    >
      <button
        type="button"
        className="btn btn-danger"
        disabled={pending}
        onClick={handleClick}
        aria-label={`Удалить паспорт ${passportNumber}`}
        title={`Удалить паспорт ${passportNumber}`}
      >
        <Icon name="trash" size={16} />
        {pending ? 'Удаляем…' : 'Удалить'}
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
