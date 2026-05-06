'use client';

/**
 * Admin Order Form — карточный layout создания заказа на
 * `/admin/orders/new`. После «Order workspace v2»-рефакторинга
 * страница строится по схеме `OrderWorkspaceLayout`:
 *
 *   - hero «Основное» (`OrderHeroCard`):
 *       - управленческие поля заказа (подразделение / срок / клиент /
 *         цена + валюта / комментарий), редактируются прямо тут
 *         как часть общей `<form action={createOrderAction}>`;
 *       - короткие KPI (Тираж по выбранным размерам);
 *       - submit-кнопка «Создать заказ» в action-слоте;
 *   - вкладка «Продукция» (единственная активная в create-mode):
 *       - выбор лекала (`patternItemId`), цвет, размерная матрица,
 *         техкарта (`techCardId`), маршрут (`routeTemplateId`),
 *         нанесения (`OrderApplicationsEditor`).
 *
 * Этап «Номенклатура = Лекала» (см. `docs/recon-soft-integration.md
 * §«Номенклатура = Лекала»»): пользователь выбирает только лекало
 * (`PatternItem`); legacy `Product` в форме отсутствует — backend
 * сам обеспечивает `OrderItem.productId` через
 * `OrdersService.ensureLegacyProductForPattern()`.
 *
 * Backend / DTO / Prisma не трогаем: форма продолжает сабмитить
 * `createOrderAction` (`apps/web/app/orders/actions.ts`),
 * FormData-ключи остаются прежними:
 *   - `orderDate`, `dueDate`, `clientId`, `companyDivisionId`,
 *     `color`, `comment`, `routeTemplateId`, `techCardId`,
 *     `patternItemId`, `qty[<sizeId>]`, `applicationsJson`,
 *     `customerUnitPrice`, `customerCurrency`, hidden
 *     `redirectTo="admin"`.
 *
 * Никаких autosave / drafts на load — заказ создаётся **только**
 * по нажатию submit. Hero и Product tab лежат внутри ОДНОГО
 * `<form>`, поэтому FormData собирается атомарно.
 */

import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ImageIcon,
  Save,
  Shirt,
  Stamp,
  Workflow,
} from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';
import type { SizeDto } from '@sewing/shared/orders';
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
  PatternHeroPreview,
  type AdminRouteStep,
} from '@/components/admin';
import { OrderApplicationsEditor } from '@/components/orders/order-applications-editor';
import {
  OrderHeroCard,
  type OrderHeroKpi,
} from '@/components/orders/order-hero-card';
import { OrderDetailTabs } from '@/components/orders/order-detail-tabs';
import {
  OrderTabEmptyState,
  OrderWorkspaceLayout,
} from '@/components/orders/order-workspace-layout';
import {
  ORDER_DETAIL_TABS,
  getOrderDetailTabConfig,
  type OrderDetailTabId,
} from '@/components/orders/order-detail-tabs-config';
import {
  createOrderAction,
  type FormActionState,
} from '@/app/orders/actions';
import { SizePlanSelector } from './size-plan-selector';

/**
 * Мини-DTO для превью маршрута (только то, что нужно
 * `AdminRouteSteps`). Грузится на сервере и передаётся как plain JSON.
 */
export interface RoutePreview {
  id: string;
  name: string;
  steps: AdminRouteStep[];
}

interface Props {
  sizes: SizeDto[];
  routeTemplates: RouteTemplateSummaryDto[];
  routePreviewMap: Record<string, RoutePreview>;
  techCards: TechCardTemplateSummaryDto[];
  clients: ClientDto[];
  patterns: PatternListItemDto[];
  /**
   * Активные карточки `CompanyDivision` (см.
   * `docs/domain.md §«Подразделения заказа»`) для select-а.
   * Backend шлёт только активных, чтобы менеджер не выбирал
   * «зомби»-карточки.
   */
  companyDivisions: CompanyDivisionDto[];
  /**
   * Список складов для select-а «Склад выпуска готовой продукции»
   * (см. `prisma/schema.prisma::Order.finishedGoodsWarehouseId`).
   * Это **управленческое** поле — выбранный склад не влияет на
   * `StockBalance` / `StockMovement` материалов.
   */
  warehouses: WarehouseSummaryDto[];
  today: string;
}

