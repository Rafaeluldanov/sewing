'use client';

/**
 * Admin Edit Order Form — full-edit «продукции» заказа на
 * `/admin/orders/[id]/edit`. Используется единый
 * `OrderWorkspaceLayout` mode=`'edit'`:
 *
 *   - hero «Основное» (`OrderHeroCard`): содержит редактируемые
 *     управленческие поля (`companyDivisionId` / `dueDate` /
 *     `clientId` / `customerUnitPrice` + `customerCurrency` /
 *     `comment`) и поле `status` (с разрешёнными переходами);
 *   - tab «Продукция» — editable: лекало, цвет, техкарта, маршрут,
 *     размерная матрица. Прочие вкладки в edit-mode рендерятся
 *     как ссылки на view-режим карточки через `productEditHref`.
 *
 * FormData-контракт совпадает с `updateAdminOrderAction` (см.
 * `actions.ts` рядом):
 *   - `orderDate`        (date, required, hidden — берётся из заказа);
 *   - `dueDate`          (date, optional);
 *   - `clientId`         (string, optional);
 *   - `customer`         (hidden, для совместимости);
 *   - `companyDivisionId` (select, FK на `CompanyDivision`);
 *   - `comment`          (textarea);
 *   - `customerUnitPrice` / `customerCurrency`;
 *   - `status`           (`DRAFT | CALCULATION | IN_PRODUCTION | DONE | CANCELLED`);
 *   - `patternItemId`    (select);
 *   - `color`            (input);
 *   - `routeTemplateId`  (select);
 *   - `techCardId`       (select);
 *   - `qty[<sizeId>]`    (number, AdminSizeGrid).
 *
 * Backend / DTO / Prisma не трогаем — `updateAdminOrderAction`
 * по-прежнему делегирует в `updateOrder` через
 * `OrdersService.update`. «Опасные» поля (items / route /
 * techCard / pattern / companyDivisionId) backend разрешает только
 * в DRAFT — UI помечает их `disabled` для не-DRAFT, чтобы не
 * вводить менеджера в заблуждение.
 */

import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';
import { useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Grid3X3,
  Save,
  Shirt,
  Workflow,
} from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';
import type {
  OrderDetailDto,
  OrderStatus,
  SizeDto,
} from '@sewing/shared/orders';
import {
  MONEY_CURRENCIES,
  MONEY_CURRENCY_LABELS,
  type MoneyCurrency,
} from '@sewing/shared/money';
import type { PatternListItemDto } from '@sewing/shared/patterns';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
import {
  AdminCard,
  AdminDateField,
  AdminRouteSteps,
  AdminSizeGrid,
  type AdminRouteStep,
} from '@/components/admin';
import { formatOrderStatus } from '@/lib/admin-labels';
import {
  OrderHeroCard,
  type OrderHeroKpi,
} from '@/components/orders/order-hero-card';
import { OrderDetailTabs } from '@/components/orders/order-detail-tabs';
import { OrderWorkspaceLayout } from '@/components/orders/order-workspace-layout';
import {
  updateAdminOrderAction,
  type FormActionState,
} from './actions';

export interface RoutePreview {
  id: string;
  name: string;
  steps: AdminRouteStep[];
}

interface Props {
  order: OrderDetailDto;
  sizes: SizeDto[];
  routeTemplates: RouteTemplateSummaryDto[];
  routePreviewMap: Record<string, RoutePreview>;
  techCards: TechCardTemplateSummaryDto[];
  clients: ClientDto[];
  patterns: PatternListItemDto[];
  /**
   * Активные карточки `CompanyDivision` (см.
   * `docs/domain.md §«Подразделения заказа»`). Текущая привязка
   * заказа всегда добавляется отдельной опцией ниже, даже если
   * карточка архивирована.
   */
  companyDivisions: CompanyDivisionDto[];
  /**
   * Список складов для select-а «Склад выпуска готовой продукции»
   * (см. `prisma/schema.prisma::Order.finishedGoodsWarehouseId`).
   * Поле управленческое — не влияет на StockBalance / StockMovement.
   * Если у заказа уже привязан архивный склад — его опцию форма
   * добавит сама, чтобы submit без явного действия не сбросил FK.
   */
  warehouses: WarehouseSummaryDto[];
  today: string;
}

