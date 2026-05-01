/**
 * Единый источник правды по вкладкам карточки/мастера заказа
 * (`/admin/orders/new`, `/admin/orders/[id]`, `/admin/orders/[id]/edit`).
 *
 * Раньше каждая страница рендерила свой набор cards в произвольном
 * порядке — менеджер видел «две разные системы». После UI-unification
 * мы рисуем один и тот же hero + один и тот же ряд вкладок на всех
 * трёх страницах (см. `OrderWorkspaceLayout`). Этот файл — словарь
 * вкладок и их человеческих лейблов: один константный массив,
 * импортируется и компонентами, и smoke-тестами.
 *
 * Backend / DTO / Prisma здесь не задействованы — это чисто
 * presentation-слой.
 *
 * Последовательность вкладок зафиксирована (см. ТЗ §3): она же
 * определяет визуальный порядок и порядок «логического чтения»
 * карточки заказа (продукция → материалы → операции → логистика
 * → сводка → рекомендации).
 */

export type OrderDetailTabId =
  | 'product'
  | 'materials'
  | 'operations'
  | 'logistics'
  | 'summary'
  | 'recommendations';

export interface OrderDetailTabConfig {
  /** Код, который ходит в query param `?tab=…`. */
  id: OrderDetailTabId;
  /** Полный лейбл для рендера в табе на широком экране. */
  label: string;
  /** Empty-state hint для create-mode и для view-mode без данных. */
  emptyStateHint: string;
  /** Краткое описание — заголовок empty-state-плашки. */
  emptyStateTitle: string;
}

/**
 * ORDER_DETAIL_TABS — порядок и лейблы вкладок карточки заказа.
 *
 * - `product` всегда первая (единственная активная в create-mode);
 * - `recommendations` всегда последняя (на MVP может быть пустой).
 *
 * Тексты empty-state приходят сюда централизованно, чтобы и
 * `/admin/orders/new` (create-mode), и `/admin/orders/[id]`
 * (view-mode без данных) показывали один и тот же текст. Новые
 * вкладки добавляются СЮДА — компоненты подхватят сами.
 */
export const ORDER_DETAIL_TABS: readonly OrderDetailTabConfig[] = [
  {
    id: 'product',
    label: 'Продукция',
    emptyStateTitle: 'Продукция',
    emptyStateHint:
      'Заполните клиента, лекало, цвет и размеры — затем создайте заказ.',
  },
  {
    id: 'materials',
    label: 'Материалы',
    emptyStateTitle: 'Материалы',
    emptyStateHint:
      'Материалы будут рассчитаны после создания заказа и перевода в расчёт.',
  },
  {
    id: 'operations',
    label: 'Операции',
    emptyStateTitle: 'Операции',
    emptyStateHint:
      'План операций появится после выбора маршрута и создания заказа.',
  },
  {
    id: 'logistics',
    label: 'Логистика',
    emptyStateTitle: 'Логистика',
    emptyStateHint:
      'Закупки, приёмки и готовность к крою появятся после расчёта потребности.',
  },
  {
    id: 'summary',
    label: 'Сводно по заказу',
    emptyStateTitle: 'Сводно по заказу',
    emptyStateHint:
      'Сводка себестоимости появится после расчёта материалов и операций.',
  },
  {
    id: 'recommendations',
    label: 'Рекомендации по заказу',
    emptyStateTitle: 'Рекомендации',
    emptyStateHint:
      'Рекомендации появятся после создания заказа и заполнения расчёта.',
  },
] as const;

const TAB_IDS = new Set(ORDER_DETAIL_TABS.map((t) => t.id));

/**
 * Безопасный парсер `?tab=…` для server pages. Любое неизвестное
 * значение трактуем как `'product'` — это default-вкладка для всех
 * трёх режимов (create / view / edit).
 */
export function parseOrderDetailTab(
  raw: string | string[] | undefined,
): OrderDetailTabId {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return 'product';
  return TAB_IDS.has(value as OrderDetailTabId)
    ? (value as OrderDetailTabId)
    : 'product';
}

/**
 * Найти конфиг вкладки по id; всегда возвращает что-то (fallback на
 * `product` — он всегда есть в массиве).
 */
export function getOrderDetailTabConfig(
  id: OrderDetailTabId,
): OrderDetailTabConfig {
  const found = ORDER_DETAIL_TABS.find((t) => t.id === id);
  return found ?? ORDER_DETAIL_TABS[0];
}
