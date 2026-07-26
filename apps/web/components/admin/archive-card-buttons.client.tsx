'use client';

/**
 * Кнопки «В архив» / «Вернуть из архива» + «Удалить навсегда» на
 * КАРТОЧКЕ записи (`/admin/<раздел>/[id]`).
 *
 * Тот же двухшаговый контур, что и в списке
 * (`bulk-archive.client.tsx`), только для одной записи и с редиректом
 * на список после успешного удаления — карточки-то больше нет.
 * Server actions приходят пропсами, поэтому компонент ничего не знает
 * о разделе (техкарты / маршруты / оборудование / …).
 *
 * Почему не переиспользуем `BulkArchiveRowActions`: тому нужен
 * контекст-провайдер списка (выбор строк, тулбар), а карточке нужен
 * inline-показ ошибки и redirect. Общее — только тексты подтверждения,
 * они и так живут в пропсах вызывающей стороны.
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Archive, RotateCcw, Trash2 } from 'lucide-react';
import type { BulkArchiveActionResult } from './bulk-archive.client';
import { describeBulkArchiveSkips } from '@sewing/shared/archive';

export interface ArchiveCardButtonsProps {
  id: string;
  /** Запись уже в архиве — показываем «Вернуть» + «Удалить навсегда». */
  archived: boolean;
  /** Название записи для текста подтверждения. */
  name: string;
  /** Куда уйти после безвозвратного удаления. */
  listHref: string;
  archive: (ids: string[]) => Promise<BulkArchiveActionResult>;
  restore: (ids: string[]) => Promise<BulkArchiveActionResult>;
  purge: (ids: string[]) => Promise<BulkArchiveActionResult>;
  /** Что пропадёт при удалении навсегда (хвост фразы подтверждения). */
  purgeHint?: string;
  /** Что произойдёт при архивации (хвост фразы подтверждения). */
  archiveHint?: string;
}

export function ArchiveCardButtons({
  id,
  archived,
  name,
  listHref,
  archive,
  restore,
  purge,
  purgeHint,
  archiveHint,
}: ArchiveCardButtonsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (
    kind: 'archive' | 'restore' | 'purge',
    question: string,
    action: (ids: string[]) => Promise<BulkArchiveActionResult>,
  ) => {
    if (!window.confirm(question)) return;
    setError(null);
    startTransition(async () => {
      const res = await action([id]);
      if (!res.ok) {
        setError(res.error ?? 'Не удалось выполнить операцию.');
        return;
      }
      if (res.skipped.length > 0) {
        // Пропуск на одной записи = операция не выполнена; причина
        // куда полезнее, чем молчаливое «ничего не произошло».
        setError(describeBulkArchiveSkips(res.skipped));
        return;
      }
      if (kind === 'purge') {
        router.push(listHref);
      }
      router.refresh();
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="admin-actions-row">
        {archived ? (
          <>
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              disabled={pending}
              aria-busy={pending}
              onClick={() =>
                run(
                  'restore',
                  `Вернуть «${name}» из архива? Запись снова появится в активном списке.`,
                  restore,
                )
              }
            >
              <RotateCcw size={16} strokeWidth={1.6} aria-hidden />
              Вернуть из архива
            </button>
            <button
              type="button"
              className="admin-btn admin-btn--danger"
              disabled={pending}
              aria-busy={pending}
              onClick={() =>
                run(
                  'purge',
                  `Удалить «${name}» НАВСЕГДА? ${purgeHint ?? ''} Отменить нельзя.`,
                  purge,
                )
              }
            >
              <Trash2 size={16} strokeWidth={1.6} aria-hidden />
              Удалить навсегда
            </button>
          </>
        ) : (
          <button
            type="button"
            className="admin-btn admin-btn--danger"
            disabled={pending}
            aria-busy={pending}
            onClick={() =>
              run(
                'archive',
                `Отправить «${name}» в архив? ${
                  archiveHint ?? 'Данные сохранятся.'
                } Вернуть можно во вкладке «Архив».`,
                archive,
              )
            }
          >
            <Archive size={16} strokeWidth={1.6} aria-hidden />
            {pending ? 'Архивируем…' : 'В архив'}
          </button>
        )}
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
