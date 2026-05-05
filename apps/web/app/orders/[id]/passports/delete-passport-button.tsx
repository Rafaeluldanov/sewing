'use client';

import { useState, useTransition } from 'react';
import { Icon } from '@/components/icon';
import { deletePassportAction } from './actions';

interface Props {
  passportId: string;
  orderId: string;
  /** Номер паспорта для confirm-сообщения. */
  passportNumber: string;
  /** Inline-вариант для строки таблицы (компактный, без текста). */
  variant: 'icon-only' | 'with-label';
}

/**
 * Кнопка «Удалить паспорт» (см.
 * `apps/web/app/orders/[id]/passports/actions.ts`,
 * `docs/domain.md §7.8 «Удаление паспорта»`).
 *
 * Используется в двух местах:
 *   - таблица паспортов на `/orders/[id]` — `variant="icon-only"`,
 *     одна корзинка в столбце «Действия» (компактно, без подписи);
 *   - карточка `/passports/[id]` — `variant="with-label"`, кнопка
 *     рядом с «К заказу» с явной подписью «Удалить паспорт».
 *
 * RBAC enforcing — на backend-е (`@Roles('SHOP_MANAGER', 'ADMIN')`).
 * Серверная страница, на которой рендерится кнопка, отвечает за то,
 * чтобы для не-менеджеров она вообще не приходила в HTML.
 *
 * Подтверждение через `window.confirm` — без своего модального
 * окна. На MVP этого достаточно: операция редкая, исправляет
 * ошибочный выпуск.
 */
export function DeletePassportButton({
  passportId,
  orderId,
  passportNumber,
  variant,
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
      const result = await deletePassportAction(passportId, orderId);
      if (result.error) {
        setError(result.error);
      }
    });
  }

  if (variant === 'icon-only') {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
        <button
          type="button"
          className="btn btn-danger"
          style={{ padding: '0.25rem 0.4rem' }}
          aria-label={`Удалить паспорт ${passportNumber}`}
          title={`Удалить паспорт ${passportNumber}`}
          disabled={pending}
          onClick={handleClick}
        >
          <Icon name="trash" size={16} />
        </button>
        {error && (
          <span
            className="meta-line"
            style={{ color: 'var(--color-danger-fg)', maxWidth: 220 }}
          >
            {error}
          </span>
        )}
      </span>
    );
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
        <span className="meta-line" style={{ color: 'var(--color-danger-fg)' }}>
          {error}
        </span>
      )}
    </span>
  );
}
