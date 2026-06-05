'use client';

/**
 * `DeleteTechCardButton` — кнопка «Удалить навсегда» на карточке
 * `/admin/tech-cards/[id]`. Hard-delete строки, в отличие от
 * soft-деактивации (`ArchiveTechCardButton`, `isActive=false`).
 *
 * Видна ТОЛЬКО для архивной (неактивной) техкарты (`isActive === false`).
 * Backend блокирует удаление, если карта используется в заказах или их
 * snapshot-потребностях (`TECH_CARD_DELETE_FORBIDDEN`) — текст ошибки
 * показываем inline.
 *
 * После успеха карточки больше нет — уводим на список (`router.push`).
 */
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteTechCardPermanentAction } from '../actions';

interface Props {
  techCardId: string;
  techCardName: string;
  isActive: boolean;
}

export function DeleteTechCardButton({
  techCardId,
  techCardName,
  isActive,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Удалять навсегда можно только архивную (неактивную) карту.
  if (isActive) return null;

  const handleClick = () => {
    if (
      !window.confirm(
        `Удалить техкарту «${techCardName}» НАВСЕГДА? Действие необратимо: пропадут строки материалов и подряда.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await deleteTechCardPermanentAction(techCardId);
        router.push('/admin/tech-cards');
        router.refresh();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Не удалось удалить техкарту',
        );
      }
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        type="button"
        className="admin-btn admin-btn--danger"
        onClick={handleClick}
        disabled={pending}
        aria-busy={pending}
      >
        <Trash2 size={16} strokeWidth={1.6} aria-hidden />
        {pending ? 'Удаляем…' : 'Удалить навсегда'}
      </button>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
