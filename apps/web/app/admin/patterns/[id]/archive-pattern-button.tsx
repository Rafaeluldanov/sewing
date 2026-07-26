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
 *   - **обратная операция**: для архивной номенклатуры та же кнопка
 *     превращается в «Вернуть из архива» (`restorePatternAction`) —
 *     иначе с карточки архивного лекала выхода нет, а во вкладке
 *     «Архив» списка `/admin/patterns` такая кнопка есть;
 *   - **disabled state**: пока `useTransition` бежит — «Архивируем…» /
 *     «Возвращаем…»;
 *   - **error handling**: action бросает `Error` — показываем его в
 *     inline `error-box`;
 *   - **revalidate**: action сам ревалидирует список и карточку, после
 *     чего бейдж статуса перерисуется (без redirect).
 *
 * RBAC: раздел `/admin/*` уже пускает только ADMIN/SHOP_MANAGER;
 * backend независимо валидирует роль на `PATCH /api/patterns/:id` и
 * `POST /api/patterns/restore`.
 */
import { ArchiveX, RotateCcw } from 'lucide-react';
import { useState, useTransition } from 'react';
import { archivePatternAction, restorePatternAction } from '../actions';

interface Props {
  patternId: string;
  patternName: string;
  /** Текущий статус лекала (`ACTIVE` / `DRAFT` / `ARCHIVED`). */
  status: string;
}

export function ArchivePatternButton({ patternId, patternName, status }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const archived = status === 'ARCHIVED';

  const handleClick = () => {
    const question = archived
      ? `Вернуть номенклатуру «${patternName}» из архива? Она снова появится в активном справочнике и в подборе для заказов и техкарт.`
      : `Архивировать номенклатуру «${patternName}»? Она пропадёт из активного справочника и перестанет предлагаться в заказах и техкартах. Связанные заказы и паспорта не пострадают.`;
    if (!window.confirm(question)) return;
    setError(null);
    startTransition(async () => {
      try {
        if (archived) {
          await restorePatternAction(patternId);
        } else {
          await archivePatternAction(patternId);
        }
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : archived
              ? 'Не удалось вернуть номенклатуру из архива'
              : 'Не удалось архивировать номенклатуру',
        );
      }
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        type="button"
        className={
          archived ? 'admin-btn admin-btn--ghost' : 'admin-btn admin-btn--danger'
        }
        onClick={handleClick}
        disabled={pending}
        aria-busy={pending}
      >
        {archived ? (
          <RotateCcw size={16} strokeWidth={1.6} aria-hidden />
        ) : (
          <ArchiveX size={16} strokeWidth={1.6} aria-hidden />
        )}
        {archived
          ? pending
            ? 'Возвращаем…'
            : 'Вернуть из архива'
          : pending
            ? 'Архивируем…'
            : 'Архивировать'}
      </button>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