const initialState: FormActionState = {};

function SubmitButton({
  label = 'Создать заказ',
}: {
  label?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохранение…' : label}
    </button>
  );
}

export function AdminCreateOrderForm({
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
  const [state, formAction] = useFormState(createOrderAction, initialState);

  const [color, setColor] = useState<string>('');

  const sortedSizes = useMemo(
    () => [...sizes].sort((a, b) => a.sortOrder - b.sortOrder),
    [sizes],
  );

  const [routeTemplateId, setRouteTemplateId] = useState<string>('');
  const selectedRoute = routeTemplateId
    ? routePreviewMap[routeTemplateId]
    : undefined;

  const [techCardId, setTechCardId] = useState<string>('');

  const [patternItemId, setPatternItemId] = useState<string>('');
  const selectedPattern = useMemo(
    () => patterns.find((p) => p.id === patternItemId) ?? null,
    [patternItemId, patterns],
  );

  // Hero «Основное» state — управляемые поля верхнего блока
  // карточки. Все они сабмитятся как обычные uncontrolled-имена в
  // том же `<form>` (см. JSX), а в state хранятся для KPI и
  // productSummary в hero (без round-trip-а).
  const [clientId, setClientId] = useState<string>('');
  // Подразделение заказа — FK на `CompanyDivision`. Дефолт —
  // карточка с `code = OTHER` (B2B), которую гарантированно создаёт
  // миграция/seed. Если её каким-то образом нет в списке — пустая
  // строка.
  const defaultCompanyDivisionId =
    companyDivisions.find((d) => d.code === 'OTHER')?.id ??
    companyDivisions[0]?.id ??
    '';
  const [companyDivisionId, setCompanyDivisionId] = useState<string>(
    defaultCompanyDivisionId,
  );
  // Этап «Склад выпуска готовой продукции»: на create поле опционально,
  // дефолт — пустая строка («Не выбран»). Список ограничен активными.
  const activeWarehouses = useMemo(
    () => warehouses.filter((w) => w.isActive),
    [warehouses],
  );
  const [finishedGoodsWarehouseId, setFinishedGoodsWarehouseId] =
    useState<string>('');
  const [dueDate, setDueDate] = useState<string>('');
  const [customerUnitPrice, setCustomerUnitPrice] = useState<string>('');
  const [customerCurrency, setCustomerCurrency] =
    useState<MoneyCurrency>('RUB');
  const [comment, setComment] = useState<string>('');

  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const fieldError = (key: string): string | undefined =>
    state.fieldErrors?.[key];

  const availableSizes = useMemo<SizeDto[]>(() => {
    if (!selectedPattern) return [];
    return selectedPattern.sizes.map((s) => ({
      id: s.id,
      code: s.code,
      sortOrder: s.sortOrder,
    }));
  }, [selectedPattern]);

  const availableSizeIds = useMemo(
    () => new Set(availableSizes.map((s) => s.id)),
    [availableSizes],
  );

  useEffect(() => {
    setQuantities((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [sizeId, qty] of Object.entries(prev)) {
        if (availableSizeIds.has(sizeId)) {
          next[sizeId] = qty;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [availableSizeIds]);

  const handleQuantitiesChange = useCallback(
    (next: Record<string, number>) => {
      setQuantities(next);
    },
    [],
  );

  const sizesTotal = useMemo(
    () =>
      Object.values(quantities).reduce(
        (sum, v) => sum + (Number.isFinite(v) && v > 0 ? v : 0),
        0,
      ),
    [quantities],
  );

  const totalLabel = `${sizesTotal.toLocaleString('ru-RU')} шт.`;

  const selectedClient = useMemo(
    () => (clientId ? (clients.find((c) => c.id === clientId) ?? null) : null),
    [clientId, clients],
  );

  // Hero KPIs в create-mode — только короткое summary плана.
  // Финансовые показатели появятся после расчёта (см. /admin/orders/[id]).
  // Не показываем fake 0: «не задан» вместо нуля.
  const heroKpis: OrderHeroKpi[] = useMemo(() => {
    const list: OrderHeroKpi[] = [];
    list.push({
      id: 'qty',
      label: 'Тираж',
      value: sizesTotal > 0 ? sizesTotal.toLocaleString('ru-RU') : '—',
      unit: sizesTotal > 0 ? 'шт' : undefined,
      tone: sizesTotal > 0 ? 'neutral' : 'warning',
      hint:
        sizesTotal > 0
          ? undefined
          : 'Выберите номенклатуру и заполните размерную матрицу.',
    });
    if (customerUnitPrice && Number(customerUnitPrice) > 0) {
      const total = Number(customerUnitPrice) * sizesTotal;
      list.push({
        id: 'revenue',
        label: 'Выручка',
        value: Number.isFinite(total) && total > 0
          ? formatMoney(total, customerCurrency)
          : formatMoney(Number(customerUnitPrice), customerCurrency) + ' / шт',
        tone: 'info',
        hint: 'Тираж × цена продажи за единицу.',
      });
    } else {
      list.push({
        id: 'revenue',
        label: 'Выручка',
        value: '—',
        tone: 'warning',
        hint: 'Не указана цена продажи за единицу.',
      });
    }
    list.push({
      id: 'materials',
      label: 'Материалы',
      value: 'не рассчитаны',
      tone: 'warning',
      hint: 'Расчёт потребности появится после создания заказа.',
    });
    list.push({
      id: 'operations',
      label: 'Операции',
      value: 'не рассчитаны',
      tone: 'warning',
      hint: 'План операций появится после создания заказа и выбора маршрута.',
    });
    return list;
  }, [sizesTotal, customerUnitPrice, customerCurrency]);

  // В create-mode все вкладки кроме «Продукция» отключены — заказа
  // ещё нет. После submit createOrderAction редиректит на
  // `/admin/orders/<id>?tab=product`.
  const disabledTabs: OrderDetailTabId[] = ORDER_DETAIL_TABS.filter(
    (t) => t.id !== 'product',
  ).map((t) => t.id);

  // Empty-state для не-«Продукция» вкладок: показываем общий
  // плейсхолдер «Доступно после создания заказа», как и полагается
  // disabled-вкладкам (но в самом теле вкладки тоже подсказка).
  const otherTabsHints = ORDER_DETAIL_TABS.filter((t) => t.id !== 'product');

  return (
    <form action={formAction} className="admin-form admin-order-form">
      <input type="hidden" name="redirectTo" value="admin" />
      <input type="hidden" name="orderDate" value={today} />
      <input type="hidden" name="status" value="DRAFT" />

      {state.error && (
        <div role="alert" className="admin-order-form__error">
          <AlertCircle size={18} strokeWidth={1.6} aria-hidden />
          <span>{state.error}</span>
        </div>
      )}

      <OrderWorkspaceLayout
        mode="create"
        hero={
          <OrderHeroCard
            mode="create"
            number={null}
            status={null}
            productSummary={
              selectedPattern || sizesTotal > 0
                ? `Продукция: ${selectedPattern?.name ?? 'не выбрана'}${
                    sizesTotal > 0
                      ? ` · ${sizesTotal.toLocaleString('ru-RU')} шт`
                      : ''
                  }`
                : null
            }
            basics={
              <BasicsCreateFields
                clientId={clientId}
                onClientIdChange={setClientId}
                clients={clients}
                companyDivisionId={companyDivisionId}
                onCompanyDivisionIdChange={setCompanyDivisionId}
                companyDivisions={companyDivisions}
                finishedGoodsWarehouseId={finishedGoodsWarehouseId}
                onFinishedGoodsWarehouseIdChange={
                  setFinishedGoodsWarehouseId
                }
                warehouses={activeWarehouses}
                dueDate={dueDate}
                onDueDateChange={setDueDate}
                today={today}
                customerUnitPrice={customerUnitPrice}
                onCustomerUnitPriceChange={setCustomerUnitPrice}
                customerCurrency={customerCurrency}
                onCustomerCurrencyChange={setCustomerCurrency}
                comment={comment}
                onCommentChange={setComment}
                fieldError={fieldError}
              />
            }
            kpis={heroKpis}
            workflowActions={
              <>
                <Link
                  href="/admin/orders"
                  className="admin-btn admin-btn--ghost"
                >
                  <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
                </Link>
                <SubmitButton />
              </>
            }
          />
        }
        tabs={
          <OrderDetailTabs
            orderId={null}
            activeTab="product"
            disabledTabs={disabledTabs}
          />
        }
      >
        {/* === Tab: Продукция === */}
        <div className="order-tab-panel order-product-tab">
          <ProductCreateTab
            patternItemId={patternItemId}
            onPatternItemIdChange={setPatternItemId}
            patterns={patterns}
            selectedPattern={selectedPattern}
            color={color}
            onColorChange={setColor}
            techCardId={techCardId}
            onTechCardIdChange={setTechCardId}
            techCards={techCards}
            routeTemplateId={routeTemplateId}
            onRouteTemplateIdChange={setRouteTemplateId}
            routeTemplates={routeTemplates}
            selectedRoute={selectedRoute}
            sortedSizes={sortedSizes}
            availableSizes={availableSizes}
            quantities={quantities}
            onQuantitiesChange={handleQuantitiesChange}
            sizesTotal={sizesTotal}
            totalLabel={totalLabel}
            fieldError={fieldError}
          />
        </div>

        {/* === Tab placeholders for disabled tabs (smoke-friendly text) ===
            На MVP в create-mode мы рендерим только tab body «Продукция»;
            empty-state-плашки показываются как дополнительные секции
            под формой, чтобы менеджер сразу видел, что появится после
            создания заказа. Сами `OrderDetailTabs` в этих вкладках
            отрендерены как `disabled` и кликнуть по ним нельзя. */}
        <div className="order-tab-empty-states">
          {otherTabsHints.map((cfg) => {
            const tabConfig = getOrderDetailTabConfig(cfg.id);
            return (
              <OrderTabEmptyState
                key={cfg.id}
                title={tabConfig.emptyStateTitle}
                hint={tabConfig.emptyStateHint}
              />
            );
          })}
        </div>
      </OrderWorkspaceLayout>
    </form>
  );
}

/**
 * Поля «Основное» в hero create-формы. Всё едет в общий
 * `<form action={createOrderAction}>` через те же
 * `name="…"`-атрибуты, что и раньше — никакого отдельного submit-а.
 */
function BasicsCreateFields({
  clientId,
  onClientIdChange,
  clients,
  companyDivisionId,
  onCompanyDivisionIdChange,
  companyDivisions,
  finishedGoodsWarehouseId,
  onFinishedGoodsWarehouseIdChange,
  warehouses,
  dueDate,
  onDueDateChange,
  today,
  customerUnitPrice,
  onCustomerUnitPriceChange,
  customerCurrency,
  onCustomerCurrencyChange,
  comment,
  onCommentChange,
  fieldError,
}: {
  clientId: string;
  onClientIdChange: (v: string) => void;
  clients: ClientDto[];
  /** Выбор подразделения через FK на `CompanyDivision`. */
  companyDivisionId: string;
  onCompanyDivisionIdChange: (v: string) => void;
  companyDivisions: CompanyDivisionDto[];
  /** Выбор склада выпуска готовой продукции (управленческое поле). */
  finishedGoodsWarehouseId: string;
  onFinishedGoodsWarehouseIdChange: (v: string) => void;
  warehouses: WarehouseSummaryDto[];
  dueDate: string;
  onDueDateChange: (v: string) => void;
  today: string;
  customerUnitPrice: string;
  onCustomerUnitPriceChange: (v: string) => void;
  customerCurrency: MoneyCurrency;
  onCustomerCurrencyChange: (v: MoneyCurrency) => void;
  comment: string;
  onCommentChange: (v: string) => void;
  fieldError: (key: string) => string | undefined;
}) {
  const selectedDivisionCard = companyDivisions.find(
    (d) => d.id === companyDivisionId,
  );
  return (
    <div className="order-hero-card__basic-grid">
      <div className="order-hero-card__field">
        <label htmlFor="companyDivisionId">Подразделение</label>
        <select
          id="companyDivisionId"
          name="companyDivisionId"
          value={companyDivisionId}
          onChange={(e) => onCompanyDivisionIdChange(e.target.value)}
          required
        >
          {companyDivisions.length === 0 && (
            <option value="">— нет подразделений —</option>
          )}
          {companyDivisions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        {selectedDivisionCard?.code &&
          selectedDivisionCard.code !== 'MARKETPLACE' &&
          selectedDivisionCard.code !== 'OTHER' && (
            <span
              className="order-hero-card__field-hint"
              style={{ fontSize: '0.78rem' }}
            >
              Для подразделения «{selectedDivisionCard.name}» дисплей
              работает по той же логике, что B2B.
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
            onFinishedGoodsWarehouseIdChange(e.target.value)
          }
        >
          <option value="">— не выбран —</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.code ? ` (${w.code})` : ''}
            </option>
          ))}
        </select>
        <span className="order-hero-card__field-hint">
          Склад, на который должна поступить готовая продукция после
          производства / упаковки. Это не склад материалов.
        </span>
      </div>

      <div className="order-hero-card__field">
        <label htmlFor="dueDate">Срок сдачи</label>
        <AdminDateField
          id="dueDate"
          name="dueDate"
          min={today}
          value={dueDate}
          onChange={(e) => onDueDateChange(e.target.value)}
        />
      </div>

      <div className="order-hero-card__field">
        <label htmlFor="clientId">Клиент</label>
        <select
          id="clientId"
          name="clientId"
          value={clientId}
          onChange={(e) => onClientIdChange(e.target.value)}
        >
          <option value="">— без клиента —</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {clients.length === 0 && (
          <span className="order-hero-card__field-hint">
            Список клиентов пуст.{' '}
            <Link href="/admin/clients/new">Добавить?</Link>
          </span>
        )}
      </div>

      <div className="order-hero-card__field order-hero-card__field--price">
        <label htmlFor="customerUnitPrice">Цена за 1 шт</label>
        <div className="order-hero-card__price-row">
          <input
            id="customerUnitPrice"
            name="customerUnitPrice"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={customerUnitPrice}
            onChange={(e) => onCustomerUnitPriceChange(e.target.value)}
          />
          <select
            id="customerCurrency"
            name="customerCurrency"
            value={customerCurrency}
            onChange={(e) =>
              onCustomerCurrencyChange(e.target.value as MoneyCurrency)
            }
            aria-label="Валюта"
          >
            {MONEY_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {MONEY_CURRENCY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        {fieldError('customerUnitPrice') && (
          <span className="order-hero-card__field-error">
            {fieldError('customerUnitPrice')}
          </span>
        )}
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
          onChange={(e) => onCommentChange(e.target.value)}
        />
      </div>

      {/* Заказчик free-text — короткое поле для случая, когда клиент
          не выбран из справочника (управленческое поле). */}
      <input type="hidden" name="customer" value="" />
    </div>
  );
}

/**
 * Содержимое вкладки «Продукция» в create-mode.
 *
 * Сюда переехало всё, что относится к самому изделию: выбор
 * номенклатуры (лекала), цвет, размерная матрица, техкарта,
 * маршрут, нанесения. Эти поля **не** дублируются в hero.
 */
function ProductCreateTab({
  patternItemId,
  onPatternItemIdChange,
  patterns,
  selectedPattern,
  color,
  onColorChange,
  techCardId,
  onTechCardIdChange,
  techCards,
  routeTemplateId,
  onRouteTemplateIdChange,
  routeTemplates,
  selectedRoute,
  sortedSizes,
  availableSizes,
  quantities,
  onQuantitiesChange,
  sizesTotal,
  totalLabel,
  fieldError,
}: {
  patternItemId: string;
  onPatternItemIdChange: (v: string) => void;
  patterns: PatternListItemDto[];
  selectedPattern: PatternListItemDto | null;
  color: string;
  onColorChange: (v: string) => void;
  techCardId: string;
  onTechCardIdChange: (v: string) => void;
  techCards: TechCardTemplateSummaryDto[];
  routeTemplateId: string;
  onRouteTemplateIdChange: (v: string) => void;
  routeTemplates: RouteTemplateSummaryDto[];
  selectedRoute: RoutePreview | undefined;
  sortedSizes: SizeDto[];
  availableSizes: SizeDto[];
  quantities: Record<string, number>;
  onQuantitiesChange: (v: Record<string, number>) => void;
  sizesTotal: number;
  totalLabel: string;
  fieldError: (key: string) => string | undefined;
}) {
  return (
    <>
      <div className="admin-order-form__grid admin-order-form__top">
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
                onChange={(e) => onPatternItemIdChange(e.target.value)}
                required
                aria-describedby="patternItemId-hint"
              >
                <option value="">— выберите номенклатуру —</option>
                {patterns.map((pt) => (
                  <option key={pt.id} value={pt.id}>
                    {pt.name} · {pt.article}
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
              {patterns.length === 0 && (
                <span className="admin-field__hint admin-muted">
                  Список лекал пуст.{' '}
                  <Link href="/admin/patterns/new">Добавить?</Link>
                </span>
              )}
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
                onChange={(e) => onColorChange(e.target.value)}
                placeholder="не задан"
                maxLength={64}
              />
            </div>
          </div>
        </AdminCard>

        <AdminCard className="admin-order-card admin-order-card--hero">
          <header className="admin-order-card__header">
            <span className="admin-order-card__icon admin-order-card__icon--violet">
              <ImageIcon size={18} strokeWidth={1.7} aria-hidden />
            </span>
            <h2 className="admin-order-card__title">Превью изделия</h2>
          </header>
          <PatternHeroPreview pattern={selectedPattern} />
        </AdminCard>
      </div>

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
              onChange={(e) => onTechCardIdChange(e.target.value)}
            >
              <option value="">— без техкарты —</option>
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
              onChange={(e) => onRouteTemplateIdChange(e.target.value)}
            >
              <option value="">— без маршрута —</option>
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

        {selectedPattern && (
          <div className="admin-order-pattern-summary">
            <span className="admin-order-pattern-summary__label">
              Лекало
            </span>
            <span className="admin-order-pattern-summary__value">
              {selectedPattern.name} · {selectedPattern.article}
            </span>
          </div>
        )}

        {selectedRoute && selectedRoute.steps.length > 0 ? (
          <div className="admin-order-route-preview">
            <AdminRouteSteps
              steps={selectedRoute.steps}
              ariaLabel={`Шаги маршрута «${selectedRoute.name}»`}
              dense
            />
          </div>
        ) : (
          <div className="admin-order-summary admin-order-summary--blue admin-order-summary--compact">
            <span className="admin-order-summary__title">Маршрут</span>
            <span className="admin-order-summary__value">
              Маршрут не выбран
            </span>
          </div>
        )}
      </AdminCard>

      <AdminCard className="admin-order-card admin-order-card--applications">
        <header className="admin-order-card__header">
          <span className="admin-order-card__icon admin-order-card__icon--violet">
            <Stamp size={18} strokeWidth={1.7} aria-hidden />
          </span>
          <h2 className="admin-order-card__title">Нанесение</h2>
        </header>
        <p className="admin-muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
          Параметры нанесения хранятся в заказе. На крое блокируется
          раскладка, пока параметры не заполнены.
        </p>
        <OrderApplicationsEditor />
      </AdminCard>

      <AdminCard className="admin-order-card admin-order-card--sizes">
        <header className="admin-order-card__header admin-order-card__header--with-meta">
          <h2 className="admin-order-card__title">План по размерам</h2>
          <span
            className={
              'admin-order-card__meta' +
              (sizesTotal > 0 ? ' admin-order-card__meta--active' : '')
            }
            aria-live="polite"
          >
            <span className="admin-order-card__meta-label">Итого:</span>{' '}
            <span className="admin-order-card__meta-value">{totalLabel}</span>
          </span>
        </header>

        {sortedSizes.length === 0 ? (
          <p className="admin-muted" style={{ margin: 0 }}>
            Справочник размеров пуст. Добавьте размеры, прежде чем создавать
            заказ.
          </p>
        ) : (
          <SizePlanSelector
            allSizes={sortedSizes}
            availableSizes={availableSizes}
            quantities={quantities}
            onQuantitiesChange={onQuantitiesChange}
            selectedPatternName={selectedPattern?.name ?? null}
            selectedPatternArticle={selectedPattern?.article ?? null}
          />
        )}

        <div className="admin-size-plan__hidden-inputs" hidden aria-hidden>
          {sortedSizes.map((s) => (
            <input
              key={s.id}
              type="hidden"
              name={`qty[${s.id}]`}
              value={String(quantities[s.id] ?? 0)}
            />
          ))}
        </div>
      </AdminCard>
    </>
  );
}

function formatMoney(value: number, currency: MoneyCurrency): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}
