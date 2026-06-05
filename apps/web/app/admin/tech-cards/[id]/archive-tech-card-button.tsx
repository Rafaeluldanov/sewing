'use client';

/**
 * `ArchiveTechCardButton` — кнопка «Архивировать техкарту» на карточке
 * `/admin/tech-cards/[id]`.
 *
 * Soft-delete = деактивация (`isActive = false`): hard-delete у техкарт
 * намеренно не выставлен, карта может быть зашита в snapshot заказов
 * (см. `TechCardsController`). Активность можно снять и галочкой
 * «Активна» в форме — эта кнопка даёт явный «один клик + подтверждение».
 *
 * Поведение зеркалит «Отменить заказ» / «Архивировать номенклатуру»:
 *   - `window.confirm` с именем техкарты;
 *   - для уже неактивной техкарты кнопка не рендерится;
 *   - `useTransition` → «Архивируем…» + disabled;
 *   - ошибку из `archiveTechCardAction` показываем inline;
 *   - action сам ревалидирует список/карточку/`/orders/new`.
 *
 * RBAC: `/admin/*` пускает только ADMIN/SHOP_MANAGER; backend
 * независимо валидирует роль на `PATCH /api/tech-cards/:id`.
 */
import { ArchiveX } from 'lucide-react';
import { useState, useTransition } from 'react';
import { archiveTechCardAction } from '../actions';

interface Props {
  techCardId: string;
  techCardName: string;
  isActive: boolean;
}

export function ArchiveTechCardButton({
  techCardId,
  techCardName,
  isActive,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Уже неактивна — прятать кнопку.
  if (!isActive) return null;

  const handleClick = () => {
    if (
      !window.confirm(
        `Архивировать техкарту «${techCardName}»? Она пропадёт из активного справочника и перестанет предлагаться при создании заказа. Уже запущенные заказы сохранят свой snapshot.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await archiveTechCardAction(techCardId);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Не удалось архивировать техкарту',
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
        <ArchiveX size={16} strokeWidth={1.6} aria-hidden />
        {pending ? 'Архивируем…' : 'Архивировать'}
      </button>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