const initialState: FormActionState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохранение…' : 'Сохранить'}
    </button>
  );
}

function allowedStatusOptions(current: OrderStatus): OrderStatus[] {
  switch (current) {
    case 'DRAFT':
      return ['DRAFT', 'CALCULATION', 'IN_PRODUCTION', 'CANCELLED'];
    case 'CALCULATION':
      return ['CALCULATION', 'IN_PRODUCTION', 'CANCELLED'];
    case 'IN_PRODUCTION':
      return ['IN_PRODUCTION', 'DONE', 'CANCELLED'];
    case 'DONE':
      return ['DONE'];
    case 'CANCELLED':
      return ['CANCELLED'];
    default:
      return [current];
  }
}

export function AdminEditOrderForm({
  order,
  sizes,
  routeTemplates,
  routePreviewMap,
  techCards,
  clients,
  patterns,
  companyDivisions,
  warehouses,
  today,
}: Props) {
  const action = updateAdminOrderAction.bind(null, order.id);
  const [state, formAction] = useFormState(action, initialState);

  const isDraft = order.status === 'DRAFT';
  const isTerminal = order.status === 'DONE' || order.status === 'CANCELLED';

  const [color, setColor] = useState<string>(order.color ?? '');

  const sortedSizes = useMemo(
    () => [...sizes].sort((a, b) => a.sortOrder - b.sortOrder),
    [sizes],
  );

  const [routeTemplateId, setRouteTemplateId] = useState<string>(
    order.routeTemplateId ?? '',
  );
  const selectedRoute = routeTemplateId
    ? routePreviewMap[routeTemplateId]
    : undefined;

  const [techCardId, setTechCardId] = useState<string>(
    order.techCardId ?? '',
  );

  const [patternItemId, setPatternItemId] = useState<string>(
    order.patternItemId ?? '',
  );
  const selectedPattern = useMemo(
    () => patterns.find((p) => p.id === patternItemId) ?? null,
    [patternItemId, patterns],
  );

  const orderDateValue = order.orderDate.slice(0, 10);
  const dueDateInitial = order.dueDate ? order.dueDate.slice(0, 10) : '';
  const [dueDate, setDueDate] = useState<string>(dueDateInitial);

  const [status, setStatus] = useState<OrderStatus>(order.status);

  const initialQty = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const it of order.items) map[it.sizeId] = it.qtyPlan;
    return map;
  }, [order.items]);

  const initialTotal = useMemo(
    () => Object.values(initialQty).reduce((s, n) => s + n, 0),
    [initialQty],
  );
  const [sizesTotal, setSizesTotal] = useState<number>(initialTotal);

  const currentClient = order.client;

  const [clientId, setClientId] = useState<string>(currentClient?.id ?? '');
  const [companyDivisionId, setCompanyDivisionId] = useState<string>(
    order.companyDivisionId ?? '',
  );
  const showCurrentDivisionArchivedOption = Boolean(
    order.companyDivisionId &&
      !companyDivisions.some((d) => d.id === order.companyDivisionId),
  );

  // Этап «Склад выпуска готовой продукции»: state + fallback-опция
  // на случай, если выбранный ранее склад больше не активен
  // (`isActive = false`) или удалён из live-списка. Sample-list
  // (`warehouses`) на странице фильтрации не делает — мы дополнительно
  // отрисовываем «архивную» опцию, чтобы submit без явного действия
  // не обнулил FK.
  const [
    finishedGoodsWarehouseId,
    setFinishedGoodsWarehouseId,
  ] = useState<string>(order.finishedGoodsWarehouseId ?? '');
  const showCurrentFinishedGoodsArchivedOption = Boolean(
    order.finishedGoodsWarehouseId &&
      !warehouses.some((w) => w.id === order.finishedGoodsWarehouseId),
  );
  const [customerUnitPrice, setCustomerUnitPrice] = useState<string>(
    order.customerUnitPrice == null ? '' : String(order.customerUnitPrice),
  );
  const [customerCurrency, setCustomerCurrency] = useState<MoneyCurrency | ''>(
    order.customerCurrency ?? '',
  );
  const [comment, setComment] = useState<string>(order.comment ?? '');

  const fieldError = (key: string): string | undefined =>
    state.fieldErrors?.[key];

  const sizeGridSizes = useMemo(
    () => sortedSizes.map((s) => ({ id: s.id, name: s.code })),
    [sortedSizes],
  );

  const totalLabel = `${sizesTotal.toLocaleString('ru-RU')} шт.`;

  const showCurrentClientArchivedOption =
    currentClient && !clients.some((c) => c.id === currentClient.id);

  const statusOptions = allowedStatusOptions(order.status);
  const statusDisabled = isTerminal;

  const showCurrentRouteFallback = Boolean(
    order.routeTemplateId &&
      !routeTemplates.some((t) => t.id === order.routeTemplateId),
  );
  const showCurrentTechCardFallback = Boolean(
    order.techCardId && !techCards.some((t) => t.id === order.techCardId),
  );
  const showCurrentPatternFallback = Boolean(
    order.patternItemId &&
      !patterns.some((p) => p.id === order.patternItemId),
  );

  const heroEditHref = `/admin/orders/${order.id}/edit`;

  const heroKpis: OrderHeroKpi[] = [
    {
      id: 'qty',
      label: 'Тираж',
      value: sizesTotal > 0 ? sizesTotal.toLocaleString('ru-RU') : '—',
      unit: sizesTotal > 0 ? 'шт' : undefined,
      tone: sizesTotal > 0 ? 'neutral' : 'warning',
    },
  ];

  return (
    <form action={formAction} className="admin-form admin-order-form">
      <input type="hidden" name="orderDate" value={orderDateValue} />
      <input type="hidden" name="customer" value={order.customer ?? ''} />

      {state.error && (
        <div role="alert" className="admin-order-form__error">
          <AlertCircle size={18} strokeWidth={1.6} aria-hidden />
          <span>{state.error}</span>
        </div>
      )}

      {!isDraft && (
        <div
          role="status"
          className="admin-order-form__error"
          style={{
            background: 'var(--admin-warning-bg, #fff7ed)',
            color: 'var(--admin-warning-fg, #9a3412)',
          }}
        >
          <AlertCircle size={18} strokeWidth={1.6} aria-hidden />
          <span>
            {order.status === 'CALCULATION'
              ? 'Заказ в статусе «Расчёт» — потребность цеха уже собрана. Менять состав, изделие, маршрут, техкарту и подразделение нельзя; правится только клиент, срок и комментарий.'
              : 'Заказ уже не в статусе «Черновик» — менять состав, изделие, маршрут, техкарту и подразделение нельзя. Доступны клиент, срок, комментарий и безопасные переходы статуса.'}
          </span>
        </div>
      )}

      <OrderWorkspaceLayout
        mode="edit"
        hero={
          <OrderHeroCard
            mode="edit"
            number={order.number}
            status={order.status}
            createdAt={order.createdAt}
            titleOverride={`Заказ ${order.number} — редактирование`}
            productSummary={
              <span className="order-hero-card__product-summary-text">
                <span className="order-hero-card__product-summary-label">
                  Продукция:
                </span>{' '}
                <strong>
                  {selectedPattern?.name ??
                    order.patternNameSnapshot ??
                    order.patternName ??
                    order.productName ??
                    '—'}
                </strong>
                {sizesTotal > 0 && (
                  <span className="order-hero-card__product-summary-meta">
                    {' '}
                    · {sizesTotal.toLocaleString('ru-RU')} шт
                  </span>
                )}
              </span>
            }
            basics={
              <div className="order-hero-card__basic-grid">
                <div className="order-hero-card__field">
                  <label htmlFor="companyDivisionId">Подразделение</label>
                  <select
                    id="companyDivisionId"
                    name="companyDivisionId"
                    value={companyDivisionId}
                    onChange={(e) => setCompanyDivisionId(e.target.value)}
                    disabled={!isDraft}
                  >
                    <option value="">— без подразделения —</option>
                    {/*
                      Архивная карточка отображается, чтобы сохранение
                      формы не обнулило FK без явного действия
                      пользователя.
                    */}
                    {showCurrentDivisionArchivedOption &&
                      order.companyDivision && (
                        <option value={order.companyDivision.id}>
                          {order.companyDivision.name} — архивное
                        </option>
                      )}
                    {companyDivisions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                        {d.isActive ? '' : ' — архив'}
                      </option>
                    ))}
                  </select>
                  {!isDraft && (
                    <span className="order-hero-card__field-hint">
                      Менять подразделение можно только в DRAFT.
                    </span>
                  )}
                </div>

                <div className="order-hero-card__field">
                  <label htmlFor="finishedGoodsWarehouseId">
                    Склад выпуска готовой продукции
                  </label>
                  <select
                    id="finishedGoodsWarehouseId"
                    name="finishedGoodsWarehouseId"
                    value={finishedGoodsWarehouseId}
                    onChange={(e) =>
                      setFinishedGoodsWarehouseId(e.target.value)
                    }
                  >
                    <option value="">— не выбран —</option>
                    {showCurrentFinishedGoodsArchivedOption &&
                      order.finishedGoodsWarehouse && (
                        <option value={order.finishedGoodsWarehouse.id}>
                          {order.finishedGoodsWarehouse.name} — архив
                        </option>
                      )}
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                        {w.code ? ` (${w.code})` : ''}
                        {w.isActive ? '' : ' — архив'}
                      </option>
                    ))}
                  </select>
                  <span className="order-hero-card__field-hint">
                    Склад, на который должна поступить готовая продукция
                    после производства / упаковки. Это не склад
                    материалов.
                  </span>
                </div>

                <div className="order-hero-card__field">
                  <label htmlFor="dueDate">Срок сдачи</label>
                  <AdminDateField
                    id="dueDate"
                    name="dueDate"
                    min={today}
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                </div>

                <div className="order-hero-card__field">
                  <label htmlFor="clientId">Клиент</label>
                  <select
                    id="clientId"
                    name="clientId"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  >
                    <option value="">— без клиента —</option>
                    {showCurrentClientArchivedOption && currentClient && (
                      <option value={currentClient.id}>
                        {currentClient.name} — архивный
                      </option>
                    )}
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.isActive ? '' : ' — архивный'}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="order-hero-card__field order-hero-card__field--price">
                  <label htmlFor="customerUnitPrice">Цена за 1 шт</label>
                  <div className="order-hero-card__price-row">
                    <input
                      id="customerUnitPrice"
                      name="customerUnitPrice"
                      type="text"
                      inputMode="decimal"
                      value={customerUnitPrice}
                      onChange={(e) => setCustomerUnitPrice(e.target.value)}
                      placeholder="0.00"
                    />
                    <select
                      name="customerCurrency"
                      value={customerCurrency}
                      onChange={(e) =>
                        setCustomerCurrency(
                          e.target.value as MoneyCurrency | '',
                        )
                      }
                      aria-label="Валюта"
                    >
                      <option value="">—</option>
                      {MONEY_CURRENCIES.map((c) => (
                        <option key={c} value={c}>
                          {MONEY_CURRENCY_LABELS[c]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="order-hero-card__field">
                  <label htmlFor="status">Статус</label>
                  <select
                    id="status"
                    name="status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value as OrderStatus)}
                    disabled={statusDisabled}
                  >
                    {statusOptions.map((s) => (
                      <option key={s} value={s}>
                        {formatOrderStatus(s)}
                      </option>
                    ))}
                  </select>
                  <span className="order-hero-card__field-hint">
                    {isTerminal
                      ? 'Терминальный статус — изменить нельзя.'
                      : status !== order.status
                        ? `Будет применён переход ${formatOrderStatus(order.status)} → ${formatOrderStatus(status)}.`
                        : 'Безопасные переходы выполняются через тот же flow start/complete/cancel.'}
                  </span>
                </div>

                <div className="order-hero-card__field order-hero-card__field--comment">
                  <label htmlFor="comment">Комментарий</label>
                  <textarea
                    id="comment"
                    name="comment"
                    rows={2}
                    maxLength={2000}
                    placeholder="Краткое описание заказа"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                </div>
              </div>
            }
            kpis={heroKpis}
            workflowActions={
              <>
                <Link
                  href={`/admin/orders/${order.id}`}
                  className="admin-btn admin-btn--ghost"
                >
                  <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
                  К карточке
                </Link>
                <SubmitButton />
              </>
            }
          />
        }
        tabs={
          <OrderDetailTabs
            orderId={order.id}
            activeTab="product"
            productEditHref={heroEditHref}
          />
        }
      >
        <div className="order-tab-panel order-product-tab">
          <div className="admin-order-form__grid">
            <AdminCard className="admin-order-card admin-order-card--product">
              <header className="admin-order-card__header">
                <span className="admin-order-card__icon admin-order-card__icon--pink">
                  <Shirt size={18} strokeWidth={1.7} aria-hidden />
                </span>
                <h2 className="admin-order-card__title">Изделие</h2>
              </header>

              <div className="admin-form-grid">
                <div className="admin-field">
                  <label htmlFor="patternItemId">Номенклатура / лекало</label>
                  <select
                    id="patternItemId"
                    name="patternItemId"
                    value={patternItemId}
                    onChange={(e) => setPatternItemId(e.target.value)}
                    disabled={!isDraft}
                    aria-describedby="patternItemId-hint"
                  >
                    <option value="">— без лекала —</option>
                    {showCurrentPatternFallback && order.patternItemId && (
                      <option value={order.patternItemId}>
                        {order.patternName ??
                          order.patternNameSnapshot ??
                          'Текущее лекало'}
                        {' — архивное'}
                      </option>
                    )}
                    {patterns.map((pt) => (
                      <option key={pt.id} value={pt.id}>
                        {pt.name} · {pt.article}
                        {pt.status !== 'ACTIVE' ? ` — ${pt.status}` : ''}
                      </option>
                    ))}
                  </select>
                  <span
                    id="patternItemId-hint"
                    className="admin-field__hint admin-muted"
                  >
                    Основная карточка изделия: превью, DXF и площади
                    материалов.
                  </span>
                  {!isDraft ? (
                    <span className="admin-field__hint admin-muted">
                      Менять лекало можно только в DRAFT — у запущенного
                      заказа уже зафиксирован snapshot полей лекала.
                    </span>
                  ) : patterns.length === 0 ? (
                    <span className="admin-field__hint admin-muted">
                      Список лекал пуст.{' '}
                      <Link href="/admin/patterns/new">Добавить?</Link>
                    </span>
                  ) : null}
                  {fieldError('patternItemId') && (
                    <span
                      className="admin-field__hint"
                      style={{ color: 'var(--admin-danger-fg)' }}
                    >
                      {fieldError('patternItemId')}
                    </span>
                  )}
                </div>

                <div className="admin-field">
                  <label htmlFor="color">Цвет</label>
                  <input
                    id="color"
                    name="color"
                    type="text"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    placeholder="не задан"
                    maxLength={64}
                  />
                </div>
              </div>
            </AdminCard>

            <AdminCard className="admin-order-card admin-order-card--production">
              <header className="admin-order-card__header">
                <span className="admin-order-card__icon admin-order-card__icon--blue">
                  <Workflow size={18} strokeWidth={1.7} aria-hidden />
                </span>
                <h2 className="admin-order-card__title">Производство</h2>
              </header>

              <div className="admin-form-grid">
                <div className="admin-field">
                  <label htmlFor="techCardId">Техкарта</label>
                  <select
                    id="techCardId"
                    name="techCardId"
                    value={techCardId}
                    onChange={(e) => setTechCardId(e.target.value)}
                    disabled={!isDraft}
                  >
                    <option value="">— без техкарты —</option>
                    {showCurrentTechCardFallback && order.techCardId && (
                      <option value={order.techCardId}>
                        {order.techCardName ?? 'Текущая техкарта'} — неактивна
                      </option>
                    )}
                    {techCards.map((tc) => (
                      <option key={tc.id} value={tc.id}>
                        {tc.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="admin-field">
                  <label htmlFor="routeTemplateId">Маршрут</label>
                  <select
                    id="routeTemplateId"
                    name="routeTemplateId"
                    value={routeTemplateId}
                    onChange={(e) => setRouteTemplateId(e.target.value)}
                    disabled={!isDraft}
                  >
                    <option value="">— без маршрута —</option>
                    {showCurrentRouteFallback && order.routeTemplateId && (
                      <option value={order.routeTemplateId}>
                        {order.routeTemplateName ?? 'Текущий шаблон'} — неактивен
                      </option>
                    )}
                    {routeTemplates.map((tpl) => (
                      <option
                        key={tpl.id}
                        value={tpl.id}
                        disabled={tpl.stepsCount === 0}
                      >
                        {tpl.name}
                        {tpl.stepsCount === 0 ? ' — нет шагов' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {selectedRoute && selectedRoute.steps.length > 0 ? (
                <div className="admin-order-route-preview">
                  <AdminRouteSteps
                    steps={selectedRoute.steps}
                    ariaLabel={`Шаги маршрута «${selectedRoute.name}»`}
                    dense
                  />
                </div>
              ) : (
                <div className="admin-order-summary admin-order-summary--blue">
                  <span className="admin-order-summary__title">Маршрут</span>
                  <span className="admin-order-summary__value">
                    Маршрут не выбран
                  </span>
                </div>
              )}
            </AdminCard>
          </div>

          <AdminCard className="admin-order-card admin-order-card--sizes">
            <header className="admin-order-card__header">
              <span className="admin-order-card__icon admin-order-card__icon--violet">
                <Grid3X3 size={18} strokeWidth={1.7} aria-hidden />
              </span>
              <h2 className="admin-order-card__title">План по размерам</h2>
            </header>

            {sortedSizes.length === 0 ? (
              <p className="admin-muted" style={{ margin: 0 }}>
                Справочник размеров пуст.
              </p>
            ) : (
              <>
                <AdminSizeGrid
                  sizes={sizeGridSizes}
                  values={initialQty}
                  onTotalChange={setSizesTotal}
                  readOnly={!isDraft}
                />
                <div className="admin-order-form__sizes-footer">
                  <div
                    className={
                      'admin-order-summary admin-order-summary--green' +
                      (sizesTotal > 0 ? ' admin-order-summary--active' : '')
                    }
                  >
                    <span className="admin-order-summary__title">
                      Итого по плану
                    </span>
                    <span className="admin-order-summary__value">
                      {totalLabel}
                    </span>
                  </div>
                  <span className="admin-order-form__hint">
                    {isDraft
                      ? 'Enter — следующий размер'
                      : 'План фиксируется снапшотом после запуска.'}
                  </span>
                </div>
              </>
            )}
          </AdminCard>
        </div>

        <div className="admin-order-form__actions">
          <Link
            href={`/admin/orders/${order.id}`}
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            Отмена
          </Link>
          <SubmitButton />
        </div>
      </OrderWorkspaceLayout>
    </form>
  );
}
