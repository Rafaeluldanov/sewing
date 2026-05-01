/**
 * Конфигурация вкладок управленческой карточки заказа
 * `/admin/orders/[id]` (view-mode).
 *
 * Источник истины по списку вкладок и их человекочитаемым лейблам.
 * Сделано отдельным файлом (не переиспользуем `order-detail-tabs-config`),
 * потому что:
 *
 *   - старая конфигурация (`product / materials / operations / logistics
 *     / summary / recommendations`) до сих пор используется в
 *     create-форме `/admin/orders/new` и edit-форме
 *     `/admin/orders/[id]/edit` — там «Продукция» это активная
 *     вкладка с самой формой. Менять её тоже под management-view —
 *     значит ломать обе формы;
 *   - на view-странице карточки одна и та же вкладка не должна
 *     дублировать содержимое hero — поэтому мы убрали «Обзор»,
 *     «Продукция» как самостоятельные блоки.
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 *
 * Порядок вкладок зафиксирован (см. ТЗ «Целевая структура страницы
 * заказа»): «Производство → Паспорта → План → Операции → Сводно по
 * заказу → Потребности → История». Менеджер читает карточку слева
 * направо как «факт → объекты → план → операции → деньги →
 * обеспечение → аудит». «Операции» — это единый рабочий экран по
 * маршруту/норме/плану/факту операций (`OrderOperationsUnifiedTable`),
 * переехавший сюда после того, как в редизайне карточки старая
 * вкладка случайно отсутствовала. «Сводно по заказу» (`costSummary`)
 * — это отдельная финансовая вкладка с itemized cost breakdown
 * (`OrderSummaryUnifiedTable`): расходы, себестоимость, цена
 * продажи, выручка, прибыль и маржинальность. Используем id
 * `costSummary` (а не `summary`), чтобы явно отделить новую
 * финансовую вкладку от старого generic-summary, который раньше
 * создавал путаницу. `OrderSummaryUnifiedTable` во вкладку
 * «Потребности» по-прежнему **запрещён** — ownership rule живёт в
 * JSDoc `OrderNeedsTab`; это deep-dive принадлежит «Сводно по
 * заказу».
 */

export type OrderViewTabId =
  | 'production'
  | 'passports'
  | 'plan'
  | 'operations'
  | 'costSummary'
  | 'needs'
  | 'history';

export interface OrderViewTabConfig {
  /** Код, который ходит в query param `?tab=…`. */
  id: OrderViewTabId;
  /** Лейбл вкладки. */
  label: string;
  /** Краткое описание для empty-state-плашки внутри вкладки. */
  emptyStateTitle: string;
  /** Подсказка empty-state, когда у вкладки нет данных. */
  emptyStateHint: string;
}

export const ORDER_VIEW_TABS: readonly OrderViewTabConfig[] = [
  {
    id: 'production',
    label: 'Производство',
    emptyStateTitle: 'Производство',
    emptyStateHint:
      'Прогресс производства появится после запуска заказа в работу и выпуска первых паспортов.',
  },
  {
    id: 'passports',
    label: 'Паспорта',
    emptyStateTitle: 'Паспорта',
    emptyStateHint:
      'Паспорта появятся после того, как раскройщик выпустит первую партию по заказу.',
  },
  {
    id: 'plan',
    label: 'План',
    emptyStateTitle: 'План',
    emptyStateHint:
      'План заказа фиксируется при запуске в производство — позднее он не меняется (см. ADR-0006).',
  },
  {
    id: 'operations',
    label: 'Операции',
    emptyStateTitle: 'Операции',
    emptyStateHint:
      'Маршрут, нормы, план/факт и операционный план появятся после фиксации шаблона маршрута заказа.',
  },
  {
    id: 'costSummary',
    label: 'Сводно по заказу',
    emptyStateTitle: 'Сводно по заказу',
    emptyStateHint:
      'Расходы, себестоимость, прибыль и маржинальность по заказу.',
  },
  {
    id: 'needs',
    label: 'Потребности',
    emptyStateTitle: 'Потребности',
    emptyStateHint:
      'Материалы, внешние подряды и себестоимость появятся после расчёта заказа.',
  },
  {
    id: 'history',
    label: 'История',
    emptyStateTitle: 'История',
    emptyStateHint:
      'История событий заказа пока недоступна — нет публичного API audit-log.',
  },
] as const;

const TAB_IDS = new Set(ORDER_VIEW_TABS.map((t) => t.id));

/**
 * Безопасный парсер `?tab=…` для server-page карточки заказа. Любое
 * неизвестное значение трактуем как `'production'` — это управленческий
 * default: первое, что хочет видеть менеджер.
 */
export function parseOrderViewTab(
  raw: string | string[] | undefined,
): OrderViewTabId {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return 'production';
  return TAB_IDS.has(value as OrderViewTabId)
    ? (value as OrderViewTabId)
    : 'production';
}

export function getOrderViewTabConfig(id: OrderViewTabId): OrderViewTabConfig {
  return ORDER_VIEW_TABS.find((t) => t.id === id) ?? ORDER_VIEW_TABS[0];
}
