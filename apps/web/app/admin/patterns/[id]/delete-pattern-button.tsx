'use client';

/**
 * `DeletePatternButton` — кнопка «Удалить навсегда» на карточке
 * `/admin/patterns/[id]`. Hard-delete (физическое удаление строки),
 * в отличие от soft-архива (`ArchivePatternButton`).
 *
 * Видна ТОЛЬКО для архивной номенклатуры (`status === 'ARCHIVED'`) —
 * двойной барьер: сначала архивируем, потом, если точно не нужна,
 * удаляем навсегда. Backend дополнительно блокирует удаление, если на
 * лекало ссылаются заказы (`PATTERN_DELETE_FORBIDDEN`) — текст ошибки
 * показываем inline.
 *
 * После успеха карточки больше нет — уводим на список (`router.push`).
 */
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deletePatternAction } from '../actions';

interface Props {
  patternId: string;
  patternName: string;
  status: string;
}

export function DeletePatternButton({ patternId, patternName, status }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Удалять навсегда можно только архивную номенклатуру.
  if (status !== 'ARCHIVED') return null;

  const handleClick = () => {
    if (
      !window.confirm(
        `Удалить номенклатуру «${patternName}» НАВСЕГДА? Действие необратимо: пропадут размеры, площади, нормы и связанная задача конструктора.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await deletePatternAction(patternId);
        router.push('/admin/patterns');
        router.refresh();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Не удалось удалить номенклатуру',
        );
      }
    });
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginTop: 16,
      }}
    >
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
