/**
 * Icon — единая система иконок для нового UI refresh.
 *
 * Намеренно НЕ ставим внешнюю иконочную библиотеку:
 *   - lucide-react добавил бы 200+ kB в bundle и зависимость, которую
 *     надо ставить через npm install (а это несовместимо с офлайн
 *     production-сборкой и нашим монорепом без частых деплоев);
 *   - нужен ограниченный набор символов (~30 штук), которые легко
 *     описать как inline SVG и кэшировать как часть JS.
 *
 * Стиль повторяет Lucide / Tabler:
 *   - 24x24 viewBox, stroke-based outline,
 *   - `currentColor` для stroke и fill,
 *   - размер прокидывается через `size` (по умолчанию 18 px) или
 *     CSS, fill наследует `color` родителя.
 *
 * Использование:
 *   <Icon name="dashboard" />
 *   <Icon name="orders" size={20} className="action-card__icon-svg" />
 *
 * Если нужно добавить новую иконку — добавьте path в `ICON_PATHS`.
 * Имена согласованы с предметной областью (orders, packing, qc, …),
 * а не с метафорой (box, scissors, …) — так UI самодокументируется.
 */
import type { SVGProps } from 'react';

export type IconName =
  // Навигация
  | 'home'
  | 'dashboard'
  | 'orders'
  | 'shopfloor'
  | 'production-cost'
  | 'earnings'
  | 'employees'
  | 'operations'
  | 'warehouses'
  | 'equipment'
  | 'overview'
  // Производственные роли
  | 'work'
  | 'qc'
  | 'wto'
  | 'packing'
  | 'cutting'
  | 'sewing'
  // Состояния
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'bottleneck'
  | 'idle'
  | 'output'
  | 'price'
  // Действия
  | 'scan'
  | 'edit'
  | 'reset'
  | 'save'
  | 'filter'
  | 'period'
  | 'arrow-right'
  | 'plus'
  | 'logout'
  | 'refresh'
  | 'search'
  | 'login'
  // Прочее
  | 'sparkle'
  | 'pulse';

interface PathSpec {
  d?: string;
  /** Опциональная второй path/circle/line для иконок с несколькими сегментами. */
  extra?: string;
}

/**
 * Outline-пути для каждой иконки. Скопированы / адаптированы со
 * стиля Lucide (24x24, stroke 2). Где это уместно, упрощены — нам
 * нужна узнаваемость, а не точная копия. Все пути нарисованы рукой
 * для этого репозитория, чтобы не тащить лицензию.
 */
