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
 * Никаких autosave / drafts на load. Заказ-черновик (`status=DRAFT`)
 * создаётся по явному действию пользователя двумя путями:
 *   - «Создать заказ» (hero submit) — собирает весь `<form>` в FormData
 *     и шлёт `createOrderAction`; Hero и Product tab лежат внутри ОДНОГО
 *     `<form>`, поэтому FormData собирается атомарно;
 *   - «Сохранить изделие» (вкладка «Сделать расчёт») — создаёт DRAFT-Order
 *     сразу через `createOrderForCalculationAction` и редиректит на
 *     `/admin/orders/[id]/edit`, чтобы изделие не терялось при перезагрузке
 *     (см. проп `onSaveCalculateAsync` у `CreateProductInline`).
 */

import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ImageIcon,
  Plus,
  Save,
  Shirt,
  Stamp,
  Workflow,
} from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { PatternCategoryListItemDto } from '@sewing/shared/pattern-categories';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';
import type {
  OrderMaterialsAndHardwareCostPolicy,
  SizeDto,
} from '@sewing/shared/orders';
import {
  ORDER_MATERIALS_AND_HARDWARE_COST_POLICIES,
  ORDER_MATERIALS_AND_HARDWARE_COST_POLICY_LABELS,
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
  PatternHeroPreview,
  type AdminRouteStep,
} from '@/components/admin';
import { OrderApplicationsEditor } from '@/components/orders/order-applications-editor';
import { OrderConstructorTaskCard } from '@/components/orders/order-constructor-task-card';
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
  createOrderForCalculationAction,
  type FormActionState,
} from '@/app/orders/actions';
import { SizePlanSelector } from './size-plan-selector';
import {
  CreateProductInline,
  type SavedConstructorDraftPayload,
  type SavedInlineProductPayload,
} from './create-product-inline';

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
   * Inline-создание изделия из формы заказа: активные группы
   * номенклатуры для модалки «+ Создать изделие». См.
   * `apps/web/app/admin/orders/new/create-product-modal.tsx`.
   */
  patternCategories: PatternCategoryListItemDto[];
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
  patternCategories,
  companyDivisions,
  warehouses,
  today,
}: Props) {
  // Состояния блока «Изделие»:
  //   - EMPTY      — стартовое, тело пустое, в шапке две кнопки;
  //   - SELECTING  — после клика «Выбрать изделие»: показываем поля
  //                  Номенклатура (select PatternItem) + Цвет (текущий
  //                  default-режим);
  //   - CREATING   — после клика «Создать изделие»: показываем inline-
  //                  форму расчёта (см. `create-product-inline.tsx`).
  //                  Кнопка «Сохранить изделие» внутри формы выполняет
  //                  ЛОКАЛЬНОЕ сохранение (без API) в `savedInlineProduct`;
  //   - CREATED    — после «Сохранить изделие»: показываем карточку-
  //                  резюме «Изделие №1» с кнопками «Редактировать» /
  //                  «Удалить». Две кнопки в шапке остаются.
  //
  // Сабмит всей формы (херо «Создать заказ») идёт через обычный
  // `createOrderAction` — если есть `savedInlineProduct`, его JSON
  // лежит в hidden input `newProductCalculationJson` и `actions.ts`
  // разворачивает его в `productMode = CREATE_FOR_CALCULATION`.
  // `useRouter` нужен для редиректа на `[id]/edit` после успешного
  // «Отправить конструктору»: backend в той же транзакции создаёт
  // DRAFT-Order и возвращает orderId — менеджер сразу попадает в
  // карточку заказа, где доводит остальные поля.
  const router = useRouter();
  type ProductBlockMode = 'EMPTY' | 'SELECTING' | 'CREATING' | 'CREATED';
  const [productBlockMode, setProductBlockMode] =
    useState<ProductBlockMode>('EMPTY');
  const [savedInlineProduct, setSavedInlineProduct] =
    useState<SavedInlineProductPayload | null>(null);
  // Этап «Отправить изделие конструктору»: результат уже созданной
  // задачи (DRAFT PatternItem + ConstructorTask в БД). При сабмите
  // заказа `patternItemId` пишется в hidden input, чтобы заказ
  // привязался к DRAFT-pattern; `productCreationMode` отдельным
  // hidden-ом помечает заказ как `SEND_TO_CONSTRUCTOR`.
  const [savedConstructorTask, setSavedConstructorTask] =
    useState<SavedConstructorDraftPayload | null>(null);
  // На какой вкладке открыть модалку «Изделие» при следующем монтировании.
  // По умолчанию — `calculate`. Меняется в `'constructor'`, когда
  // пользователь жмёт «Отправить конструктору» в карточке сохранённого
  // изделия (см. `SavedInlineProductCard`).
  const [inlineInitialTab, setInlineInitialTab] = useState<
    'calculate' | 'constructor'
  >('calculate');
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
  // Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
  // `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`).
  // Default — `INCLUDE` (учитывать в себестоимости как раньше).
  const [materialsAndHardwareCostPolicy, setMaterialsAndHardwareCostPolicy] =
    useState<OrderMaterialsAndHardwareCostPolicy>('INCLUDE');
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
                materialsAndHardwareCostPolicy={
                  materialsAndHardwareCostPolicy
                }
                onMaterialsAndHardwareCostPolicyChange={
                  setMaterialsAndHardwareCostPolicy
                }
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
                {/* Херо-кнопка «Создать заказ» всегда видна. Она
                    отправляет общий `<form action={createOrderAction}>`;
                    если в `savedInlineProduct` есть сохранённое
                    inline-изделие, его JSON лежит в hidden input
                    `newProductCalculationJson` и обрабатывается
                    server action-ом. В режиме CREATING без локального
                    «Сохранить изделие» сабмит может уйти без
                    inline-изделия — backend в этом случае отдаст 400
                    `ORDER_PRODUCT_OR_PATTERN_REQUIRED`. */}
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
            productBlockMode={productBlockMode}
            onSelectExisting={() => setProductBlockMode('SELECTING')}
            onStartCreating={() => setProductBlockMode('CREATING')}
            savedInlineProduct={savedInlineProduct}
            savedConstructorTask={savedConstructorTask}
            onEditSavedProduct={() => {
              setInlineInitialTab('calculate');
              setProductBlockMode('CREATING');
            }}
            onSendSavedProductToConstructor={() => {
              setInlineInitialTab('constructor');
              setProductBlockMode('CREATING');
            }}
            onDeleteSavedProduct={() => {
              setSavedInlineProduct(null);
              setSavedConstructorTask(null);
              // Также сбрасываем patternItemId, который мы выставили
              // при сохранении задачи конструктору, чтобы submit не
              // отправил его без CREATED-режима.
              setPatternItemId('');
              setProductBlockMode('EMPTY');
              setInlineInitialTab('calculate');
            }}
            inlineRender={
              productBlockMode === 'CREATING' ? (
                <CreateProductInline
                  initialCategories={patternCategories}
                  initialTechCards={techCards}
                  initialPatterns={patterns}
                  sizes={sortedSizes}
                  initialValue={savedInlineProduct}
                  initialTab={inlineInitialTab}
                  // Просим backend создать DRAFT-Order в той же
                  // транзакции, чтобы избежать orphan-task без
                  // привязки к заказу.
                  createDraftOrderOnConstructor
                  // Этап «Сохранить изделие = создать DRAFT-заказ»:
                  // вместо локального state создаём реальный заказ
                  // (productMode = CREATE_FOR_CALCULATION) с уже
                  // заполненными полями шапки и уводим на edit-страницу,
                  // где менеджер дозаполнит остальное. Заказ сразу в БД
                  // — переживает перезагрузку и виден в `/admin/orders`
                  // как «Черновик».
                  onSaveCalculateAsync={async (payload) => {
                    const dto = {
                      orderDate: today,
                      productMode: 'CREATE_FOR_CALCULATION' as const,
                      newProductCalculation: {
                        categoryId: payload.categoryId,
                        techCardId: payload.techCardId,
                        patternDevelopmentCostRub:
                          payload.patternDevelopmentCostRub,
                        patternDevelopmentCostInCostPrice:
                          payload.patternDevelopmentCostInCostPrice,
                        sizes: payload.sizes.map((s) => ({
                          sizeId: s.sizeId,
                          qtyPlan: s.qtyPlan,
                          areas: s.areas.map((a) => ({
                            roleKey: a.roleKey,
                            areaM2: a.areaM2,
                          })),
                        })),
                      },
                      // Поля шапки на момент сохранения изделия —
                      // что заполнено, то и сохраняем; пустые опускаем
                      // (DRAFT допускает отсутствие).
                      clientId: clientId || undefined,
                      companyDivisionId: companyDivisionId || undefined,
                      finishedGoodsWarehouseId:
                        finishedGoodsWarehouseId || undefined,
                      materialsAndHardwareCostPolicy,
                      dueDate: dueDate || undefined,
                      customerUnitPrice:
                        customerUnitPrice.trim() === ''
                          ? undefined
                          : customerUnitPrice.trim(),
                      customerCurrency,
                      comment:
                        comment.trim() === '' ? undefined : comment.trim(),
                    };
                    const res = await createOrderForCalculationAction(dto);
                    if (res.ok && res.orderId) {
                      router.push(`/admin/orders/${res.orderId}/edit`);
                      return { ok: true };
                    }
                    return {
                      ok: false,
                      error:
                        res.error ?? 'Не удалось создать черновик заказа',
                    };
                  }}
                  onCancel={() => {
                    // «Отмена» внутри inline-формы возвращает в EMPTY,
                    // если ничего не было сохранено, и в CREATED, если
                    // редактировали уже существующее изделие.
                    setProductBlockMode(
                      savedInlineProduct ? 'CREATED' : 'EMPTY',
                    );
                  }}
                  onSave={(result) => {
                    if (result.kind === 'calculate') {
                      // На `/admin/orders/new` ветка `calculate` не
                      // вызывается: `onSaveCalculateAsync` (передан выше)
                      // перехватывает «Сохранить изделие», создаёт
                      // DRAFT-Order и уводит на edit. Оставлено как
                      // безопасный fallback на случай отсутствия пропа.
                      setSavedInlineProduct(result.payload);
                      setSavedConstructorTask(null);
                      setProductBlockMode('CREATED');
                    } else {
                      // SEND_TO_CONSTRUCTOR: backend в той же транзакции
                      // создал DRAFT-PatternItem + ConstructorTask + Order
                      // и вернул `orderId`. Редирект на edit-страницу,
                      // где менеджер дозаполнит остальные поля заказа
                      // в контексте уже привязанной заявки КБ.
                      if (result.result.orderId) {
                        router.push(
                          `/admin/orders/${result.result.orderId}/edit`,
                        );
                        return;
                      }
                      // Fallback на старый flow (orderId не пришёл —
                      // backend старой версии или флаг не отработал):
                      // оставляем поведение «привязали pattern,
                      // отправим заказ при «Создать заказ»».
                      setSavedConstructorTask(result.result);
                      setSavedInlineProduct(null);
                      setPatternItemId(result.result.patternItemId);
                      setProductBlockMode('CREATED');
                    }
                  }}
                />
              ) : null
            }
          />
        </div>

        {/* Hidden input — `createOrderAction` парсит JSON и собирает
            DTO с `productMode = CREATE_FOR_CALCULATION`. Если nothing
            saved → пустая строка, поле игнорируется backend-ом. */}
        <input
          type="hidden"
          name="newProductCalculationJson"
          value={
            savedInlineProduct ? JSON.stringify(savedInlineProduct) : ''
          }
        />

        {/* Этап «Отправить изделие конструктору»: hidden input
            `productCreationMode` сигналит backend-у, что заказ нужно
            создать со `productCreationMode = 'SEND_TO_CONSTRUCTOR'`.
            patternItemId уже прокинут как поле `name="patternItemId"`
            внутри `ProductCreateTab` (мы выставили его в state выше
            при сохранении задачи). */}
        {savedConstructorTask && (
          <>
            <input
              type="hidden"
              name="productCreationMode"
              value="SEND_TO_CONSTRUCTOR"
            />
            {/* В CREATED-режиме SELECTING-блок с `<select name="patternItemId">`
                не рендерится — но action ожидает поле `patternItemId`,
                чтобы привязать заказ к DRAFT-pattern. Прокидываем
                hidden-ом из state. */}
            <input
              type="hidden"
              name="patternItemId"
              value={savedConstructorTask.patternItemId}
            />
            {/* «Заявки в КБ» — карточка-summary только что созданной заявки.
                Show-on-success — пока пользователь не покинул страницу
                создания. После сабмита заказа карточка появится в hero
                страницы заказа уже из server-data (`order.constructorTask`). */}
            <OrderConstructorTaskCard
              title="Заявки в КБ"
              task={{
                id: savedConstructorTask.taskId,
                patternItemId: savedConstructorTask.patternItemId,
                patternName: savedConstructorTask.patternName,
                patternArticle: savedConstructorTask.patternArticle,
                status: 'NEW',
                comment: '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                submittedAt: new Date().toISOString(),
                acceptedAt: null,
                createdByName: null,
                assignedToName: null,
                filesCount: savedConstructorTask.filesCount,
                sizeRowsCount: savedConstructorTask.sizeRowsCount,
              }}
            />
          </>
        )}

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
  materialsAndHardwareCostPolicy,
  onMaterialsAndHardwareCostPolicyChange,
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
  /** Упрощённый MVP давальческого сырья / фурнитуры клиента. */
  materialsAndHardwareCostPolicy: OrderMaterialsAndHardwareCostPolicy;
  onMaterialsAndHardwareCostPolicyChange: (
    v: OrderMaterialsAndHardwareCostPolicy,
  ) => void;
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
        <label htmlFor="materialsAndHardwareCostPolicy">
          Учет материалов и фурнитуры в себестоимости
        </label>
        <select
          id="materialsAndHardwareCostPolicy"
          name="materialsAndHardwareCostPolicy"
          value={materialsAndHardwareCostPolicy}
          onChange={(e) =>
            onMaterialsAndHardwareCostPolicyChange(
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
          Если материалы или фурнитуру предоставляет клиент, выберите
          «Не учитывать». Потребность по количеству всё равно будет
          рассчитана и показана, но стоимость материалов и фурнитуры
          не войдёт в себестоимость заказа.
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
  productBlockMode,
  onSelectExisting,
  onStartCreating,
  savedInlineProduct,
  savedConstructorTask,
  onEditSavedProduct,
  onSendSavedProductToConstructor,
  onDeleteSavedProduct,
  inlineRender,
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
  productBlockMode: 'EMPTY' | 'SELECTING' | 'CREATING' | 'CREATED';
  onSelectExisting: () => void;
  onStartCreating: () => void;
  savedInlineProduct: SavedInlineProductPayload | null;
  /**
   * Этап «Отправить изделие конструктору»: результат уже созданной
   * задачи (DRAFT-PatternItem + ConstructorTask). В CREATED-режиме
   * рендерим отдельную summary-карточку «Заявка конструктору».
   */
  savedConstructorTask: SavedConstructorDraftPayload | null;
  onEditSavedProduct: () => void;
  /** Открыть модалку «Изделие» на вкладке `constructor`. */
  onSendSavedProductToConstructor: () => void;
  onDeleteSavedProduct: () => void;
  /** Render inline-формы (CREATING-режим). */
  inlineRender: React.ReactNode;
}) {
  const isCreating = productBlockMode === 'CREATING';
  const isSelecting = productBlockMode === 'SELECTING';
  const isCreated = productBlockMode === 'CREATED';
  return (
    <>
      <div className="admin-order-form__grid admin-order-form__top">
        <AdminCard
          className={
            'admin-order-card admin-order-card--product' +
            (isCreating || isCreated ? ' admin-order-card--full-row' : '')
          }
        >
          <header className="admin-order-card__header admin-order-card__header--with-meta">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="admin-order-card__icon admin-order-card__icon--pink">
                <Shirt size={18} strokeWidth={1.7} aria-hidden />
              </span>
              <h2 className="admin-order-card__title">Изделие</h2>
            </div>
            {/* Две кнопки в шапке блока — видны во всех состояниях.
                Клики переключают режим тела блока. */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className={
                  'admin-btn ' +
                  (isSelecting ? 'admin-btn--primary' : 'admin-btn--ghost')
                }
                onClick={onSelectExisting}
              >
                Выбрать изделие
              </button>
              <button
                type="button"
                className={
                  'admin-btn ' +
                  (isCreating || isCreated
                    ? 'admin-btn--primary'
                    : 'admin-btn--ghost')
                }
                onClick={onStartCreating}
              >
                Создать изделие
              </button>
            </div>
          </header>

          {isCreating && <>{inlineRender}</>}

          {isCreated && savedInlineProduct && (
            <SavedInlineProductCard
              payload={savedInlineProduct}
              onEdit={onEditSavedProduct}
              onSendToConstructor={onSendSavedProductToConstructor}
              onDelete={onDeleteSavedProduct}
            />
          )}

          {isCreated && savedConstructorTask && (
            <SavedConstructorTaskCard
              task={savedConstructorTask}
              onDelete={onDeleteSavedProduct}
            />
          )}

          {isSelecting && (
            <div
              className="admin-form-grid"
              style={{
                // Номенклатура шире (длинный label + длинные option-ы),
                // Цвет компактнее. `alignItems: start` — чтобы поля
                // не растягивались по высоте и подсказка под селектом
                // не сдвигала input «Цвет».
                gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
                alignItems: 'start',
              }}
            >
              <div className="admin-field">
                <label htmlFor="patternItemId">Номенклатура / лекало</label>
                <select
                  id="patternItemId"
                  name="patternItemId"
                  value={patternItemId}
                  onChange={(e) => onPatternItemIdChange(e.target.value)}
                  aria-describedby="patternItemId-hint"
                >
                  <option value="">— выберите номенклатуру —</option>
                  {patterns.map((pt) => (
                    <option key={pt.id} value={pt.id}>
                      {pt.name} · {pt.article}
                    </option>
                  ))}
                </select>
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

              {/* Подсказки и ошибки выносим под обе колонки, чтобы они
                  не влияли на выравнивание input-а «Цвет» в верхней
                  строке (`grid-column: 1 / -1`). */}
              <div
                className="admin-field"
                style={{ gridColumn: '1 / -1', gap: 'var(--admin-space-xs)' }}
              >
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
            </div>
          )}

          {productBlockMode === 'EMPTY' && (
            <p
              className="admin-muted"
              style={{ marginTop: 8, fontSize: '0.88rem' }}
            >
              Выберите изделие из существующих или создайте новое — на
              блок «Изделие» наложится соответствующая форма.
            </p>
          )}
        </AdminCard>

        {/* Превью видно всегда. В CREATING/CREATED блок «Изделие»
            берёт всю ширину (`--full-row`); чтобы превью не висело
            в половинной колонке под широким блоком, тоже растягиваем
            его на всю строку. В EMPTY/SELECTING остаётся правой
            колонкой 2-колоночной сетки. */}
        <AdminCard
          className={
            'admin-order-card admin-order-card--hero' +
            (isCreating || isCreated ? ' admin-order-card--full-row' : '')
          }
        >
          <header className="admin-order-card__header">
            <span className="admin-order-card__icon admin-order-card__icon--violet">
              <ImageIcon size={18} strokeWidth={1.7} aria-hidden />
            </span>
            <h2 className="admin-order-card__title">Превью изделия</h2>
          </header>
          <PatternHeroPreview pattern={selectedPattern} />
        </AdminCard>
      </div>

      {/* Нижние карточки (Производство, Нанесение, План по размерам)
          актуальны только в режиме «Выбрать изделие» — там менеджер
          вручную выбирает техкарту/маршрут/размеры. В режимах CREATING
          / CREATED / EMPTY скрываем — данные либо заполняются внутри
          inline-формы, либо ещё не нужны. */}
      {isSelecting && (<>
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
      </>)}
    </>
  );
}

/**
 * Карточка-резюме сохранённого inline-изделия (`Изделие №1`). Видна в
 * блоке «Изделие» в состоянии `CREATED`. Backend в БД ещё ничего не
 * писал — это локальный snapshot из state-а формы. После клика херо-
 * кнопки «Создать заказ» данные летят в `createOrderAction` через
 * hidden input `newProductCalculationJson` и оформляются как
 * `productMode = CREATE_FOR_CALCULATION`.
 */
export function SavedInlineProductCard({
  payload,
  onEdit,
  onSendToConstructor,
  onDelete,
}: {
  payload: SavedInlineProductPayload;
  onEdit: () => void;
  /**
   * Этап «Отправить изделие конструктору»: открывает модалку
   * сразу на вкладке `constructor`, передавая текущий `payload`
   * как `initialValue`. Backend в server action-е использует его
   * как calc-payload для создания DRAFT-PatternItem.
   */
  onSendToConstructor: () => void;
  onDelete: () => void;
}) {
  const totalQty = payload.sizes.reduce((s, r) => s + (r.qtyPlan ?? 0), 0);
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
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <strong style={{ fontSize: '0.95rem', color: '#0f172a' }}>
          Изделие №1
        </strong>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={onEdit}
          >
            Редактировать
          </button>
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            onClick={onSendToConstructor}
            title="Открыть форму отправки лекала на разработку конструктору"
          >
            Отправить конструктору
          </button>
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={onDelete}
            style={{ color: '#b91c1c' }}
          >
            Удалить
          </button>
        </div>
      </div>
      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '4px 12px',
          fontSize: '0.88rem',
        }}
      >
        <dt style={{ color: '#475569' }}>Группа номенклатуры</dt>
        <dd style={{ margin: 0 }}>
          {payload.categoryName ?? <span style={{ color: '#94a3b8' }}>не указана</span>}
        </dd>
        <dt style={{ color: '#475569' }}>Техкарта</dt>
        <dd style={{ margin: 0 }}>
          {payload.techCardName ?? <span style={{ color: '#94a3b8' }}>не выбрана</span>}
        </dd>
        <dt style={{ color: '#475569' }}>Размеры / тираж</dt>
        <dd style={{ margin: 0 }}>
          {payload.sizes.length === 0 ? (
            <span style={{ color: '#94a3b8' }}>не заданы</span>
          ) : (
            <>
              {payload.sizes
                .map((s) => `${s.sizeCode}: ${s.qtyPlan}`)
                .join(', ')}{' '}
              <span style={{ color: '#475569' }}>
                (всего {totalQty.toLocaleString('ru-RU')} шт)
              </span>
            </>
          )}
        </dd>
        {payload.patternDevelopmentCostRub && (
          <>
            <dt style={{ color: '#475569' }}>Стоимость разработки лекала</dt>
            <dd style={{ margin: 0 }}>
              {payload.patternDevelopmentCostRub} ₽
              <span
                className="admin-muted"
                style={{ fontSize: '0.8rem', marginLeft: 8 }}
              >
                {payload.patternDevelopmentCostInCostPrice
                  ? '· входит в себестоимость'
                  : '· не входит в себестоимость'}
              </span>
            </dd>
          </>
        )}
      </dl>
      <p
        className="admin-muted"
        style={{ margin: 0, fontSize: '0.8rem' }}
      >
        Изделие сохранено локально. Для создания заказа нажмите
        «Создать заказ» в шапке формы — backend создаст лекало и
        привяжет его к заказу.
      </p>
    </div>
  );
}

