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
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Grid3X3,
  Plus,
  Save,
  Shirt,
  Workflow,
} from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';
import type {
  OrderDetailDto,
  OrderMaterialsAndHardwareCostPolicy,
  OrderStatus,
  SizeDto,
} from '@sewing/shared/orders';
import {
  ORDER_MATERIALS_AND_HARDWARE_COST_POLICIES,
  ORDER_MATERIALS_AND_HARDWARE_COST_POLICY_LABELS,
  isOrderPlanEditable,
} from '@sewing/shared/orders';
import {
  MONEY_CURRENCIES,
  MONEY_CURRENCY_LABELS,
  type MoneyCurrency,
} from '@sewing/shared/money';
import type { PatternListItemDto } from '@sewing/shared/patterns';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
import type { PatternCategoryListItemDto } from '@sewing/shared/pattern-categories';
import {
  AdminCard,
  AdminDateField,
  AdminRouteSteps,
  AdminSizeGrid,
  type AdminRouteStep,
} from '@/components/admin';
import { formatOrderStatus } from '@/lib/admin-labels';
import {
  SendPatternToConstructorButton,
  type SendPatternToConstructorSize,
} from '@/components/constructor/send-pattern-to-constructor';
import {
  CreateProductInline,
  type SavedConstructorDraftPayload,
  type SavedInlineProductPayload,
} from '@/app/admin/orders/new/create-product-inline';
import {
  SavedConstructorTaskCard,
  SavedInlineProductCard,
} from '@/app/admin/orders/new/admin-create-order-form';
import {
  OrderColorwaysFieldset,
  makeEmptyColorway,
  type ColorwayDraft,
} from '@/app/admin/orders/new/order-create-colorways';
import {
  attachConstructorTaskPatternToOrderAction,
  createInlineProductForEditAction,
} from './inline-product-actions';
import {
  OrderHeroCard,
  type OrderHeroKpi,
} from '@/components/orders/order-hero-card';
import { OrderDetailTabs } from '@/components/orders/order-detail-tabs';
import { OrderWorkspaceLayout } from '@/components/orders/order-workspace-layout';
import { OrderConstructorTaskCard } from '@/components/orders/order-constructor-task-card';
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
   * Активные группы номенклатуры — нужны модалке «Создать изделие»
   * (`CreateProductInline`) в блоке «Изделие». На MVP в самом select-е
   * лекала они не используются.
   */
  patternCategories: PatternCategoryListItemDto[];
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
  /**
   * Фича «Расцветки» (FEATURE_COLORWAYS): под флагом размерная матрица
   * заменяется карточками расцветок (как на форме создания и на карточке
   * заказа) — единый UX «цвет × размер × техкарта». Off → прежняя плоская
   * матрица `AdminSizeGrid`.
   */
  colorwaysEnabled: boolean;
  /**
   * Сид расцветок заказа (из `getOrderColorways`) для редактора. Пусто =
   * заведём одну пустую карточку. Используется только при
   * `colorwaysEnabled`.
   */
  initialColorways: ColorwayDraft[];
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
  patternCategories,
  companyDivisions,
  warehouses,
  today,
  colorwaysEnabled,
  initialColorways,
}: Props) {
  const router = useRouter();
  const action = updateAdminOrderAction.bind(null, order.id);
  const [state, formAction] = useFormState(action, initialState);

  const isDraft = order.status === 'DRAFT';
  const isTerminal = order.status === 'DONE' || order.status === 'CANCELLED';
  // Безопасные плановые поля (подразделение, маршрут) правятся до запуска
  // производства (DRAFT/CALCULATION/CALCULATION_DONE) — единый хелпер.
  const planEditable = isOrderPlanEditable(order.status);
  // Расцветки/спецификация правятся в edit-форме только DRAFT/CALCULATION
  // (backend отбивает `variants` вне этого окна `ORDER_COLORWAYS_LOCKED`).
  // На CALCULATION_DONE — read-only, правка через «Вернуть на пересчёт».
  const colorwaysEditable =
    order.status === 'DRAFT' || order.status === 'CALCULATION';

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

  // ── State machine блока «Изделие» (паритет с create-формой) ────────
  // Те же 4 состояния, что на /admin/orders/new: EMPTY / SELECTING /
  // CREATING / CREATED. Начальное состояние — CREATED, если у заказа
  // уже есть `patternItemId`; иначе EMPTY (новый DRAFT-заказ без
  // лекала). Транзитные изменения PATCH-ятся через server action
  // (см. `inline-product-actions.ts`).
  type ProductBlockMode = 'EMPTY' | 'SELECTING' | 'CREATING' | 'CREATED';
  const initialProductBlockMode: ProductBlockMode = order.patternItemId
    ? 'CREATED'
    : 'EMPTY';
  const [productBlockMode, setProductBlockMode] = useState<ProductBlockMode>(
    initialProductBlockMode,
  );
  const [inlineInitialTab, setInlineInitialTab] = useState<
    'calculate' | 'constructor'
  >('calculate');
  // Сохранённое в этой сессии inline-изделие (calc) или результат
  // отправки конструктору. В отличие от create-формы, эти state-ы
  // временные: после router.refresh они сбрасываются, и UI берёт
  // текущую привязку из `order.patternItemId` (см. CREATED-render).
  const [savedInlineProduct, setSavedInlineProduct] =
    useState<SavedInlineProductPayload | null>(null);
  const [savedConstructorTask, setSavedConstructorTask] =
    useState<SavedConstructorDraftPayload | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [isAttachingInline, startAttachInlineTransition] = useTransition();

  const orderDateValue = order.orderDate.slice(0, 10);
  const dueDateInitial = order.dueDate ? order.dueDate.slice(0, 10) : '';
  const [dueDate, setDueDate] = useState<string>(dueDateInitial);

  const [status, setStatus] = useState<OrderStatus>(order.status);

  const initialQty = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const it of order.items) map[it.sizeId] = it.qtyPlan;
    return map;
  }, [order.items]);

  // Размеры заказа для модалки «Отправить конструктору» — по строкам
  // заказа, код размера достаём из справочника (`sortedSizes`).
  const orderConstructorSizes = useMemo<SendPatternToConstructorSize[]>(() => {
    const codeById = new Map(sortedSizes.map((s) => [s.id, s.code]));
    const seen = new Set<string>();
    const out: SendPatternToConstructorSize[] = [];
    for (const it of order.items) {
      if (seen.has(it.sizeId)) continue;
      seen.add(it.sizeId);
      out.push({ sizeId: it.sizeId, sizeCode: codeById.get(it.sizeId) ?? it.sizeId });
    }
    return out;
  }, [order.items, sortedSizes]);

  const initialTotal = useMemo(
    () => Object.values(initialQty).reduce((s, n) => s + n, 0),
    [initialQty],
  );
  const [sizesTotal, setSizesTotal] = useState<number>(initialTotal);

  // ── Фича «Расцветки» (FEATURE_COLORWAYS) ───────────────────────────
  // Под флагом плоская матрица заменяется карточками расцветок (цвет +
  // техкарта + поразмерный план) — тот же редактор, что на форме
  // создания. Сид — из `getOrderColorways`; пусто → одна пустая карточка.
  const [colorways, setColorways] = useState<ColorwayDraft[]>(() =>
    initialColorways.length > 0
      ? initialColorways.map((c) => ({ ...c, sizes: { ...c.sizes } }))
      : [makeEmptyColorway()],
  );

  // Колонки-размеры карточек = размеры выбранного лекала. Реактивно
  // следует за сменой лекала (как в форме создания).
  const availableSizes = useMemo<SizeDto[]>(() => {
    if (!selectedPattern) return [];
    return selectedPattern.sizes.map((s) => ({
      id: s.id,
      code: s.code,
      sortOrder: s.sortOrder,
    }));
  }, [selectedPattern]);

  const allSizeIds = useMemo(
    () => new Set(sortedSizes.map((s) => s.id)),
    [sortedSizes],
  );

  // Доп.размеры сида (сверх лекала) — чтобы их колонки показались сразу.
  // Считаем ОДИН раз от начального сида и начального набора размеров
  // лекала: дальше редактор ведёт extra-размеры сам.
  const initialExtraSizeIds = useMemo<string[]>(() => {
    if (!colorwaysEnabled) return [];
    const patternIds = new Set(
      (selectedPattern?.sizes ?? []).map((s) => s.id),
    );
    const seen = new Set<string>();
    const out: string[] = [];
    for (const cw of initialColorways) {
      for (const [sizeId, qty] of Object.entries(cw.sizes)) {
        if (
          qty > 0 &&
          allSizeIds.has(sizeId) &&
          !patternIds.has(sizeId) &&
          !seen.has(sizeId)
        ) {
          seen.add(sizeId);
          out.push(sizeId);
        }
      }
    }
    return out;
    // Намеренно только от начальных значений — это стартовый снимок.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Расцветки → агрегат заказа. `sizesTotal` = Σ по всем цветам/размерам,
  // цвет заказа = первый непустой. Мирроринг эффектов формы создания.
  useEffect(() => {
    if (!colorwaysEnabled) return;
    let total = 0;
    for (const cw of colorways) {
      for (const [sizeId, qty] of Object.entries(cw.sizes)) {
        if (allSizeIds.has(sizeId) && qty > 0) total += qty;
      }
    }
    setSizesTotal(total);
    setColor(colorways.find((c) => c.color.trim())?.color.trim() ?? '');
  }, [colorways, colorwaysEnabled, allSizeIds]);

  // Полезная нагрузка `variantsJson` — только непустые расцветки (цвет
  // задан) и размеры с qty>0. Пусто → шлём `[]` (backend расцветки не
  // трогает).
  const variantsPayload = useMemo(
    () =>
      colorways
        .map((cw) => ({
          color: cw.color.trim(),
          techCardId: cw.techCardId,
          sizes: Object.entries(cw.sizes)
            .filter(([sid, q]) => allSizeIds.has(sid) && q > 0)
            .map(([sizeId, qtyPlan]) => ({ sizeId, qtyPlan })),
        }))
        .filter((cw) => cw.color.length > 0 && cw.sizes.length > 0),
    [colorways, allSizeIds],
  );

  /**
   * Колбэк, который CreateProductInline передаёт после клика
   * «Сохранить изделие» (calc) или «Отправить» (constructor).
   * Здесь — единственное отличие от create-формы: вместо записи в
   * hidden inputs мы сразу зовём server action, чтобы attach-ить
   * лекало к УЖЕ существующему заказу.
   */
  const handleInlineSave = (
    result:
      | { kind: 'calculate'; payload: SavedInlineProductPayload }
      | { kind: 'constructor'; result: SavedConstructorDraftPayload },
  ): void => {
    setInlineError(null);
    if (result.kind === 'calculate') {
      // Запоминаем calc-payload в state на случай переключения на
      // constructor-вкладку в этой же сессии модалки. Сам attach к
      // заказу делаем в server action.
      setSavedInlineProduct(result.payload);
      setSavedConstructorTask(null);
      startAttachInlineTransition(async () => {
        const r = await createInlineProductForEditAction(
          order.id,
          result.payload,
        );
        if (!r.ok) {
          setInlineError(r.error ?? 'Не удалось создать изделие');
          return;
        }
        if (r.patternItemId) {
          // Свежепривязанное лекало — обновляем state, hidden input
          // подхватит его на следующем submit. router.refresh ниже
          // подтянет актуальные `order` / `patterns`.
          setPatternItemId(r.patternItemId);
        }
        setProductBlockMode('CREATED');
        router.refresh();
      });
    } else {
      // Constructor flow: server action в модалке уже создал DRAFT-
      // PatternItem + ConstructorTask, сюда возвращается только
      // result. Нам остаётся PATCH-нуть заказ, привязав patternItemId.
      setSavedConstructorTask(result.result);
      setSavedInlineProduct(null);
      setPatternItemId(result.result.patternItemId);
      startAttachInlineTransition(async () => {
        const r = await attachConstructorTaskPatternToOrderAction(
          order.id,
          result.result.patternItemId,
        );
        if (!r.ok) {
          setInlineError(r.error ?? 'Не удалось привязать лекало к заказу');
          return;
        }
        setProductBlockMode('CREATED');
        router.refresh();
      });
    }
  };

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
  // Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
  // `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`).
  // Default — `INCLUDE` (старая семантика «учитывается в себестоимости»).
  // Управленческое поле — меняется на любом статусе заказа, без
  // ORDER_LOCKED-ограничений.
  const [
    materialsAndHardwareCostPolicy,
    setMaterialsAndHardwareCostPolicy,
  ] = useState<OrderMaterialsAndHardwareCostPolicy>(
    order.materialsAndHardwareCostPolicy ?? 'INCLUDE',
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
      {/* Фича «Расцветки»: под флагом «Цвет» и расцветки заказа сабмитятся
          отсюда (видимые инпуты «Цвет» и общий выбор техкарты скрыты).
          `color` = первый непустой цвет, `variantsJson` = все расцветки.
          На CALCULATION_DONE НЕ сабмитим — иначе backend отобьёт правку
          любого поля кодом `ORDER_COLORWAYS_LOCKED` (расцветки правятся
          только DRAFT/CALCULATION, дальше — через «Вернуть на пересчёт»). */}
      {colorwaysEnabled && colorwaysEditable && (
        <>
          <input type="hidden" name="color" value={color} />
          <input
            type="hidden"
            name="variantsJson"
            value={JSON.stringify(variantsPayload)}
          />
        </>
      )}
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
              ? 'Заказ в статусе «Расчёт»: доступны подразделение, маршрут, расцветки/спецификация и управленческие поля (клиент, срок, комментарий). Изделие и лекало — только в «Черновике».'
              : order.status === 'CALCULATION_DONE'
                ? 'Заказ в статусе «Расчёт завершён»: до запуска производства доступны подразделение, маршрут и управленческие поля. Состав, лекало, техкарту и спецификацию правьте через «Вернуть на пересчёт».'
                : 'Заказ уже запущен в производство — план заморожен. Доступны только управленческие поля и безопасные переходы статуса.'}
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
                    disabled={!planEditable}
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
                  {!planEditable && (
                    <span className="order-hero-card__field-hint">
                      Менять подразделение можно только до запуска
                      производства.
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
                  <label htmlFor="materialsAndHardwareCostPolicy">
                    Учет материалов и фурнитуры в себестоимости
                  </label>
                  <select
                    id="materialsAndHardwareCostPolicy"
                    name="materialsAndHardwareCostPolicy"
                    value={materialsAndHardwareCostPolicy}
                    onChange={(e) =>
                      setMaterialsAndHardwareCostPolicy(
                        e.target.value as OrderMaterialsAndHardwareCostPolicy,
                      )
                    }
                  >
                    {ORDER_MATERIALS_AND_HARDWARE_COST_POLICIES.map((p) => (
                      <option key={p} value={p}>
                        {p === 'EXCLUDE'
                          ? 'Не учитывать — давальческое сырьё / фурнитура клиента'
                          : ORDER_MATERIALS_AND_HARDWARE_COST_POLICY_LABELS[p]}
                      </option>
                    ))}
                  </select>
                  <span className="order-hero-card__field-hint">
                    Если материалы или фурнитуру предоставляет клиент,
                    выберите «Не учитывать». Потребность по количеству
                    всё равно будет рассчитана и показана, но стоимость
                    материалов и фурнитуры не войдёт в себестоимость
                    заказа.
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
            <AdminCard
              className={
                'admin-order-card admin-order-card--product' +
                (productBlockMode === 'CREATING' ||
                productBlockMode === 'CREATED'
                  ? ' admin-order-card--full-row'
                  : '')
              }
            >
              <header className="admin-order-card__header admin-order-card__header--with-meta">
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <span className="admin-order-card__icon admin-order-card__icon--pink">
                    <Shirt size={18} strokeWidth={1.7} aria-hidden />
                  </span>
                  <h2 className="admin-order-card__title">Изделие</h2>
                </div>
                {/* Две кнопки шапки — паритет с create-формой.
                    Только для DRAFT-заказа: на запущенном поменять
                    лекало нельзя (backend всё равно отдаст 409). */}
                {isDraft && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className={
                        'admin-btn ' +
                        (productBlockMode === 'SELECTING'
                          ? 'admin-btn--primary'
                          : 'admin-btn--ghost')
                      }
                      onClick={() => {
                        setInlineError(null);
                        setProductBlockMode('SELECTING');
                      }}
                      disabled={isAttachingInline}
                    >
                      Выбрать изделие
                    </button>
                    <button
                      type="button"
                      className={
                        'admin-btn ' +
                        (productBlockMode === 'CREATING' ||
                        (productBlockMode === 'CREATED' &&
                          (savedInlineProduct || savedConstructorTask))
                          ? 'admin-btn--primary'
                          : 'admin-btn--ghost')
                      }
                      onClick={() => {
                        setInlineError(null);
                        setInlineInitialTab('calculate');
                        setProductBlockMode('CREATING');
                      }}
                      disabled={isAttachingInline}
                    >
                      Создать изделие
                    </button>
                  </div>
                )}
              </header>

              {/* EMPTY: подсказка + опционально цвет (чтобы у менеджера
                  была возможность поменять только цвет, не трогая
                  лекало). Под флагом «Расцветки» цвет задаётся в
                  карточках расцветок — одиночное поле скрываем. */}
              {productBlockMode === 'EMPTY' && (
                <>
                  <p className="admin-muted" style={{ margin: 0 }}>
                    К заказу не привязано лекало. Нажмите «Выбрать
                    изделие», чтобы взять существующее, или «Создать
                    изделие», чтобы завести inline.
                  </p>
                  {!colorwaysEnabled && (
                    <div
                      className="admin-form-grid"
                      style={{ marginTop: '0.5rem' }}
                    >
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
                  )}
                </>
              )}

              {/* SELECTING: тот же select лекала, что и был, +
                  поле «Цвет». Submit формы отправит выбранный
                  patternItemId штатным путём. */}
              {productBlockMode === 'SELECTING' && (
                <div className="admin-form-grid">
                  <div className="admin-field">
                    <label htmlFor="patternItemId">
                      Номенклатура / лекало
                    </label>
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

                  {!colorwaysEnabled && (
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
                  )}
                </div>
              )}

              {/* CREATING: модалка inline-создания изделия (calc или
                  constructor вкладки). После успешного save server
                  action подвяжет лекало к заказу, мы вернёмся в
                  CREATED-режим. patternItemId продолжаем держать
                  hidden, чтобы submit заказа не сбросил FK. */}
              {productBlockMode === 'CREATING' && (
                <>
                  <input
                    type="hidden"
                    name="patternItemId"
                    value={patternItemId}
                  />
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <strong>Создать изделие</strong>
                    {isAttachingInline && (
                      <span
                        className="admin-muted"
                        style={{ fontSize: '0.85rem' }}
                      >
                        Применяем к заказу…
                      </span>
                    )}
                  </div>
                  <CreateProductInline
                    initialCategories={patternCategories}
                    initialTechCards={techCards}
                    initialPatterns={patterns}
                    sizes={sizes}
                    initialValue={savedInlineProduct}
                    initialTab={inlineInitialTab}
                    onCancel={() => {
                      setInlineError(null);
                      // Возвращаемся в осмысленное состояние: если
                      // лекало уже привязано к заказу — CREATED,
                      // иначе EMPTY.
                      setProductBlockMode(
                        order.patternItemId || patternItemId
                          ? 'CREATED'
                          : 'EMPTY',
                      );
                    }}
                    onSave={handleInlineSave}
                  />
                  {inlineError && (
                    <span
                      className="error-box__msg"
                      role="alert"
                      style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}
                    >
                      {inlineError}
                    </span>
                  )}
                </>
              )}

              {/* CREATED: лекало привязано. Показываем подходящую
                  карточку и держим patternItemId в hidden input,
                  чтобы submit заказа не сбросил FK. Поле «Цвет»
                  выносим в отдельный grid под карточкой. */}
              {productBlockMode === 'CREATED' && (
                <>
                  <input
                    type="hidden"
                    name="patternItemId"
                    value={patternItemId}
                  />
                  {savedInlineProduct ? (
                    <SavedInlineProductCard
                      payload={savedInlineProduct}
                      onEdit={() => {
                        setInlineInitialTab('calculate');
                        setProductBlockMode('CREATING');
                      }}
                      onSendToConstructor={() => {
                        setInlineInitialTab('constructor');
                        setProductBlockMode('CREATING');
                      }}
                      onDelete={() => {
                        setSavedInlineProduct(null);
                        setSavedConstructorTask(null);
                        setPatternItemId('');
                        setProductBlockMode('EMPTY');
                      }}
                    />
                  ) : savedConstructorTask ? (
                    <SavedConstructorTaskCard
                      task={savedConstructorTask}
                      onDelete={() => {
                        setSavedConstructorTask(null);
                        setSavedInlineProduct(null);
                        setPatternItemId('');
                        setProductBlockMode('EMPTY');
                      }}
                    />
                  ) : (
                    <AttachedPatternSummaryCard
                      patternItemId={patternItemId}
                      patternName={
                        patterns.find((p) => p.id === patternItemId)?.name ??
                        order.patternName ??
                        order.patternNameSnapshot ??
                        null
                      }
                      patternArticle={
                        patterns.find((p) => p.id === patternItemId)
                          ?.article ?? null
                      }
                      canSendToConstructor={
                        !order.constructorTask && !savedConstructorTask
                      }
                      constructorSizes={orderConstructorSizes}
                      isDraft={isDraft}
                      onChangeExisting={() => {
                        setSavedInlineProduct(null);
                        setSavedConstructorTask(null);
                        setProductBlockMode('SELECTING');
                      }}
                      onCreateNew={() => {
                        setInlineInitialTab('calculate');
                        setProductBlockMode('CREATING');
                      }}
                      onDetach={() => {
                        setSavedInlineProduct(null);
                        setSavedConstructorTask(null);
                        setPatternItemId('');
                        setProductBlockMode('EMPTY');
                      }}
                    />
                  )}
                  {!colorwaysEnabled && (
                    <div
                      className="admin-form-grid"
                      style={{ marginTop: '0.75rem' }}
                    >
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
                  )}
                </>
              )}

              {/* Hint про DRAFT-ограничение — показываем всегда, если
                  заказ уже не в DRAFT, чтобы менеджер видел, почему
                  кнопки в шапке отсутствуют. */}
              {!isDraft && (
                <span
                  className="admin-field__hint admin-muted"
                  style={{ marginTop: '0.5rem', display: 'block' }}
                >
                  Менять лекало можно только в DRAFT — у запущенного
                  заказа уже зафиксирован snapshot полей лекала.
                </span>
              )}
            </AdminCard>

            {/* «Заявки в КБ» — отдельная секция-карточка после блока
                «Изделие». Источник — `order.constructorTask` (живёт в
                server-data: после refresh показывает текущий статус
                заявки), либо `savedConstructorTask` из in-session
                state — карточку видно сразу, не дожидаясь refresh. */}
            {(order.constructorTask || savedConstructorTask) && (
              <OrderConstructorTaskCard
                title="Заявки в КБ"
                task={
                  order.constructorTask ??
                  (savedConstructorTask
                    ? {
                        id: savedConstructorTask.taskId,
                        patternItemId: savedConstructorTask.patternItemId,
                        patternName: savedConstructorTask.patternName,
                        patternArticle: savedConstructorTask.patternArticle,
                        status: 'NEW' as const,
                        comment: '',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        submittedAt: new Date().toISOString(),
                        acceptedAt: null,
                        createdByName: null,
                        assignedToName: null,
                        filesCount: savedConstructorTask.filesCount,
                        sizeRowsCount: savedConstructorTask.sizeRowsCount,
                      }
                    : null)
                }
              />
            )}

            <AdminCard className="admin-order-card admin-order-card--production">
              <header className="admin-order-card__header">
                <span className="admin-order-card__icon admin-order-card__icon--blue">
                  <Workflow size={18} strokeWidth={1.7} aria-hidden />
                </span>
                <h2 className="admin-order-card__title">Производство</h2>
              </header>

              <div className="admin-form-grid">
                {/* Фича «Расцветки»: техкарта выбирается на КАЖДЫЙ цвет в
                    карточках расцветок, поэтому общий выбор техкарты
                    прячем, чтобы не дублировать. Без расцветок — обычный
                    выбор техкарты. */}
                {!colorwaysEnabled && (
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
                )}

                <div className="admin-field">
                  <label htmlFor="routeTemplateId">Маршрут</label>
                  <select
                    id="routeTemplateId"
                    name="routeTemplateId"
                    value={routeTemplateId}
                    onChange={(e) => setRouteTemplateId(e.target.value)}
                    disabled={!planEditable}
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
            ) : colorwaysEnabled ? (
              // Фича «Расцветки»: цвет × размер × техкарта вместо плоской
              // матрицы. Из карточек считаем агрегат (`sizesTotal`) и
              // `variantsJson` — backend полностью заменит расцветки и
              // пересоберёт `OrderItem` через `resyncColorwayDerived`.
              //
              // На CALCULATION_DONE редактор read-only (`<fieldset disabled>`
              // гасит все контролы нативно) и `variantsJson` не сабмитится —
              // правка расцветок/спецификации только через «Вернуть на
              // пересчёт». В DRAFT/CALCULATION — как раньше.
              colorwaysEditable ? (
                <OrderColorwaysFieldset
                  availableSizes={availableSizes}
                  allSizes={sortedSizes}
                  techCards={techCards}
                  value={colorways}
                  onChange={setColorways}
                  initialExtraSizeIds={initialExtraSizeIds}
                />
              ) : (
                <>
                  <p className="admin-muted" style={{ margin: '0 0 10px' }}>
                    Расцветки и спецификация заморожены после расчёта. Чтобы
                    их изменить — «Вернуть на пересчёт» в карточке заказа.
                  </p>
                  <fieldset
                    disabled
                    style={{ border: 0, padding: 0, margin: 0, minInlineSize: 0 }}
                  >
                    <OrderColorwaysFieldset
                      availableSizes={availableSizes}
                      allSizes={sortedSizes}
                      techCards={techCards}
                      value={colorways}
                      onChange={setColorways}
                      initialExtraSizeIds={initialExtraSizeIds}
                    />
                  </fieldset>
                </>
              )
            ) : (
              <>
                {/* Размерная матрица (без расцветок) — состав правится
                    только в DRAFT. `<fieldset disabled>` вне DRAFT гасит
                    инпуты нативно, чтобы `qty[]` не сабмитились и не
                    ловили `ORDER_LOCKED` (readOnly-инпуты, в отличие от
                    disabled, всё равно уходят в FormData). */}
                <fieldset
                  disabled={!isDraft}
                  style={{ border: 0, padding: 0, margin: 0, minInlineSize: 0 }}
                >
                  <AdminSizeGrid
                    sizes={sizeGridSizes}
                    values={initialQty}
                    onTotalChange={setSizesTotal}
                    readOnly={!isDraft}
                  />
                </fieldset>
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

/**
 * Карточка-резюме для уже привязанного лекала (CREATED-режим, но
 * лекало пришло из БД — не из текущей inline-сессии). В отличие от
 * `SavedInlineProductCard` мы тут не имеем calc-payload-а (категория,
 * размеры с qty и площади м²) — только id лекала, его имя и артикул.
 *
 * Поэтому кнопки тут проще: «Заменить» (→ SELECTING — выбрать другое),
 * «Создать новое» (→ CREATING — inline создание) и «Отвязать»
 * (→ EMPTY). «Редактировать»-режима нет: чтобы поправить площади
 * существующего лекала, менеджер идёт на `/admin/patterns/<id>`.
 */
function AttachedPatternSummaryCard({
  patternItemId,
  patternName,
  patternArticle,
  isDraft,
  onChangeExisting,
  onCreateNew,
  onDetach,
  canSendToConstructor,
  constructorSizes,
}: {
  patternItemId: string;
  patternName: string | null;
  patternArticle: string | null;
  isDraft: boolean;
  onChangeExisting: () => void;
  onCreateNew: () => void;
  onDetach: () => void;
  /**
   * Показывать ли кнопку «Отправить конструктору». `false`, если у
   * лекала уже есть заявка КБ (1:1) — карточку заявки рендерит
   * отдельная секция ниже.
   */
  canSendToConstructor: boolean;
  /** Размеры заказа для таблицы погонных метров в модалке КБ. */
  constructorSizes: SendPatternToConstructorSize[];
}) {
  return (
    <div
      style={{
        border: '1px solid #cbd5e1',
        borderRadius: 8,
        padding: '12px 14px',
        background: '#f8fafc',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
      data-testid="attached-pattern-summary-card"
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <strong style={{ fontSize: '0.95rem', color: '#0f172a' }}>
          Привязано лекало
        </strong>
        {isDraft && (
          <div style={{ display: 'flex', gap: 6 }}>
            {canSendToConstructor && (
              <SendPatternToConstructorButton
                patternItemId={patternItemId}
                patternName={patternName ?? 'Лекало'}
                sizes={constructorSizes}
                buttonClassName="admin-btn admin-btn--primary"
              />
            )}
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={onChangeExisting}
            >
              Заменить
            </button>
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={onCreateNew}
            >
              Создать новое
            </button>
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={onDetach}
              style={{ color: '#b91c1c' }}
            >
              Отвязать
            </button>
          </div>
        )}
      </div>
      {isDraft && canSendToConstructor && (
        <p style={{ margin: 0, fontSize: '0.8rem', color: '#64748b' }}>
          Файл лекала ещё не приложен. Можно отправить лекало
          конструктору на разработку — заявка появится в разделе «Заявки
          конструктору» и в карточке заказа.
        </p>
      )}
      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '4px 12px',
          fontSize: '0.88rem',
        }}
      >
        <dt style={{ color: '#475569' }}>Название</dt>
        <dd style={{ margin: 0 }}>
          {patternName ?? (
            <span style={{ color: '#94a3b8' }}>не задано</span>
          )}
        </dd>
        <dt style={{ color: '#475569' }}>Артикул</dt>
        <dd style={{ margin: 0 }}>
          {patternArticle ? (
            <Link
              href={`/admin/patterns/${patternItemId}`}
              style={{ color: 'var(--admin-primary, #2563eb)' }}
            >
              {patternArticle}
            </Link>
          ) : (
            <Link
              href={`/admin/patterns/${patternItemId}`}
              style={{ color: 'var(--admin-primary, #2563eb)' }}
            >
              Открыть карточку лекала
            </Link>
          )}
        </dd>
      </dl>
    </div>
  );
}
