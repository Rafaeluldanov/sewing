'use client';

/**
 * Сворачиваемый блок «Потребность цеха» на вкладке «Потребности»
 * (фича «Варианты просчёта»).
 *
 * Верхняя часть (заголовок + чей вариант + сводка + действия) видна
 * всегда; список материалов (`OrderMaterialsUnifiedTable`, server-
 * компонент) передаётся как `children` и прячется под «Развернуть».
 * По умолчанию свёрнут — вкладка не встречает менеджера простынёй, а
 * сводка сверху даёт быстрый обзор.
 *
 * Компонент client только ради сворачивания; сами данные и таблица —
 * серверные (children рендерится на сервере и переключается видимостью,
 * без повторного fetch на клиенте).
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, Wrench } from 'lucide-react';

interface SummaryItem {
  label: string;
  value: string;
}

interface Props {
  /** Заголовок блока (обычно «Потребность цеха»). */
  title: string;
  /** Число строк потребности — бейдж у заголовка. */
  count: number;
  /** Чей вариант просчёта (например «Вариант 1 · активный»). */
  variantLabel?: string | null;
  /** Компактная сводка (материалы Σ / с ценой / к закупке). */
  summary?: SummaryItem[];
  /** Кнопки действий расчёта (уже готовые компоненты). */
  actions?: ReactNode;
  /** Список материалов — server-компонент, прячется под разворотом. */
  children: ReactNode;
  /** Открыт ли список по умолчанию (по умолчанию свёрнут). */
  defaultOpen?: boolean;
}

export function OrderNeedsCollapsible({
  title,
  count,
  variantLabel,
  summary,
  actions,
  children,
  defaultOpen = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="needs-collapsible" data-open={open || undefined}>
      <div className="needs-collapsible__head">
        <div className="needs-collapsible__title-row">
          <Wrench size={18} strokeWidth={1.8} aria-hidden />
          <span className="needs-collapsible__title">{title}</span>
          <span className="needs-collapsible__count">{count}</span>
          {variantLabel ? (
            <span className="needs-collapsible__variant">{variantLabel}</span>
          ) : null}
          {actions ? (
            <div className="needs-collapsible__actions">{actions}</div>
          ) : null}
        </div>
        {summary && summary.length > 0 ? (
          <div className="needs-collapsible__summary">
            {summary.map((s) => (
              <div key={s.label} className="needs-collapsible__sum">
                <span className="needs-collapsible__sum-k">{s.label}</span>
                <span className="needs-collapsible__sum-v">{s.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="needs-collapsible__body">{children}</div>
      ) : null}

      <button
        type="button"
        className="needs-collapsible__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Свернуть список материалов' : 'Развернуть список материалов'}
        <ChevronDown
          size={16}
          strokeWidth={2}
          aria-hidden
          className="needs-collapsible__chev"
        />
      </button>
    </section>
  );
}
