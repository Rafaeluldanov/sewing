import type { ReactNode } from 'react';

export interface ProductionEmptyStateProps {
  /** Заголовок (большой текст в первой строке). */
  title: ReactNode;
  /** Подсказка под заголовком. Опционально. */
  hint?: ReactNode;
  /** Доп. CSS-класс. */
  className?: string;
}

/**
 * `ProductionEmptyState` — мягкий empty state для рабочих мест.
 *
 * Использует канонический CSS-класс `.card.empty` из `globals.css`,
 * который уже применяется в `/cut-orders`, `/packing`, `qc-card` и
 * т.д. Никаких новых стилей не вводим — это «семантическая обёртка»
 * над существующим визуалом, см. `docs/design-cleanup-recon.md §5`.
 */
export function ProductionEmptyState({
  title,
  hint,
  className,
}: ProductionEmptyStateProps) {
  const cls = `card empty${className ? ` ${className}` : ''}`;
  return (
    <div className={cls} role="status">
      <div className="production-empty__title">{title}</div>
      {hint ? <p className="production-empty__hint">{hint}</p> : null}
    </div>
  );
}

export interface ProductionErrorStateProps {
  /** Сообщение об ошибке. */
  message: ReactNode;
  /** Идентификатор запроса для поддержки (если есть). */
  requestId?: string;
  /** Подсказка «что делать дальше». */
  hint?: ReactNode;
  /** Доп. CSS-класс. */
  className?: string;
}

/**
 * `ProductionErrorState` — стандартный `.error-box` с requestId и
 * опциональным hint'ом. Полностью повторяет паттерн из
 * `seamstress-active-panel.tsx`, `qc-terminal.tsx`, `wto-terminal.tsx`,
 * `packing-terminal.tsx` — поэтому оборачиваем в один компонент
 * вместо повторения трёх `<div>` каждый раз.
 */
export function ProductionErrorState({
  message,
  requestId,
  hint,
  className,
}: ProductionErrorStateProps) {
  const cls = `error-box${className ? ` ${className}` : ''}`;
  return (
    <div className={cls} role="alert">
      <div className="error-box__msg">{message}</div>
      {hint ? <div className="error-box__hint">{hint}</div> : null}
      {requestId ? (
        <div className="error-box__rid">
          req: <code>{requestId}</code>
        </div>
      ) : null}
    </div>
  );
}

export interface ProductionLoadingStateProps {
  /**
   * Текст «Загрузка…» / «Сохраняем…» / своё сообщение. По умолчанию
   * — «Загрузка…», чтобы экран не молчал.
   */
  label?: ReactNode;
  /** Доп. CSS-класс. */
  className?: string;
}

/**
 * `ProductionLoadingState` — лёгкий inline-loader для секций.
 *
 * На рабочих терминалах full-screen spinner-ов по дизайну нет
 * (см. `docs/ui-mobile.md` — pending-state живёт прямо на кнопке как
 * label «Сохраняем…»). Этот компонент используется в редких местах,
 * где нужно показать «грузим список» в server-component fallback /
 * suspense — например, в новых secondary-секциях.
 */
export function ProductionLoadingState({
  label,
  className,
}: ProductionLoadingStateProps) {
  const cls = `production-loading${className ? ` ${className}` : ''}`;
  return (
    <p className={cls} role="status" aria-live="polite">
      {label ?? 'Загрузка…'}
    </p>
  );
}
