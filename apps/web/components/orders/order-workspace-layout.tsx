/**
 * `OrderWorkspaceLayout` — единая обёртка мастера/карточки заказа.
 *
 * Ровно одна и та же структура на трёх страницах:
 *   - `/admin/orders/new`        (mode=`'create'`);
 *   - `/admin/orders/[id]`       (mode=`'view'`);
 *   - `/admin/orders/[id]/edit`  (mode=`'edit'`).
 *
 * Идея: пользователь воспринимает «создание заказа → карточка
 * созданного заказа → редактирование» как **одну страницу с
 * разными состояниями**, а не как три разные admin-секции. Ради
 * этого hero и tabs живут в одном компоненте: достаточно дать
 * нужный mode + props, и всё ляжет одинаково.
 *
 * Backend / DTO / Prisma не трогаем — это presentation-слой.
 *
 * Структура DOM (классы см. в `globals.css §«Order workspace»`):
 *
 *   <section class="order-workspace">
 *     <div class="order-workspace__hero">  ← OrderHeroCard
 *     <div class="order-workspace__tabs">  ← OrderDetailTabs
 *     <div class="order-workspace__body">  ← children (тело вкладки)
 *   </section>
 *
 * Hero и Tabs передаются как ReactNode (а не строятся внутри),
 * чтобы вызывающая страница могла:
 *   - сама подставить нужный mode у `OrderHeroCard`;
 *   - сама решить, какие табы disabled (зависит от состояния заказа);
 *   - использовать клиентский hero для create-mode (там данные
 *     приходят из useState формы) и server hero для view-mode
 *     (там данные — это уже готовый `OrderDetailDto`).
 */
import type { ReactNode } from 'react';
import type { OrderHeroMode } from './order-hero-card';

interface Props {
  mode: OrderHeroMode;
  hero: ReactNode;
  tabs: ReactNode;
  children: ReactNode;
}

export function OrderWorkspaceLayout({
  mode,
  hero,
  tabs,
  children,
}: Props) {
  return (
    <section
      className={`order-workspace order-workspace--${mode}`}
      data-mode={mode}
    >
      <div className="order-workspace__hero">{hero}</div>
      <div className="order-workspace__tabs">{tabs}</div>
      <div className="order-workspace__body">{children}</div>
    </section>
  );
}

/**
 * `OrderTabEmptyState` — единая «заглушка» вкладок, которая ещё не
 * имеет данных. Используется на:
 *   - `/admin/orders/new` (все вкладки кроме «Продукция» в
 *     create-mode — заказа ещё нет);
 *   - `/admin/orders/[id]` для разделов с `null`-данными (например,
 *     «Рекомендации» в DRAFT, «Логистика» до завершения расчёта).
 *
 * Тексты приходят из `ORDER_DETAIL_TABS` (см.
 * `order-detail-tabs-config.ts`), поэтому create- и view-страницы
 * никогда не разъезжаются.
 */
interface EmptyStateProps {
  title: string;
  hint: string;
  /**
   * Опциональный action-слот (например, ссылка на «Создать заказ»
   * или «Перевести в расчёт»). На MVP — обычно `null`, потому что
   * главные actions живут в hero.
   */
  action?: ReactNode;
}

export function OrderTabEmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div className="order-tab-empty-state" role="status">
      <span className="order-tab-empty-state__title">{title}</span>
      <p className="order-tab-empty-state__hint">{hint}</p>
      {action && <div className="order-tab-empty-state__action">{action}</div>}
    </div>
  );
}

/**
 * `OrderTabLoadingState` — скелет тела вкладки карточки заказа.
 *
 * Используется как `fallback` у `<Suspense>` вокруг активной вкладки
 * `/admin/orders/[id]`: вкладки — тяжёлые async server-компоненты
 * (`OrderProductionTab` тянет shopfloor-состояние, `OrderNeedsTab` —
 * потребности/выдачи/закупки), и без границы Suspense шапка с
 * линейкой вкладок не показывалась бы, пока не доедет вся вкладка
 * целиком. Высота задана намеренно (`min-height`), чтобы при
 * переключении вкладки страница не «схлопывалась» под коротким
 * скелетом — прокрутку мы сознательно не сбрасываем.
 */
export function OrderTabLoadingState() {
  return (
    <div className="order-tab-loading" role="status" aria-live="polite">
      <span className="order-tab-loading__label">Загружаем раздел…</span>
      <div className="order-tab-loading__bar order-tab-loading__bar--title" />
      <div className="order-tab-loading__bar" />
      <div className="order-tab-loading__bar order-tab-loading__bar--short" />
      <div className="order-tab-loading__block" />
    </div>
  );
}
