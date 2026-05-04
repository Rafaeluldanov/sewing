import type { ReactNode } from 'react';

export interface ScanPanelProps {
  /** Заголовок крупным шрифтом (`.scan-card__title`). */
  title: ReactNode;
  /**
   * Подсказка одной строкой (`.scan-card__hint`). Опционально, но
   * рекомендуется — у каждого терминала своя инструкция «что
   * сканировать».
   */
  hint?: ReactNode;
  /**
   * Слот под основные действия: primary `.btn-lg.btn-block`, error/info
   * боксы, secondary `.btn-block`, ручной ввод и т.д. Шаблон
   * содержимого — см. `apps/web/app/qc/qc-terminal.tsx` или
   * `apps/web/app/wto/wto-terminal.tsx`, мы намеренно не зашиваем
   * структуру в компонент, чтобы переиспользовать существующие
   * scan-flow без рефакторинга.
   */
  children: ReactNode;
  /**
   * `aria-label` контейнера. Полезно, когда заголовок включает иконку
   * — чтобы скринридер прочитал понятный текст.
   */
  ariaLabel?: string;
  /**
   * Дополнительный CSS-класс для модификаторов (например,
   * `cutter-scan` или `wto-scan`).
   */
  className?: string;
}

/**
 * `ScanPanel` — мягкая `.scan-card.scan-card--simple` секция с
 * заголовком и хинтом, под которой терминал размещает свои кнопки и
 * формы.
 *
 * Это главный «кирпич» рабочих мест: одна и та же визуальная
 * семантика на `/work` (швея + помощник), `/qc`, `/wto`, `/packing`.
 * Обёртка существует, чтобы новый код не повторял «оголённый»
 * `<div className="scan-card scan-card--simple">` руками — это
 * единственное упрощение, никаких новых стилей не вводим.
 *
 * Канонические примеры:
 *   - `apps/web/app/work/seamstress-active-panel.tsx`;
 *   - `apps/web/app/qc/qc-terminal.tsx` (`QcScanTerminal`);
 *   - `apps/web/app/wto/wto-terminal.tsx` (`WtoScanTerminal`);
 *   - `apps/web/app/packing/packing-terminal.tsx`
 *     (`PackingMainTerminal`).
 */
export function ScanPanel({
  title,
  hint,
  children,
  ariaLabel,
  className,
}: ScanPanelProps) {
  const cls = `scan-card scan-card--simple${className ? ` ${className}` : ''}`;
  return (
    <div className={cls} aria-label={ariaLabel}>
      <div>
        <h2 className="scan-card__title">{title}</h2>
        {hint ? <p className="scan-card__hint">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}
