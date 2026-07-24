'use client';

import { useRouter } from 'next/navigation';
import type { CSSProperties, ReactNode } from 'react';

/**
 * Кликабельная «карточка/строка» для кастомных списков (вне AdminTable):
 * клик по всей области ведёт на `href`, как кнопка «Открыть» внутри неё.
 * Клики по вложенным ссылкам/кнопкам/полям работают сами по себе и НЕ
 * навигируют.
 *
 * Когда использовать это, а когда обычный `<Link>`:
 *   - если карточка НЕ содержит других интерактивных элементов (кнопок,
 *     ссылок, форм) — оберните её целиком в `<Link href>` (валиднее и проще,
 *     как в constructor-board/cutter-board);
 *   - если внутри есть свои кнопки/ссылки/поля — вложенный `<a>` невалиден,
 *     поэтому используйте этот компонент (он навигирует по `router.push`,
 *     пропуская клики по вложенному интерактиву).
 *
 * Чтобы конкретный элемент внутри НЕ навигировал (и при этом не был
 * ссылкой/кнопкой), повесьте на него атрибут `data-no-row-nav`.
 */
const INTERACTIVE =
  'a, button, input, select, textarea, label, [role="button"], [data-no-row-nav]';

export function ClickableCard({
  href,
  children,
  className,
  style,
  ariaLabel,
  as = 'div',
}: {
  href: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  /** Тег-обёртка. По умолчанию `div`; для списка можно `li`. */
  as?: 'div' | 'li';
}) {
  const router = useRouter();
  const Tag = as;
  return (
    <Tag
      className={className}
      style={{ cursor: 'pointer', ...style }}
      role="link"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
        if (window.getSelection()?.toString()) return;
        router.push(href);
      }}
      onKeyDown={(e) => {
        // Реагируем только на нажатие по самой карточке, не по вложенному фокусу.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          router.push(href);
        }
      }}
    >
      {children}
    </Tag>
  );
}
