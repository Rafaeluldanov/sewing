'use client';

/**
 * `ArchivePatternButton` — кнопка «Архивировать» на карточке
 * `/admin/patterns/[id]`.
 *
 * Живёт в слоте `actions` шапки страницы — рядом с «К списку» и
 * бейджем статуса, консистентно с `ArchiveTechCardButton` на
 * `/admin/tech-cards/[id]`. Статус номенклатуры можно сменить и через
 * `<select>` в форме редактирования, но эта кнопка даёт быстрый
 * «один клик + подтверждение» сценарий.
 *
 * Поведение:
 *   - **confirmation**: `window.confirm` с именем лекала;
 *   - **status guard**: для уже архивной номенклатуры кнопка не
 *     рендерится (повторный архив бессмыслен);
 *   - **disabled state**: пока `useTransition` бежит — «Архивируем…»;
 *   - **error handling**: `archivePatternAction` бросает `Error` —
 *     показываем его в inline `error-box`;
 *   - **revalidate**: action сам ревалидирует список и карточку, после
 *     чего бейдж статуса перерисуется в «Архив» (без redirect).
 *
 * RBAC: раздел `/admin/*` уже пускает только ADMIN/SHOP_MANAGER;
 * backend независимо валидирует роль на `PATCH /api/patterns/:id`.
 */
import { ArchiveX } from 'lucide-react';
import { useState, useTransition } from 'react';
import { archivePatternAction } from '../actions';

interface Props {
  patternId: string;
  patternName: string;
  /** Текущий статус лекала (`ACTIVE` / `DRAFT` / `ARCHIVED`). */
  status: string;
}

export function ArchivePatternButton({ patternId, patternName, status }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Уже в архиве — кнопку прятать (нечего архивировать повторно).
  if (status === 'ARCHIVED') return null;

  const handleClick = () => {
    if (
      !window.confirm(
        `Архивировать номенклатуру «${patternName}»? Она пропадёт из активного справочника и перестанет предлагаться в заказах и техкартах. Связанные заказы и паспорта не пострадают.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await archivePatternAction(patternId);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Не удалось архивировать номенклатуру',
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
