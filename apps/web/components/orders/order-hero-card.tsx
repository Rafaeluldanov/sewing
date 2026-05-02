/**
 * `OrderHeroCard` — рабочий блок «Основное» в верхней части карточки
 * заказа. Используется на трёх admin-страницах одинаково:
 *   - `/admin/orders/new`        (mode=`'create'`);
 *   - `/admin/orders/[id]`       (mode=`'view'`);
 *   - `/admin/orders/[id]/edit`  (mode=`'edit'`).
 *
 * До рефакторинга hero был большим info-блоком с превью лекала,
 * номенклатурой, цветом и размерами — то есть дублировал то, что
 * показывает вкладка «Продукция». Это превращало карточку заказа
 * в простыню. Теперь hero — это **рабочий** блок управления заказом:
 *
 *   1. Идентификаторы и статус (номер + бейдж);
 *   2. Управленческие поля (форма «Основное» — `basics`-слот):
 *      подразделение / срок / клиент / цена + валюта / комментарий.
 *      В create / edit — редактируемые поля; в view — read-only
 *      обзор + inline-форма «Сохранить основное» через
 *      `updateOrderBasicsAction`.
 *   3. KPI-сводка (тираж / выручка / себестоимость / маржа /
 *      статусы блоков): только короткие цифры; подробный
 *      breakdown живёт во вкладке «Сводно по заказу».
 *   4. Workflow-actions (Перевести в расчёт / Запустить в
 *      производство / Пересчитать план / …).
 *
 * Hero **сознательно не показывает**:
 *   - номенклатуру / лекало (это в «Продукция»);
 *   - артикул лекала;
 *   - превью лекала;
 *   - цвет изделия;
 *   - размерную матрицу;
 *   - нанесения;
 *   - таблицы материалов / операций.
 *
 * Допустимо лишь короткое secondary-summary `productSummary`
 * (например, «Продукция: Футболка Oversize · 120 шт») — оно
 * отрисовывается строкой меньшего размера под формой и
 * **не повторяет** содержимое вкладки «Продукция», а служит
 * быстрым ориентиром «о чём этот заказ».
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 * Источник правды по полям — родитель: `AdminCreateOrderForm`,
 * `AdminOrderDetailPage`, `AdminEditOrderForm` собирают `basics`
 * и `kpis` сами и кладут их в соответствующие слоты.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AdminStatusBadge } from '@/components/admin';
import {
  formatOrderStatus,
  getOrderStatusTone,
  type AdminStatusTone,
} from '@/lib/admin-labels';

export type OrderHeroMode = 'create' | 'view' | 'edit';

export type OrderHeroKpiTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Описание одного KPI-чипа в hero.
 *
 * Никаких чисел тут не считаем — родитель уже подставил
 * человекочитаемое значение (`'120 шт'`, `'24 000 ₽'`, `'—'`,
 * `'не рассчитано'`). Тон `tone` подсвечивает чип
 * (например, danger для блокеров материалов).
 */
export interface OrderHeroKpi {
  /** Стабильный ключ для React-списка. */
  id: string;
  /** Лейбл (например, «Тираж», «Выручка»). */
  label: string;
  /** Готовая строка значения. `'—'` для отсутствующих данных. */
  value: string;
  /** Опциональная подпись справа от значения (например, ` шт`). */
  unit?: string;
  /** Подсветка чипа. Default — `'neutral'`. */
  tone?: OrderHeroKpiTone;
  /** Tooltip — например, причина «требует пересчёта». */
  hint?: string;
}

interface Props {
  mode: OrderHeroMode;
  /** Номер заказа (для view/edit) или `null` (create). */
  number: string | null;
  /** Статус заказа (для view/edit) или `null` (create = «Черновик»). */
  status: string | null;
  /**
   * Заголовок-эйлер над номером. По умолчанию выводится
   * «Карточка заказа» / «Создание заказа» / «Редактирование заказа».
   * Можно переопределить через prop, например:
   * `«Заказ № 42 — редактирование»`.
   */
  titleOverride?: string;
  /**
   * Дата создания заказа (ISO-string) — компактно отрисуется
   * рядом с номером. На create — `null`.
   */
  createdAt?: string | null;
  /**
   * Короткая secondary-строка над формой «Основное», например
   * `«Продукция: Футболка Oversize · 120 шт»`. Это **не**
   * полноценный блок продукции — главную информацию
   * показывает вкладка «Продукция». Можно опустить (`null`).
   */
  productSummary?: ReactNode;
  /**
   * Слот формы «Основное» — управленческие поля заказа.
   * В create-mode — встроенный фрагмент общей create-формы
   * (поля `companyDivisionId` / `dueDate` / `clientId` / `customer`
   * / `customerUnitPrice` / `customerCurrency` / `comment`).
   * В view-mode — inline-форма с `updateOrderBasicsAction`.
   * В edit-mode — те же поля, но в `<form>` единой edit-формы.
   */
  basics: ReactNode;
  /**
   * Список KPI-чипов под формой. Если массив пуст или не передан —
   * блок KPI не отрисовывается. Создаётся родителем (см.
   * `buildOrderHeroKpis()` / inline-сборка в create-форме).
   */
  kpis?: OrderHeroKpi[];
  /**
   * Workflow-actions (Перевести в расчёт / Завершить расчёт /
   * Вернуть на пересчёт / Запустить в производство / Пересчитать
   * план / Отменить / …). Кнопки приходят готовыми из родителя.
   * Допустимо `null` — например, для DONE/CANCELLED.
   */
  workflowActions?: ReactNode;
  /**
   * Дополнительный slot над hero-баннером для сообщений
   * (например, «Заказ просрочен», «Расчёт устарел»). Пусто для
   * штатной работы.
   */
  alerts?: ReactNode;
}

