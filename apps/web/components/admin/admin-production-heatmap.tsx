/**
 * `AdminProductionHeatmap` — визуальная «тепловая карта» потока
 * операций для верхнего блока `/admin`.
 *
 * Показывает горизонтальную линейку чипов: Крой → sewing-операции →
 * ОТК → ВТО → Упаковка → Готово. Под каждым чипом — два числа:
 * ▶ inProgress (физически на станке) и ✔ done (буфер ждёт следующую
 * операцию). Цветовая градация — `pickHeatmapTone` в
 * `lib/admin-analytics.ts`.
 *
 * Компонент намеренно server-friendly: никакого client-state, никакого
 * polling'а внутри. Если на странице нужен живой режим, родитель
 * перерисовывает страницу через `dynamic = 'force-dynamic'` или
 * `revalidate`. Анимаций здесь нет — `transition: 160ms` живёт в CSS.
 *
 * Данные собирает `buildProductionHeatmap(displaySummary)` — компонент
 * только раскрашивает.
 */

import type { HeatmapCell } from '@/lib/admin-analytics';

interface AdminProductionHeatmapProps {
  cells: HeatmapCell[];
  /** Подпись блока (например, «Тепловая карта потока»). */
  title?: string;
  /** Подзаголовок (например, дата/время среза). */
  subtitle?: string;
  /** Полностью спрятать legend (по умолчанию показываем). */
  hideLegend?: boolean;
}

const TONE_LABEL: Record<HeatmapCell['tone'], string> = {
  muted: 'Тихо',
  blue: '1–9',
  green: '10–29',
  orange: '30+',
  coral: 'Узкое место',
};

const TONE_VAR: Record<HeatmapCell['tone'], string> = {
  muted: 'var(--admin-soft)',
  blue: 'var(--admin-blue-soft)',
  green: 'var(--admin-green-soft)',
  orange: 'var(--admin-orange-soft)',
  coral: 'var(--admin-coral-soft)',
};

export function AdminProductionHeatmap({
  cells,
  title,
  subtitle,
  hideLegend,
}: AdminProductionHeatmapProps) {
  if (cells.length === 0) {
    return (
      <div className="admin-heatmap" data-testid="admin-heatmap-empty">
        <p className="admin-muted">
          Данных потока пока нет — backend ещё не отдал срез.
        </p>
      </div>
    );
  }
  return (
    <div className="admin-heatmap">
      {(title || subtitle) && (
        <div>
          {title && <h2 className="admin-section-title">{title}</h2>}
          {subtitle && (
            <p className="admin-muted" style={{ marginTop: 2, fontSize: '0.88rem' }}>
              {subtitle}
            </p>
          )}
        </div>
      )}
      <div className="admin-heatmap__row" role="list">
        {cells.map((cell) => (
          <div
            key={cell.key}
            role="listitem"
            className={`admin-heatmap__chip admin-heatmap__chip--${cell.tone}`}
            aria-label={`${cell.label}: в работе ${cell.inProgress}, в буфере ${cell.done}, всего ${cell.total}${cell.isBottleneck ? ', узкое место' : ''}`}
            data-bottleneck={cell.isBottleneck ? 'true' : undefined}
          >
            <span className="admin-heatmap__chip-label">{cell.label}</span>
            <span className="admin-heatmap__chip-stats">
              <span className="admin-heatmap__chip-stat" title="В работе">
                <span aria-hidden>▶</span>
                <strong>{cell.inProgress.toLocaleString('ru-RU')}</strong>
              </span>
              <span className="admin-heatmap__chip-stat" title="Ждёт следующую операцию">
                <span aria-hidden>✔</span>
                <strong>{cell.done.toLocaleString('ru-RU')}</strong>
              </span>
            </span>
          </div>
        ))}
      </div>
      {!hideLegend && (
        <div className="admin-heatmap__legend" aria-label="Легенда">
          {(Object.keys(TONE_LABEL) as Array<HeatmapCell['tone']>).map((t) => (
            <span key={t} className="admin-heatmap__legend-dot">
              <span
                className="admin-heatmap__legend-swatch"
                style={{ background: TONE_VAR[t] }}
                aria-hidden
              />
              {TONE_LABEL[t]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
