'use client';

/**
 * PatternHeroPreview — крупное превью лекала, которое стоит «героем»
 * справа сверху на форме создания/редактирования заказа.
 *
 * Источник правды по полям лекала — `PatternListItemDto` из
 * `@sewing/shared/patterns`. Компонент чисто визуальный и не зависит
 * от `next/image` (см. комментарий ниже про `/uploads/*` на api).
 *
 * Поведение:
 *   - если `pattern === null` (лекало не выбрано) — рисуем большой
 *     placeholder с иконкой ножниц + подсказку «Выберите лекало в
 *     блоке „Изделие"»;
 *   - если у лекала есть `previewImageUrl` — отображаем картинку с
 *     `object-fit: contain` в области ~240px по высоте, чтобы изделие
 *     никогда не обрезалось;
 *   - если картинка битая (404 / network) — переключаемся в
 *     placeholder через `onError`, чтобы UI не оставался с broken img.
 *
 * Native `<img>` использован сознательно: `next/image` потребовал бы
 * прописать домен `/uploads` (api) в `next.config.js` и оптимизирует
 * мало пользы для одного превью на форме. Совместимо с тем, как
 * рисуются превью на `/admin/patterns` (см. `PatternPreviewThumb`).
 */
import { useEffect, useState } from 'react';
import { Scissors } from 'lucide-react';
import type { PatternListItemDto } from '@sewing/shared/patterns';

interface Props {
  pattern: PatternListItemDto | null;
}

export function PatternHeroPreview({ pattern }: Props) {
  const [imageError, setImageError] = useState(false);

  // Сбрасываем флаг ошибки при смене лекала — иначе после битой
  // картинки следующий выбор тоже останется в placeholder.
  useEffect(() => {
    setImageError(false);
  }, [pattern?.id]);

  const showImage = Boolean(pattern?.previewImageUrl) && !imageError;

  return (
    <div className="admin-pattern-hero">
      <div className="admin-pattern-hero__media">
        {showImage && pattern?.previewImageUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={pattern.previewImageUrl}
            alt={pattern.name}
            className="admin-pattern-hero__image"
            onError={() => setImageError(true)}
          />
        ) : (
          <div
            className="admin-pattern-hero__placeholder"
            role="img"
            aria-label={
              pattern ? 'Превью лекала отсутствует' : 'Лекало не выбрано'
            }
          >
            <Scissors size={42} strokeWidth={1.4} aria-hidden />
            <span>{pattern ? 'Превью отсутствует' : 'Лекало не выбрано'}</span>
          </div>
        )}
      </div>
      <div className="admin-pattern-hero__meta">
        {pattern ? (
          <>
            <span className="admin-pattern-hero__title">{pattern.name}</span>
            <span className="admin-pattern-hero__article">
              {pattern.article}
            </span>
          </>
        ) : (
          <span className="admin-pattern-hero__hint">
            Выберите лекало в блоке «Изделие», чтобы увидеть превью.
          </span>
        )}
      </div>
    </div>
  );
}
