'use client';

/**
 * Невидимый host модалки клонирования. Открывает `ClonePatternModal`
 * автоматически, если URL содержит `?clone=1` — это deep-link из
 * `/admin/constructor-tasks/[id]` (кнопка «Создать ещё одну
 * номенклатуру» в секции «Готовые лекала»). После закрытия модалки
 * убирает `?clone=1` из URL, чтобы кнопка «Назад» не вернула на ту же
 * открытую модалку.
 *
 * На самой карточке `/admin/patterns/[id]` отдельной видимой кнопки
 * «Клонировать» нет — клонирование инициируется только из карточки
 * задачи КБ.
 */

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ClonePatternModal } from './clone-modal';

interface Props {
  patternId: string;
  patternName: string;
  patternArticle: string;
}

export function ClonePatternModalHost({
  patternId,
  patternName,
  patternArticle,
}: Props) {
  const [open, setOpen] = useState(false);
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (searchParams?.get('clone') === '1') {
      setOpen(true);
    }
  }, [searchParams]);

  if (!open) return null;
  return (
    <ClonePatternModal
      patternId={patternId}
      suggestedName={`${patternName} (копия)`}
      suggestedArticle={`${patternArticle}-2`}
      onClose={() => {
        setOpen(false);
        if (searchParams?.get('clone') === '1' && pathname) {
          router.replace(pathname);
        }
      }}
    />
  );
}