/**
 * Универсальный hero-блок «Основное».
 *
 * Никакой бизнес-логики внутри: рендерим компоновку для четырёх
 * слотов (`basics`, `kpis`, `workflowActions`, `productSummary`) +
 * шапка с номером и статусом. Все слоты опциональные, чтобы
 * каждая страница могла включать ровно то, что нужно.
 */
export function OrderHeroCard({
  mode,
  number,
  status,
  titleOverride,
  createdAt,
  productSummary,
  basics,
  kpis,
  workflowActions,
  alerts,
}: Props) {
  const isCreate = mode === 'create';
  const statusLabel = isCreate
    ? 'Черновик'
    : formatOrderStatus(status ?? 'DRAFT');
  const statusTone: AdminStatusTone = isCreate
    ? 'muted'
    : getOrderStatusTone(status ?? 'DRAFT');

  const titleText =
    titleOverride ??
    (isCreate
      ? 'Новый заказ'
      : number
        ? `Заказ ${number}`
        : 'Заказ');

  const eyebrow =
    mode === 'create'
      ? 'Создание заказа'
      : mode === 'edit'
        ? 'Редактирование заказа'
        : 'Карточка заказа';

  const className = [
    'order-hero-card',
    `order-hero-card--${mode}`,
  ].join(' ');

  return (
    <section
      className={className}
      aria-label="Основное по заказу"
      data-mode={mode}
    >
      {alerts && <div className="order-hero-card__alerts">{alerts}</div>}

      <header className="order-hero-card__head">
        <div className="order-hero-card__identity">
          <span className="order-hero-card__eyebrow">{eyebrow}</span>
          <h2 className="order-hero-card__title">{titleText}</h2>
          {createdAt && (
            <span className="order-hero-card__createdAt">
              Создан {formatHeroDateTime(createdAt)}
            </span>
          )}
        </div>
        <div className="order-hero-card__status">
          <AdminStatusBadge tone={statusTone}>{statusLabel}</AdminStatusBadge>
        </div>
      </header>

      {productSummary && (
        <div className="order-hero-card__product-summary">
          {productSummary}
        </div>
      )}

      <div className="order-hero-card__basic-form">{basics}</div>

      {kpis && kpis.length > 0 && (
        <ul className="order-hero-card__kpis" role="list">
          {kpis.map((kpi) => (
            <li
              key={kpi.id}
              className={`order-hero-card__kpi order-hero-card__kpi--${kpi.tone ?? 'neutral'}`}
              title={kpi.hint}
            >
              <span className="order-hero-card__kpi-label">{kpi.label}</span>
              <span className="order-hero-card__kpi-value">
                {kpi.value}
                {kpi.unit && (
                  <span className="order-hero-card__kpi-unit"> {kpi.unit}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {workflowActions && (
        <div
          className="order-hero-card__actions"
          role="group"
          aria-label="Действия по заказу"
        >
          {workflowActions}
        </div>
      )}
    </section>
  );
}

/**
 * Адаптер `OrderDetailDto → core hero-fields`. Помогает страницам
 * не дублировать выбор `client.name ?? customer ?? null`.
 */
export interface OrderHeroDtoLike {
  number: string;
  status: string;
  client: { id: string; name: string } | null;
  customer: string | null;
  patternName: string | null;
  patternArticle: string | null;
  patternNameSnapshot: string | null;
  patternArticleSnapshot: string | null;
  productName: string | null;
  qtyPlanTotal: number;
}

export interface OrderHeroNomenclature {
  name: string | null;
  article: string | null;
}

export function pickHeroNomenclature(
  order: OrderHeroDtoLike,
): OrderHeroNomenclature {
  const name =
    order.patternNameSnapshot ?? order.patternName ?? order.productName ?? null;
  const article =
    order.patternArticleSnapshot ?? order.patternArticle ?? null;
  return { name, article };
}

export function pickHeroClientName(order: OrderHeroDtoLike): string | null {
  return order.client?.name ?? order.customer ?? null;
}

/**
 * Дополнительный wrapper-компонент: обычная ссылка-CTA «Открыть
 * раздел» в самом hero (back-link, edit-link, ссылка на старую
 * карточку и т.п.).
 */
export function OrderHeroAction({
  href,
  children,
  variant = 'primary',
  title,
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'ghost';
  title?: string;
}) {
  return (
    <Link
      href={href}
      title={title}
      className={`admin-btn admin-btn--${variant === 'primary' ? 'primary' : 'ghost'}`}
    >
      {children}
    </Link>
  );
}

function formatHeroDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return '—';
  }
}
