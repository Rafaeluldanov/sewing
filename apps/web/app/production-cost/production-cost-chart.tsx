/**
 * Лёгкий SVG-чарт «Себестоимость выпуска по дням» (см. `docs/screens.md §17`).
 *
 * Намеренно без внешних зависимостей (`recharts` etc.): экран — read-only
 * управленческий, на нём 14–60 точек, и три простые линии. Любая
 * библиотека графиков для такого набора — overkill, ломает SSR-онли
 * сценарий и тащит client bundle.
 *
 * Линии:
 *   - выпущено единиц (производство, зелёная);
 *   - себестоимость, ₽ (синяя);
 *   - простой, ₽ (красная).
 *
 * Каждая линия имеет отдельный масштаб по Y (производство в штуках,
 * деньги в рублях) — рисуем нормированно [0..1] от max этой серии,
 * чтобы они вообще были сопоставимы на одном холсте. Точные числа
 * берутся из таблицы ниже на странице.
 */

import type { ProductionCostDayDto } from '@sewing/shared/costs';

interface ProductionCostChartProps {
  days: ProductionCostDayDto[];
}

const WIDTH = 720;
const HEIGHT = 260;
const PADDING = { top: 16, right: 16, bottom: 28, left: 32 };

interface Series {
  key: 'producedUnits' | 'totalCost' | 'idleCost';
  label: string;
  color: string;
  unit: 'шт' | '₽';
}

const SERIES: Series[] = [
  { key: 'producedUnits', label: 'Выпущено', color: '#15803d', unit: 'шт' },
  { key: 'totalCost', label: 'Себестоимость', color: '#1d4ed8', unit: '₽' },
  { key: 'idleCost', label: 'Простой', color: '#b91c1c', unit: '₽' },
];

export function ProductionCostChart({ days }: ProductionCostChartProps) {
  if (days.length === 0) {
    return (
      <div className="card empty" style={{ height: HEIGHT }}>
        За выбранный период данных нет.
      </div>
    );
  }

  const innerW = WIDTH - PADDING.left - PADDING.right;
  const innerH = HEIGHT - PADDING.top - PADDING.bottom;

  const maxByKey: Record<Series['key'], number> = {
    producedUnits: Math.max(1, ...days.map((d) => d.producedUnits)),
    totalCost: Math.max(1, ...days.map((d) => d.totalCost)),
    idleCost: Math.max(1, ...days.map((d) => d.idleCost)),
  };
  // Если одна из серий = 0 на всём периоде, шкалу искусственно держим
  // > 0, чтобы не делить на ноль.
  for (const k of Object.keys(maxByKey) as Array<Series['key']>) {
    if (maxByKey[k] <= 0) maxByKey[k] = 1;
  }

  const xFor = (i: number): number => {
    if (days.length === 1) return PADDING.left + innerW / 2;
    return PADDING.left + (i / (days.length - 1)) * innerW;
  };
  const yFor = (value: number, key: Series['key']): number => {
    const scaled = value / maxByKey[key];
    return PADDING.top + innerH * (1 - scaled);
  };

  const buildPath = (key: Series['key']): string => {
    return days
      .map((d, i) => {
        const x = xFor(i);
        const y = yFor(d[key], key);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  };

  // Ось X: показываем первую/последнюю/среднюю дату, чтобы не
  // забивать пиксели подписями.
  const xLabels: Array<{ x: number; label: string }> = [];
  if (days.length > 0) {
    xLabels.push({ x: xFor(0), label: formatTick(days[0].date) });
  }
  if (days.length > 2) {
    const mid = Math.floor((days.length - 1) / 2);
    xLabels.push({ x: xFor(mid), label: formatTick(days[mid].date) });
  }
  if (days.length > 1) {
    xLabels.push({
      x: xFor(days.length - 1),
      label: formatTick(days[days.length - 1].date),
    });
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="График себестоимости выпуска по дням"
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        {/* Сетка: 4 горизонтальные линии (0/25/50/75/100% относительной шкалы). */}
        {[0, 0.25, 0.5, 0.75, 1].map((p) => {
          const y = PADDING.top + innerH * (1 - p);
          return (
            <line
              key={p}
              x1={PADDING.left}
              x2={PADDING.left + innerW}
              y1={y}
              y2={y}
              stroke="#e5e7eb"
              strokeWidth={1}
            />
          );
        })}
        {/* Линии серий. */}
        {SERIES.map((s) => (
          <path
            key={s.key}
            d={buildPath(s.key)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {/* Точки. */}
        {SERIES.map((s) =>
          days.map((d, i) => (
            <circle
              key={`${s.key}-${i}`}
              cx={xFor(i)}
              cy={yFor(d[s.key], s.key)}
              r={2.5}
              fill={s.color}
            >
              <title>
                {`${formatTick(d.date)}: ${s.label} = ${formatNumber(d[s.key])} ${s.unit}`}
              </title>
            </circle>
          )),
        )}
        {/* Подписи дат по оси X. */}
        {xLabels.map((t, i) => (
          <text
            key={i}
            x={t.x}
            y={HEIGHT - 8}
            fontSize={11}
            textAnchor="middle"
            fill="#6b7280"
          >
            {t.label}
          </text>
        ))}
      </svg>
      {/* Легенда. */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
          marginTop: '0.5rem',
          fontSize: '0.85rem',
          color: 'var(--text-muted, #6b7280)',
        }}
      >
        {SERIES.map((s) => (
          <span
            key={s.key}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 12,
                height: 12,
                borderRadius: 3,
                background: s.color,
              }}
            />
            {s.label} ({s.unit})
          </span>
        ))}
      </div>
    </div>
  );
}

function formatTick(date: string): string {
  const [, mm, dd] = date.split('-');
  if (!mm || !dd) return date;
  return `${dd}.${mm}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('ru-RU', {
    maximumFractionDigits: 2,
  });
}