const ICON_PATHS: Record<IconName, PathSpec> = {
  home: { d: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z' },
  dashboard: {
    d: 'M3 13a9 9 0 0 1 18 0',
    extra:
      '<path d="M12 13l4-3" /><circle cx="12" cy="13" r="1.4" /><path d="M5 19h14" />',
  },
  orders: {
    d: 'M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    extra: '<path d="M8 9h7M8 13h7M8 17h5" />',
  },
  shopfloor: {
    d: 'M3 21h18M5 21V10l5-3 4 3v11M14 21V13l5-2v10',
    extra: '<path d="M8 21v-4M11 21v-4" />',
  },
  'production-cost': {
    d: 'M4 19V5M4 19h16',
    extra:
      '<path d="M7 16V11M11 16V8M15 16v-3M19 16V6" /><circle cx="7" cy="11" r="1.2" /><circle cx="11" cy="8" r="1.2" /><circle cx="15" cy="13" r="1.2" /><circle cx="19" cy="6" r="1.2" />',
  },
  earnings: {
    d: 'M12 3v18',
    extra:
      '<path d="M16 7a4 4 0 0 0-4-2H8.5a3.5 3.5 0 0 0 0 7H15a3.5 3.5 0 0 1 0 7h-4a4 4 0 0 1-4-2" />',
  },
  employees: {
    d: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    extra:
      '<path d="M2 21a7 7 0 0 1 14 0" /><path d="M17 11a3 3 0 1 0 0-6" /><path d="M22 21a5 5 0 0 0-5-5" />',
  },
  operations: {
    d: 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6 7.7 7.7M16.3 16.3l2.1 2.1M5.6 18.4 7.7 16.3M16.3 7.7l2.1-2.1',
    extra: '<circle cx="12" cy="12" r="3.5" />',
  },
  warehouses: {
    d: 'M3 21V9l9-5 9 5v12',
    extra:
      '<path d="M7 21v-7h10v7" /><path d="M9 14v7M15 14v7" />',
  },
  equipment: {
    d: 'M4 7h6v3H4z',
    extra:
      '<path d="M14 4h6v6h-6z" /><path d="M4 14h16v6H4z" /><path d="M10 8.5h4M17 10v4" />',
  },
  overview: {
    d: 'M3 5h7v6H3zM14 5h7v9h-7zM3 14h7v6H3zM14 17h7v3h-7z',
  },
  work: {
    d: 'M9 4h6l1 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h3z',
    extra: '<circle cx="12" cy="14" r="3" /><path d="M11 11v-1h2v1" />',
  },
  qc: {
    d: 'M5 12l4 4 10-10',
    extra:
      '<path d="M21 12a9 9 0 1 1-3-6.7" />',
  },
  wto: {
    d: 'M4 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0',
    extra:
      '<path d="M4 13c2-2 4-2 6 0s4 2 6 0 4-2 6 0" /><path d="M4 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0" />',
  },
  packing: {
    d: 'M3 8.5 12 4l9 4.5v8L12 21l-9-4.5z',
    extra:
      '<path d="M3 8.5 12 13l9-4.5M12 13v8M7.5 6.25 16.5 10.75" />',
  },
  cutting: {
    d: 'M8.5 6.5 21 19',
    extra:
      '<path d="M15.5 6.5 3 19" /><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" />',
  },
  sewing: {
    d: 'M4 6h16v12H4z',
    extra:
      '<path d="M4 12h16M8 9v6M16 9v6" />',
  },
  success: {
    d: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
    extra: '<path d="M8 12.5l3 3 5-6" />',
  },
  warning: {
    d: 'M12 3 2.5 20h19z',
    extra: '<path d="M12 10v5M12 18v.5" />',
  },
  error: {
    d: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
    extra: '<path d="M9 9l6 6M15 9l-6 6" />',
  },
  info: {
    d: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
    extra: '<path d="M12 11v5M12 8v.5" />',
  },
  bottleneck: {
    d: 'M5 4h14l-5 7v6l-4 2v-8z',
    extra: '',
  },
  idle: {
    d: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
    extra: '<path d="M12 7v6l3 2" />',
  },
  output: {
    d: 'M3 17l6-10 4 6 4-3 4 7',
    extra: '<path d="M3 21h18" />',
  },
  price: {
    d: 'M3 13l8.5-8.5a2 2 0 0 1 1.4-.6H20a1 1 0 0 1 1 1v7.1a2 2 0 0 1-.6 1.4L11.9 22a1 1 0 0 1-1.4 0L3 14.4a1 1 0 0 1 0-1.4z',
    extra: '<circle cx="16" cy="8" r="1.4" />',
  },
  scan: {
    d: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3',
    extra: '<path d="M4 12h16" />',
  },
  edit: {
    d: 'M4 20h4l11-11-4-4L4 16z',
    extra: '<path d="M14 6l4 4" />',
  },
  reset: {
    d: 'M4 12a8 8 0 1 1 2.3 5.7',
    extra: '<path d="M4 19v-5h5" />',
  },
  save: {
    d: 'M5 4h11l3 3v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    extra:
      '<path d="M8 4v5h7V4" /><path d="M8 20v-7h8v7" />',
  },
  filter: {
    d: 'M3 5h18l-7 9v6l-4-2v-4z',
  },
  period: {
    d: 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
    extra:
      '<path d="M4 10h16M9 3v4M15 3v4" />',
  },
  'arrow-right': {
    d: 'M5 12h14M13 6l6 6-6 6',
  },
  plus: {
    d: 'M12 5v14M5 12h14',
  },
  logout: {
    d: 'M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4',
    extra: '<path d="M16 8l4 4-4 4M20 12H10" />',
  },
  refresh: {
    d: 'M21 12a9 9 0 1 1-3-6.7',
    extra: '<path d="M21 4v5h-5" />',
  },
  search: {
    d: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
    extra: '<path d="M16 16l5 5" />',
  },
  login: {
    d: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4',
    extra: '<path d="M10 8l4 4-4 4M14 12H4" />',
  },
  sparkle: {
    d: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
    extra: '<path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />',
  },
  pulse: {
    d: 'M3 12h4l3-7 4 14 3-7h4',
  },
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number | string;
  /** Толщина обводки (по умолчанию 1.8 — чуть тоньше чем Lucide). */
  strokeWidth?: number;
}

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.8,
  className,
  ...rest
}: IconProps) {
  const spec = ICON_PATHS[name];
  if (!spec) return null;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `app-icon ${className}` : 'app-icon'}
      aria-hidden="true"
      focusable="false"
      {...rest}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{
        __html: `${spec.d ? `<path d="${spec.d}" />` : ''}${spec.extra ?? ''}`,
      }}
    />
  );
}
