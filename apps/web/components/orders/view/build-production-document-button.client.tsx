'use client';

/**
 * Кнопка «Сформировать документ» в блоке выпуска карточки заказа.
 *
 * Показывается ТОЛЬКО там, где документа нет, а заказ уже закрыт — то есть у заказов, закрытых
 * до появления раздела. У живого потока кнопки нет и быть не должно: документ рождается
 * закрытием сам.
 */
import { useState, useTransition } from 'react';
import { FileCheck2 } from 'lucide-react';

import { buildProductionDocumentAction } from './production-document-actions';

interface Props {
  orderId: string;
}

export function BuildProductionDocumentButton({ orderId }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        className="admin-btn admin-btn--primary"
        disabled={pending}
        data-testid="build-production-document-button"
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await buildProductionDocumentAction(orderId);
            if (!result.ok) setError(result.error);
          });
        }}
      >
        <FileCheck2 size={16} strokeWidth={1.6} aria-hidden />
        {pending ? 'Формирую…' : 'Сформировать документ'}
      </button>
      {error ? (
        <div className="error-box" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
