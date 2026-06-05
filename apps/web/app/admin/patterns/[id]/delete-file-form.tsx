'use client';

/**
 * `DeletePatternSizeFileForm` — кнопка-корзина «Удалить навсегда» для
 * строки таблицы «Файлы по размерам». В отличие от архивации это
 * безвозвратно: backend удаляет запись `PatternSizeFile` и физический
 * файл с диска (см. `deletePatternSizeFileAction`).
 *
 * Доступна в обеих вкладках (активные и архив) — по решению задачи
 * «корзина везде». Перед удалением — `window.confirm`. Ошибку backend
 * (например, если файл уже удалён в другой вкладке) показываем inline
 * под строкой через `title`/состояние.
 *
 * Через `useTransition`, т.к. action бросает `Error` (а не возвращает
 * state) — `<form action>` проглотил бы исключение. `onDeleted` даёт
 * родителю шанс показать ошибку (мы просто полагаемся на revalidate).
 */
import { Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { deletePatternSizeFileAction } from '../actions';

interface Props {
  patternId: string;
  sizeId: string;
  fileId: string;
  /** Подпись размера/версии для текста подтверждения. */
  label: string;
}

export function DeletePatternSizeFileForm({
  patternId,
  sizeId,
  fileId,
  label,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    if (
      !window.confirm(
        `Удалить файл навсегда (${label})? Файл будет стёрт с диска без возможности восстановления.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await deletePatternSizeFileAction(patternId, sizeId, fileId);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось удалить файл');
      }
    });
  };

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <button
        type="button"
        className="admin-table__action-link admin-table__action-link--danger"
        onClick={handleClick}
        disabled={pending}
        aria-busy={pending}
        title="Удалить навсегда (файл стирается с диска)"
      >
        <Trash2 size={14} strokeWidth={1.6} aria-hidden />
        {pending ? '…' : 'Удалить'}
      </button>
      {error && (
        <span className="admin-muted" role="alert" style={{ color: 'var(--admin-danger, #dc2626)', fontSize: '0.75rem' }}>
          {error}
        </span>
      )}
    </span>
  );
}