/**
 * Карточка-резюме «Заявка конструктору» в CREATED-режиме блока
 * «Изделие». В отличие от {@link SavedInlineProductCard}, она НЕ
 * предлагает «Редактировать» — DRAFT-PatternItem уже создан в БД,
 * и редактирование не поддерживается в этой версии (см. ТЗ §«Что
 * НЕ делаем»). Только кнопка «Удалить» — она снимает hidden
 * `patternItemId` / `productCreationMode`, чтобы submit заказа
 * прошёл без привязки к черновому лекалу.
 *
 * Сама запись `ConstructorTask` остаётся в БД — менеджер увидит её
 * в `/admin/constructor-tasks` и может закрыть оттуда.
 */
export function SavedConstructorTaskCard({
  task,
  onDelete,
}: {
  task: SavedConstructorDraftPayload;
  onDelete: () => void;
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
      data-testid="saved-constructor-task-card"
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <strong style={{ fontSize: '0.95rem', color: '#0f172a' }}>
          Заявка конструктору
        </strong>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={onDelete}
            style={{ color: '#b91c1c' }}
          >
            Открепить от заказа
          </button>
        </div>
      </div>
      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '4px 12px',
          fontSize: '0.88rem',
        }}
      >
        <dt style={{ color: '#475569' }}>Изделие</dt>
        <dd style={{ margin: 0 }}>
          {task.patternName}{' '}
          <span style={{ color: '#94a3b8' }}>({task.patternArticle})</span>
        </dd>
        <dt style={{ color: '#475569' }}>Размеров</dt>
        <dd style={{ margin: 0 }}>{task.sizeRowsCount}</dd>
        <dt style={{ color: '#475569' }}>Файлов</dt>
        <dd style={{ margin: 0 }}>{task.filesCount}</dd>
        <dt style={{ color: '#475569' }}>Статус</dt>
        <dd style={{ margin: 0 }}>Новая · ждёт конструктора</dd>
      </dl>
      <p className="admin-muted" style={{ margin: 0, fontSize: '0.8rem' }}>
        Лекало создано как черновик (DRAFT). После клика «Создать заказ» в
        шапке формы заказ привяжется к этому лекалу и будет ждать
        конструктора. Управление заявкой — в разделе «Заявки конструктору».
      </p>
    </div>
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
