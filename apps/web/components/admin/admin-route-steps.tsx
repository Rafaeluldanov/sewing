/**
 * AdminRouteSteps — компактная цепочка операций маршрута.
 *
 * Используется на `/admin/routes` (превью первых N шагов в строке
 * таблицы) и `/admin/routes/[id]` (полная цепочка в карточке
 * «Операции маршрута»). Между шагами — мягкая стрелка `→`, на mobile
 * чипы переносятся (`flex-wrap`).
 *
 * Контракт сознательно простой:
 *   - `steps`: массив шагов с минимальным набором полей
 *     (`name`, `index`, `category?`);
 *   - `maxVisible`: ограничение на количество показанных шагов;
 *     если шагов больше — последний чип превращается в `+ ещё N`;
 *   - `dense`: если `true`, чипы становятся ещё компактнее
 *     (для строки таблицы).
 *
 * Никаких code/id в чипах — только человеческое название и иконка
 * категории. Технические поля живут в AdminTechInfo.
 */
import {
  Activity,
  ArrowLeftRight,
  CheckCircle2,
  Flame,
  Package,
  Scissors,
  type LucideIcon,
} from 'lucide-react';

export interface AdminRouteStep {
  /** Стабильный ключ для React (operationId или id шага). */
  id: string;
  /** Порядковый номер шага начиная с 1. */
  index: number;
  /** Человеческое название операции, без code. */
  name: string;
  /** Enum категории (CUTTING/SEWING/QC/IRONING/PACKING). Может быть пустым. */
  category?: string | null;
  /**
   * Номер параллельной (взаимозаменяемой) группы или `null`. Соседние
   * шаги с одинаковым ненулевым значением соединяются значком ⇄ вместо
   * стрелки → (порядок между ними любой).
   */
  parallelGroup?: number | null;
}

interface AdminRouteStepsProps {
  steps: readonly AdminRouteStep[];
  /** Максимум видимых чипов (остальные сворачиваются в «+ ещё N»). */
  maxVisible?: number;
  /** Компактный вариант для использования внутри строки таблицы. */
  dense?: boolean;
  /** ARIA-label для контейнера. */
  ariaLabel?: string;
}

/**
 * Иконка и тон чипа по категории операции. Экспортируются, чтобы
 * редактируемая цепочка (вкладка «Маршрут» drawer-а правки в
 * производстве) рисовала ТЕ ЖЕ чипы, что справочник маршрутов, а не
 * заводила вторую таблицу соответствий.
 */
export const ROUTE_STEP_CATEGORY_ICON: Record<string, LucideIcon> = {
  CUTTING: Scissors,
  SEWING: Activity,
  QC: CheckCircle2,
  IRONING: Flame,
  PACKING: Package,
};

export const ROUTE_STEP_CATEGORY_TONE: Record<string, string> = {
  CUTTING: 'admin-route-step--orange',
  SEWING: 'admin-route-step--blue',
  QC: 'admin-route-step--green',
  IRONING: 'admin-route-step--coral',
  PACKING: 'admin-route-step--purple',
};

/** Иконка категории с дефолтом — единая точка для чипов маршрута. */
export function routeStepIcon(category?: string | null): LucideIcon {
  return ROUTE_STEP_CATEGORY_ICON[(category ?? '').toUpperCase()] ?? Activity;
}

/** CSS-модификатор тона категории («» — нейтральный чип). */
export function routeStepTone(category?: string | null): string {
  return ROUTE_STEP_CATEGORY_TONE[(category ?? '').toUpperCase()] ?? '';
}

const CATEGORY_ICON = ROUTE_STEP_CATEGORY_ICON;
const CATEGORY_TONE = ROUTE_STEP_CATEGORY_TONE;

export function AdminRouteSteps({
  steps,
  maxVisible,
  dense = false,
  ariaLabel = 'Операции маршрута',
}: AdminRouteStepsProps) {
  if (steps.length === 0) return null;
  const limit =
    typeof maxVisible === 'number' && steps.length > maxVisible
      ? maxVisible
      : steps.length;
  const visible = steps.slice(0, limit);
  const hidden = steps.length - limit;

  return (
    <ol
      className={`admin-route-steps${dense ? ' admin-route-steps--dense' : ''}`}
      aria-label={ariaLabel}
    >
      {visible.map((s, i) => {
        const categoryKey = (s.category ?? '').toUpperCase();
        const Icon = CATEGORY_ICON[categoryKey] ?? Activity;
        const tone = CATEGORY_TONE[categoryKey] ?? '';
        return (
          <li key={s.id} className="admin-route-steps__item">
            <span className={`admin-route-step ${tone}`}>
              <span className="admin-route-step__num" aria-hidden>
                {s.index}
              </span>
              <span className="admin-route-step__icon" aria-hidden>
                <Icon size={14} strokeWidth={1.7} />
              </span>
              <span className="admin-route-step__name">{s.name}</span>
            </span>
            {i < visible.length - 1 &&
              (s.parallelGroup != null &&
              s.parallelGroup === visible[i + 1].parallelGroup ? (
                <span
                  className="admin-route-steps__sep admin-route-steps__sep--parallel"
                  title="Параллельные операции: порядок любой"
                  aria-label="параллельно с"
                >
                  <ArrowLeftRight size={13} strokeWidth={1.8} aria-hidden />
                </span>
              ) : (
                <span className="admin-route-steps__sep" aria-hidden>
                  →
                </span>
              ))}
          </li>
        );
      })}
      {hidden > 0 && (
        <li className="admin-route-steps__item">
          <span className="admin-route-steps__sep" aria-hidden>
            →
          </span>
          <span className="admin-route-step admin-route-step--more">
            + ещё {hidden}
          </span>
        </li>
      )}
    </ol>
  );
}
