'use client';

/**
 * `RestorePatternSizeFileForm` — кнопка «Восстановить» для архивной
 * строки таблицы «Файлы по размерам». Возвращает файл `ARCHIVED →
 * ACTIVE` (см. `restorePatternSizeFileAction`); после revalidate файл
 * уезжает обратно в активную вкладку.
 *
 * Через `useTransition`, т.к. action бросает `Error` (а не возвращает
 * state). Ошибку показываем inline под кнопкой.
 */
import { RotateCcw } from 'lucide-react';
import { useState, useTransition } from 'react';
import { restorePatternSizeFileAction } from '../actions';

interface Props {
  patternId: string;
  sizeId: string;
  fileId: string;
}

export function RestorePatternSizeFileForm({
  patternId,
  sizeId,
  fileId,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      try {
        await restorePatternSizeFileAction(patternId, sizeId, fileId);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Не удалось восстановить файл',
        );
      }
    });
  };

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <button
        type="button"
        className="admin-table__action-link"
        onClick={handleClick}
        disabled={pending}
        aria-busy={pending}
        title="Восстановить из архива (вернуть в активные)"
      >
        <RotateCcw size={14} strokeWidth={1.6} aria-hidden />
        {pending ? '…' : 'Восстановить'}
      </button>
      {error && (
        <span
          role="alert"
          style={{ color: 'var(--admin-danger)', fontSize: '0.75rem' }}
        >
          {error}
        </span>
      )}
    </span>
  );
}
