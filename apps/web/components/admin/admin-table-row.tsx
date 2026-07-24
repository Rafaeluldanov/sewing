'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Кликабельная строка `AdminTable`: клик по всей строке ведёт на `href`
 * (как кнопка «Открыть»), но клики по вложенным интерактивным элементам
 * (ссылки, кнопки, поля ввода, чекбоксы, `<label>`) работают как обычно и
 * НЕ навигируют.
 *
 * Почему не оборачиваем `<tr>` в `<a>`: HTML не разрешает `<a>` вокруг `<tr>`.
 * Поэтому навигация — через `router.push` по `onClick`, а сама ссылка
 * «Открыть» внутри строки остаётся: она даёт доступность с клавиатуры,
 * открытие в новой вкладке (Cmd/Ctrl+клик, средняя кнопка) и явную афформанс.
 *
 * Чтобы отдельный элемент строки НЕ навигировал (но и не был ссылкой/кнопкой),
 * повесьте на него атрибут `data-no-row-nav`.
 */
const INTERACTIVE =
  'a, button, input, select, textarea, label, [role="button"], [data-no-row-nav]';

export function AdminTableRow({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const router = useRouter();
  return (
    <tr
      className={className}
      onClick={(e) => {
        // Клик по вложенному интерактиву (ссылка/кнопка/поле) — не перехватываем.
        if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
        // Пользователь выделяет текст мышью — не навигируем.
        if (window.getSelection()?.toString()) return;
        router.push(href);
      }}
    >
      {children}
    </tr>
  );
}
