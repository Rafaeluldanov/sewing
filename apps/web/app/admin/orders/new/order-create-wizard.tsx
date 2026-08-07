'use client';

/**
 * `OrderCreateWizard` — мастер создания заказа на `/admin/orders/new`.
 *
 * Заменил одностраничную форму `AdminCreateOrderForm`. Причины
 * перестройки — в аудите `docs/order-page-ui-recon.md` §4.1, макет —
 * `docs/mockups/order-page-variant-c-mockup.html`:
 *
 *   - прежняя форма открывалась подразделением, складом готовой
 *     продукции и политикой учёта материалов в себестоимости — тремя
 *     редкими настройками, а главное решение «какое изделие» уходило
 *     ниже по странице;
 *   - с одного экрана вели ТРИ равноправных выхода («Создать заказ»,
 *     «Настроить материалы», «Сохранить изделие»), два из которых
 *     создавали заказ и уводили на другую страницу. Какой из них
 *     главный, из UI не следовало;
 *   - под формой дублировались пять названий разделов, уже написанных
 *     в линейке вкладок.
 *
 * Мастер решает это порядком: шаги идут в порядке решений, а не в
 * порядке полей в базе. Один шаг — один вопрос, одна главная кнопка.
 *
 * ГЛАВНОЕ ОТЛИЧИЕ: черновик создаётся ПОСРЕДИ мастера, а не по
 * финальному сабмиту. Дальше каждый шаг дописывает свой кусок в уже
 * существующий заказ. Поэтому:
 *   - уход со страницы и перезагрузка не теряют заказ, он виден в
 *     списке как «Черновик»;
 *   - финальная кнопка — «Отправить в расчёт», а не «Создать заказ»:
 *     создание уже произошло;
 *   - каждый шаг шлёт ТОЛЬКО свои поля, снимка «всей формы» нет.
 *
 * Момент создания задан контрактом backend, а не вкусом: `POST /orders`
 * требует непустой `items` (`CreateOrderSchema.superRefine` →
 * «Заказ должен содержать хотя бы одну строку по размеру»). Первый шаг,
 * где размеры известны, — «Расцветки и размеры», поэтому черновик
 * рождается на переходе 3 → 4. Шаги 1–3 держатся в локальном состоянии.
 * Исключение — ветки «Создать изделие» и «Отправить конструктору»: там
 * размеры собираются внутри модалки, и backend заводит заказ сразу,
 * поэтому черновик появляется уже на шаге 2.
 *
 * Три ветки шага «Изделие» — это прежние три пути создания, сведённые
 * в один шаг:
 *   - `EXISTING`    — выбрать лекало из номенклатуры;
 *   - `CREATE`      — создать изделие (`CreateProductInline`, вкладка
 *                     «Сделать расчёт») → backend создаёт заказ вместе
 *                     с лекалом (`productMode = CREATE_FOR_CALCULATION`);
 *   - `CONSTRUCTOR` — лекала ещё нет, заявка в КБ; backend в одной
 *                     транзакции заводит DRAFT-`PatternItem`,
 *                     `ConstructorTask` и DRAFT-заказ.
 *
 * В ветке `CONSTRUCTOR` шаги «Расцветки», «Маршрут» и «Нанесение»
 * заблокированы: без лекала у них нет ни размеров, ни техкарты. Раньше
 * эта ветка уводила на `/admin/orders/[id]/edit` — теперь остаётся в
 * мастере с честно помеченными шагами.
 *
 * Backend / DTO / Prisma не менялись: используются те же
 * `POST /orders`, `PATCH /orders/:id`, `PUT /orders/:id/applications`,
 * `POST /orders/:id/start-calculation` и те же Zod-контракты.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Lock,
  Palette,
  Shirt,
  Stamp,
  User,
  Workflow,
} from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { PatternCategoryListItemDto } from '@sewing/shared/pattern-categories';
import type { PatternListItemDto } from '@sewing/shared/patterns';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';
import type {
  CreateOrderDto,
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
import {
  AdminCard,
  AdminDateField,
  AdminRouteSteps,
  PatternHeroPreview,
} from '@/components/admin';
import { CreatableSelect } from '@/components/admin/ref-create/creatable-select';
import { OrderApplicationsEditor } from '@/components/orders/order-applications-editor';
import { createOrderForCalculationAction } from '@/app/orders/actions';
import {
  createOrderDraftAction,
  finishOrderDraftAction,
  patchOrderDraftAction,
  saveDraftApplicationsAction,
  type WizardStepResult,
} from './wizard-actions';
import {
  CreateProductInline,
  type SavedConstructorDraftPayload,
  type SavedInlineProductPayload,
} from './create-product-inline';
import {
  SavedConstructorTaskCard,
  SavedInlineProductCard,
} from './saved-product-cards';
import {
  OrderColorwaysFieldset,
  makeEmptyColorway,
  type ColorwayDraft,
} from './order-create-colorways';
import { SizePlanSelector } from './size-plan-selector';
import { TechCardCombobox } from './tech-card-combobox';
import type { RoutePreview } from './route-preview';
import {
  WIZARD_STEPS,
  type WizardStepId,
  type WizardStepState,
} from './wizard-steps';

interface Props {
  sizes: SizeDto[];
  routeTemplates: RouteTemplateSummaryDto[];
  routePreviewMap: Record<string, RoutePreview>;
  techCards: TechCardTemplateSummaryDto[];
  clients: ClientDto[];
  patterns: PatternListItemDto[];
  patternCategories: PatternCategoryListItemDto[];
  companyDivisions: CompanyDivisionDto[];
  warehouses: WarehouseSummaryDto[];
  /** Сегодня в `YYYY-MM-DD` — считается на сервере (TZ Москвы). */
  today: string;
  colorwaysEnabled: boolean;
}

/** Ветка шага «Изделие». */
type ProductBranch = 'EXISTING' | 'CREATE' | 'CONSTRUCTOR';

export function OrderCreateWizard({
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
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [step, setStep] = useState<WizardStepId>('client');
  /** id созданного черновика. `null` — шаг 2 ещё не пройден. */
  const [orderId, setOrderId] = useState<string | null>(null);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Шаги, которые менеджер сознательно пропустил (4 и 5). */
  const [skipped, setSkipped] = useState<Set<WizardStepId>>(new Set());

  // --- Шаг 1: клиент и управленческие поля -------------------------------
  const [clientId, setClientId] = useState('');
  const [companyDivisionId, setCompanyDivisionId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [customerUnitPrice, setCustomerUnitPrice] = useState('');
  const [customerCurrency, setCustomerCurrency] = useState<MoneyCurrency | ''>(
    'RUB',
  );
  const [comment, setComment] = useState('');
  const [finishedGoodsWarehouseId, setFinishedGoodsWarehouseId] = useState('');
  const [materialsAndHardwareCostPolicy, setMaterialsPolicy] =
    useState<OrderMaterialsAndHardwareCostPolicy>('INCLUDE');
  const [extrasOpen, setExtrasOpen] = useState(false);

  // --- Шаг 2: изделие ----------------------------------------------------
  const [branch, setBranch] = useState<ProductBranch>('EXISTING');
  const [patternItemId, setPatternItemId] = useState('');
  const [techCardId, setTechCardId] = useState('');
  const [savedInlineProduct, setSavedInlineProduct] =
    useState<SavedInlineProductPayload | null>(null);
  const [savedConstructorTask, setSavedConstructorTask] =
    useState<SavedConstructorDraftPayload | null>(null);
  const [inlineOpen, setInlineOpen] = useState(false);
  const [inlineTab, setInlineTab] = useState<'calculate' | 'constructor'>(
    'calculate',
  );

  // --- Шаг 3: расцветки / размеры ----------------------------------------
  const [colorways, setColorways] = useState<ColorwayDraft[]>(() => [
    makeEmptyColorway(),
  ]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  // --- Шаг 4: маршрут ----------------------------------------------------
  const [routeTemplateId, setRouteTemplateId] = useState('');

  // --- Шаг 5: нанесение --------------------------------------------------
  const applicationsFormRef = useRef<HTMLFormElement | null>(null);

  const sortedSizes = useMemo(
    () => [...sizes].sort((a, b) => a.sortOrder - b.sortOrder),
    [sizes],
  );
  const selectedPattern = useMemo(
    () => patterns.find((p) => p.id === patternItemId) ?? null,
    [patterns, patternItemId],
  );
  /** Размеры выбранного лекала — только они предлагаются в плане. */
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

  /**
   * Тираж. В режиме расцветок считается по карточкам цветов (колонки
   * могут выходить за размеры лекала — кнопка «+ размер»), иначе — по
   * плоской матрице `SizePlanSelector`.
   */
  const sizesTotal = useMemo(() => {
    if (colorwaysEnabled) {
      let sum = 0;
      for (const cw of colorways) {
        for (const [sizeId, qty] of Object.entries(cw.sizes)) {
          if (allSizeIds.has(sizeId) && qty > 0) sum += qty;
        }
      }
      return sum;
    }
    return Object.values(quantities).reduce(
      (s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0),
      0,
    );
  }, [colorwaysEnabled, colorways, quantities, allSizeIds]);

  /** Полезная нагрузка расцветок: только непустые цвета с размерами. */
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
   * Агрегат `items` — обязательное поле `POST /orders`. В режиме
   * расцветок это Σ по цветам на каждый размер, иначе — плоская
   * матрица. Backend по нему же считает `qtyPlanTotal`.
   */
  const itemsPayload = useMemo(() => {
    if (!colorwaysEnabled) {
      return Object.entries(quantities)
        .filter(([sizeId, q]) => allSizeIds.has(sizeId) && q > 0)
        .map(([sizeId, qtyPlan]) => ({ sizeId, qtyPlan }));
    }
    const agg = new Map<string, number>();
    for (const cw of variantsPayload) {
      for (const s of cw.sizes) {
        agg.set(s.sizeId, (agg.get(s.sizeId) ?? 0) + s.qtyPlan);
      }
    }
    return [...agg.entries()].map(([sizeId, qtyPlan]) => ({ sizeId, qtyPlan }));
  }, [colorwaysEnabled, quantities, variantsPayload, allSizeIds]);

  /**
   * Техкарта, которую увидит гейт `startCalculation`. При включённых
   * расцветках order-level `techCardId` пустой, и backend поднимает её
   * из первой расцветки с техкартой (`OrdersService.create`,
   * `resolvedTechCardId`). Считаем так же, чтобы предупредить о
   * `ORDER_TECH_CARD_REQUIRED` на шаге проверки, а не после клика.
   */
  const resolvedTechCardId = useMemo(
    () => techCardId || colorways.find((c) => c.techCardId)?.techCardId || '',
    [techCardId, colorways],
  );

  // Превью шаблонов, созданных «на лету» из select-а (контур
  // ref-create): серверный `routePreviewMap` их ещё не знает.
  const [extraRoutePreviews, setExtraRoutePreviews] = useState<
    Record<string, RoutePreview>
  >({});
  const selectedRoute = routeTemplateId
    ? (routePreviewMap[routeTemplateId] ??
      extraRoutePreviews[routeTemplateId] ??
      null)
    : null;
  const selectedClient = clients.find((c) => c.id === clientId) ?? null;
  const selectedDivision =
    companyDivisions.find((d) => d.id === companyDivisionId) ?? null;

  /**
   * Ветка «заявка в КБ»: лекала ещё нет, поэтому шаги, зависящие от
   * него (размеры, техкарта, маршрут, нанесение), недоступны.
   */
  const awaitingPattern = savedConstructorTask !== null;

  const stepStates = useMemo<Record<WizardStepId, WizardStepState>>(() => {
    const order = WIZARD_STEPS.map((s) => s.id);
    const currentIdx = order.indexOf(step);
    const out = {} as Record<WizardStepId, WizardStepState>;
    for (const cfg of WIZARD_STEPS) {
      const idx = order.indexOf(cfg.id);
      if (cfg.id === step) out[cfg.id] = 'current';
      else if (
        awaitingPattern &&
        (cfg.id === 'colorways' || cfg.id === 'route' || cfg.id === 'applications')
      ) {
        out[cfg.id] = 'blocked';
      } else if (skipped.has(cfg.id)) out[cfg.id] = 'skipped';
      else if (idx < currentIdx) out[cfg.id] = 'done';
      else out[cfg.id] = 'pending';
    }
    return out;
  }, [step, skipped, awaitingPattern]);

  const resetErrors = useCallback(() => {
    setError(null);
    setFieldErrors({});
  }, []);

  /** Применить результат server action; вернуть `true` при успехе. */
  const applyResult = useCallback((res: WizardStepResult): boolean => {
    if (res.ok) {
      if (res.orderId) setOrderId(res.orderId);
      setError(null);
      setFieldErrors({});
      return true;
    }
    setError(res.error ?? 'Не удалось сохранить шаг');
    setFieldErrors(res.fieldErrors ?? {});
    return false;
  }, []);

  /** Куда идти после текущего шага (с учётом заблокированных). */
  const nextStepId = useCallback(
    (from: WizardStepId): WizardStepId => {
      const order = WIZARD_STEPS.map((s) => s.id);
      let idx = order.indexOf(from) + 1;
      while (idx < order.length) {
        const candidate = order[idx];
        const blocked =
          awaitingPattern &&
          (candidate === 'colorways' ||
            candidate === 'route' ||
            candidate === 'applications');
        if (!blocked) return candidate;
        idx += 1;
      }
      return 'review';
    },
    [awaitingPattern],
  );

  /**
   * Управленческие поля шага 1 — общая часть и для создания черновика,
   * и для DTO веток «Создать изделие» / «Отправить конструктору».
   */
  const buildBasicsDto = useCallback((): Record<string, unknown> => {
    const dto: Record<string, unknown> = {
      orderDate: today,
      clientId,
      materialsAndHardwareCostPolicy,
    };
    if (companyDivisionId) dto.companyDivisionId = companyDivisionId;
    if (finishedGoodsWarehouseId)
      dto.finishedGoodsWarehouseId = finishedGoodsWarehouseId;
    if (dueDate) dto.dueDate = dueDate;
    if (customerUnitPrice.trim())
      dto.customerUnitPrice = customerUnitPrice.trim();
    if (customerCurrency) dto.customerCurrency = customerCurrency;
    if (comment.trim()) dto.comment = comment.trim();
    return dto;
  }, [
    today,
    clientId,
    materialsAndHardwareCostPolicy,
    companyDivisionId,
    finishedGoodsWarehouseId,
    dueDate,
    customerUnitPrice,
    customerCurrency,
    comment,
  ]);

  /**
   * DTO создания черновика — собирается на переходе с шага «Расцветки
   * и размеры»: раньше нельзя, `items` обязателен.
   */
  const buildDraftDto = useCallback((): CreateOrderDto => {
    const dto = buildBasicsDto();
    dto.patternItemId = patternItemId || undefined;
    dto.items = itemsPayload;
    if (techCardId) dto.techCardId = techCardId;
    if (colorwaysEnabled && variantsPayload.length > 0) {
      dto.variants = variantsPayload;
    }
    return dto as CreateOrderDto;
  }, [
    buildBasicsDto,
    patternItemId,
    itemsPayload,
    techCardId,
    colorwaysEnabled,
    variantsPayload,
  ]);

  // --- переходы ----------------------------------------------------------

  const goBack = useCallback(() => {
    resetErrors();
    const order = WIZARD_STEPS.map((s) => s.id);
    const idx = order.indexOf(step);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const candidate = order[i];
      const blocked =
        awaitingPattern &&
        (candidate === 'colorways' ||
          candidate === 'route' ||
          candidate === 'applications');
      if (!blocked) {
        setStep(candidate);
        return;
      }
    }
  }, [step, awaitingPattern, resetErrors]);

  /** Клик по пройденному шагу в степпере. */
  const jumpTo = useCallback(
    (target: WizardStepId) => {
      const state = stepStates[target];
      if (state !== 'done' && state !== 'skipped') return;
      resetErrors();
      setStep(target);
    },
    [stepStates, resetErrors],
  );

  const goNext = useCallback(() => {
    resetErrors();
    // Шаг 1 — только локальная валидация, в БД пока ничего не пишем:
    // без изделия заказ создавать нечего.
    if (step === 'client') {
      if (!clientId) {
        setError('Выберите клиента — это обязательное поле заказа.');
        setFieldErrors({ clientId: 'Выберите клиента' });
        return;
      }
      setStep('product');
      return;
    }

    // Шаг 2 — тоже без записи в БД, если менеджер выбирает готовое
    // лекало: `items` ещё нет, а без него `POST /orders` не примет
    // заказ. В ветках «Создать изделие» / «Отправить конструктору»
    // черновик к этому моменту уже создан backend-ом.
    if (step === 'product') {
      if (!orderId && !patternItemId) {
        setError('Выберите изделие или создайте новое.');
        setFieldErrors({ patternItemId: 'Выберите изделие' });
        return;
      }
      setStep(nextStepId('product'));
      return;
    }

    startTransition(async () => {
      if (step === 'colorways') {
        if (itemsPayload.length === 0) {
          setError(
            'Заполните план хотя бы по одному размеру — без него заказ создать нельзя.',
          );
          return;
        }
        // Первая запись в БД: заказа ещё нет → создаём. Если ветка
        // «Создать изделие» уже завела заказ — дописываем расцветки.
        const res = orderId
          ? await patchOrderDraftAction(
              orderId,
              colorwaysEnabled && variantsPayload.length > 0
                ? { variants: variantsPayload }
                : { items: itemsPayload },
            )
          : await createOrderDraftAction(buildDraftDto());
        if (!applyResult(res)) return;
        setStep(nextStepId('colorways'));
        return;
      }

      if (step === 'route') {
        if (!orderId) return;
        if (routeTemplateId) {
          const res = await patchOrderDraftAction(orderId, { routeTemplateId });
          if (!applyResult(res)) return;
        }
        setStep(nextStepId('route'));
        return;
      }

      if (step === 'applications') {
        if (!orderId) return;
        const form = applicationsFormRef.current;
        const raw = form
          ? String(new FormData(form).get('applicationsJson') ?? '')
          : '';
        let parsed: unknown = [];
        if (raw.trim() !== '') {
          try {
            parsed = JSON.parse(raw);
          } catch {
            setError('Не удалось прочитать параметры нанесения');
            return;
          }
        }
        const res = await saveDraftApplicationsAction(orderId, parsed);
        if (!applyResult(res)) return;
        setStep(nextStepId('applications'));
        return;
      }
    });
  }, [
    step,
    clientId,
    orderId,
    patternItemId,
    buildDraftDto,
    applyResult,
    nextStepId,
    colorwaysEnabled,
    variantsPayload,
    itemsPayload,
    routeTemplateId,
    resetErrors,
  ]);

  /** «Пропустить» — только для необязательных шагов 4 и 5. */
  const skipStep = useCallback(() => {
    resetErrors();
    setSkipped((prev) => new Set(prev).add(step));
    setStep(nextStepId(step));
  }, [step, nextStepId, resetErrors]);

  const finish = useCallback(
    (mode: 'calculation' | 'draft') => {
      if (!orderId) return;
      resetErrors();
      if (mode === 'draft') {
        router.push(`/admin/orders/${orderId}`);
        return;
      }
      startTransition(async () => {
        const res = await finishOrderDraftAction(orderId);
        if (!applyResult(res)) return;
        router.push(`/admin/orders/${orderId}`);
      });
    },
    [orderId, router, applyResult, resetErrors],
  );

  const fieldError = (key: string): string | undefined => fieldErrors[key];

  // --- рендер ------------------------------------------------------------

  const currentCfg = WIZARD_STEPS.find((s) => s.id === step)!;
  const isOptional = currentCfg.optional === true;

  return (
    <div className="order-wizard">
      {orderId && (
        <div className="order-wizard__draft" role="status">
          <span className="order-wizard__draft-text">
            <Check size={15} strokeWidth={2} aria-hidden />
            Черновик{orderNumber ? ` ${orderNumber}` : ''} сохранён — заказ уже
            виден в списке, можно уйти и вернуться
          </span>
          <Link
            href={`/admin/orders/${orderId}`}
            className="admin-btn admin-btn--ghost"
          >
            Открыть карточку
          </Link>
        </div>
      )}

      <ol className="order-wizard__steps" aria-label="Шаги создания заказа">
        {WIZARD_STEPS.map((cfg, i) => {
          const state = stepStates[cfg.id];
          const clickable = state === 'done' || state === 'skipped';
          return (
            <li key={cfg.id} className="order-wizard__step-item">
              {i > 0 && (
                <span className="order-wizard__step-sep" aria-hidden>
                  →
                </span>
              )}
              <button
                type="button"
                className={`order-wizard__step order-wizard__step--${state}`}
                onClick={() => jumpTo(cfg.id)}
                disabled={!clickable}
                aria-current={state === 'current' ? 'step' : undefined}
                data-step={cfg.id}
              >
                <span className="order-wizard__step-num" aria-hidden>
                  {state === 'done' ? (
                    <Check size={11} strokeWidth={2.5} />
                  ) : state === 'blocked' ? (
                    <Lock size={10} strokeWidth={2} />
                  ) : state === 'skipped' ? (
                    '–'
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="order-wizard__step-label">{cfg.label}</span>
                {state === 'skipped' && (
                  <span className="order-wizard__step-note">пропущено</span>
                )}
                {state === 'blocked' && (
                  <span className="order-wizard__step-note">после лекала</span>
                )}
              </button>
            </li>
          );
        })}
      </ol>

      {error && (
        <div role="alert" className="order-wizard__error">
          <AlertCircle size={18} strokeWidth={1.6} aria-hidden />
          <span>{error}</span>
        </div>
      )}

      <AdminCard className="order-wizard__panel">
        <header className="order-wizard__panel-head">
          <h2 className="order-wizard__panel-title">
            <span className="order-wizard__panel-icon" aria-hidden>
              {currentCfg.id === 'client' && <User size={18} strokeWidth={1.7} />}
              {currentCfg.id === 'product' && <Shirt size={18} strokeWidth={1.7} />}
              {currentCfg.id === 'colorways' && (
                <Palette size={18} strokeWidth={1.7} />
              )}
              {currentCfg.id === 'route' && <Workflow size={18} strokeWidth={1.7} />}
              {currentCfg.id === 'applications' && (
                <Stamp size={18} strokeWidth={1.7} />
              )}
              {currentCfg.id === 'review' && <Check size={18} strokeWidth={1.7} />}
            </span>
            {currentCfg.heading}
          </h2>
          <span className="order-wizard__panel-hint">
            {isOptional
              ? 'необязательный шаг'
              : `шаг ${WIZARD_STEPS.findIndex((s) => s.id === step) + 1} из ${WIZARD_STEPS.length}`}
          </span>
        </header>

        {/* ---------------- Шаг 1: клиент ---------------- */}
        {step === 'client' && (
          <div className="order-wizard__body">
            <div className="admin-form-grid">
              <div className="admin-field">
                <label htmlFor="wiz-client">
                  Клиент <span className="order-wizard__req">*</span>
                </label>
                <CreatableSelect
                  entity="client"
                  id="wiz-client"
                  value={clientId}
                  onValueChange={setClientId}
                  aria-invalid={fieldError('clientId') ? true : undefined}
                  existingValues={clients.map((c) => c.id)}
                >
                  <option value="">— выберите клиента —</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.isActive ? '' : ' — архивный'}
                    </option>
                  ))}
                </CreatableSelect>
                {fieldError('clientId') && (
                  <span className="order-wizard__field-error">
                    {fieldError('clientId')}
                  </span>
                )}
              </div>

              <div className="admin-field">
                <label htmlFor="wiz-division">Подразделение</label>
                <CreatableSelect
                  entity="companyDivision"
                  id="wiz-division"
                  value={companyDivisionId}
                  onValueChange={setCompanyDivisionId}
                  existingValues={companyDivisions.map((d) => d.id)}
                >
                  <option value="">— без подразделения —</option>
                  {companyDivisions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.isActive ? '' : ' — архив'}
                    </option>
                  ))}
                </CreatableSelect>
              </div>

              <div className="admin-field">
                <label htmlFor="wiz-due">Срок сдачи</label>
                <AdminDateField
                  id="wiz-due"
                  name="dueDate"
                  min={today}
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>

              <div className="admin-field">
                <label htmlFor="wiz-price">Цена за 1 шт</label>
                <div className="order-wizard__price-row">
                  <input
                    id="wiz-price"
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={customerUnitPrice}
                    onChange={(e) => setCustomerUnitPrice(e.target.value)}
                  />
                  <select
                    aria-label="Валюта"
                    value={customerCurrency}
                    onChange={(e) =>
                      setCustomerCurrency(e.target.value as MoneyCurrency | '')
                    }
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
            </div>

            <div className="admin-field">
              <label htmlFor="wiz-comment">Комментарий</label>
              <textarea
                id="wiz-comment"
                rows={2}
                maxLength={2000}
                placeholder="Краткое описание заказа"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </div>

            {/*
              Редкие настройки свёрнуты. В прежней форме они стояли
              первыми и выталкивали выбор изделия за пределы экрана —
              см. аудит §4.1.
            */}
            <div className="order-wizard__extras">
              <button
                type="button"
                className="order-wizard__extras-toggle"
                onClick={() => setExtrasOpen((v) => !v)}
                aria-expanded={extrasOpen}
              >
                Ещё настройки: склад готовой продукции, учёт материалов в
                себестоимости {extrasOpen ? '▴' : '▾'}
              </button>
              {extrasOpen && (
                <div className="admin-form-grid order-wizard__extras-body">
                  <div className="admin-field">
                    <label htmlFor="wiz-warehouse">
                      Склад выпуска готовой продукции
                    </label>
                    <CreatableSelect
                      entity="warehouse"
                      id="wiz-warehouse"
                      value={finishedGoodsWarehouseId}
                      onValueChange={setFinishedGoodsWarehouseId}
                      existingValues={warehouses.map((w) => w.id)}
                    >
                      <option value="">— не выбран —</option>
                      {warehouses
                        .filter((w) => w.isActive)
                        .map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                            {w.code ? ` (${w.code})` : ''}
                          </option>
                        ))}
                    </CreatableSelect>
                    <span className="admin-field__hint">
                      Куда поступит готовая продукция после упаковки. Это не
                      склад материалов.
                    </span>
                  </div>
                  <div className="admin-field">
                    <label htmlFor="wiz-policy">
                      Учёт материалов и фурнитуры в себестоимости
                    </label>
                    <select
                      id="wiz-policy"
                      value={materialsAndHardwareCostPolicy}
                      onChange={(e) =>
                        setMaterialsPolicy(
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
                    <span className="admin-field__hint">
                      Потребность по количеству считается всегда; политика
                      влияет только на себестоимость.
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---------------- Шаг 2: изделие ---------------- */}
        {step === 'product' && (
          <div className="order-wizard__body">
            {savedConstructorTask ? (
              <SavedConstructorTaskCard
                task={savedConstructorTask}
                onDelete={() => {
                  setSavedConstructorTask(null);
                  setPatternItemId('');
                }}
                hint="Заказ уже создан черновиком и привязан к заявке. Расцветки, маршрут и нанесение появятся, когда конструктор приложит лекало."
              />
            ) : savedInlineProduct ? (
              <SavedInlineProductCard
                payload={savedInlineProduct}
                onEdit={() => {
                  setInlineTab('calculate');
                  setInlineOpen(true);
                }}
                onSendToConstructor={() => {
                  setInlineTab('constructor');
                  setInlineOpen(true);
                }}
                onDelete={() => {
                  setSavedInlineProduct(null);
                  setPatternItemId('');
                }}
                hint="Изделие сохранено. Нажмите «Далее», чтобы продолжить заполнение заказа."
              />
            ) : inlineOpen ? (
              <CreateProductInline
                initialCategories={patternCategories}
                initialTechCards={techCards}
                initialPatterns={patterns}
                sizes={sortedSizes}
                initialValue={savedInlineProduct}
                initialTab={inlineTab}
                createDraftOrderOnConstructor
                orderClientId={clientId || undefined}
                onSaveCalculateAsync={async (payload) => {
                  if (!clientId) {
                    return {
                      ok: false,
                      error:
                        'Сначала выберите клиента на шаге «Клиент» — это обязательное поле заказа.',
                    };
                  }
                  const dto = {
                    ...buildBasicsDto(),
                    productMode: 'CREATE_FOR_CALCULATION' as const,
                    newProductCalculation: {
                      categoryId: payload.categoryId,
                      techCardId: payload.techCardId,
                      patternDevelopmentCostRub: payload.patternDevelopmentCostRub,
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
                  };
                  const res = await createOrderForCalculationAction(dto);
                  if (res.ok && res.orderId) {
                    // Отличие от прежней формы: НЕ уводим на
                    // `/admin/orders/[id]/edit`. Черновик создан —
                    // остаёмся в мастере и продолжаем с шага 3.
                    setOrderId(res.orderId);
                    setSavedInlineProduct(payload);
                    setInlineOpen(false);
                    return { ok: true };
                  }
                  return {
                    ok: false,
                    error: res.error ?? 'Не удалось создать черновик заказа',
                  };
                }}
                onCancel={() => setInlineOpen(false)}
                onSave={(result) => {
                  if (result.kind === 'calculate') {
                    setSavedInlineProduct(result.payload);
                    setInlineOpen(false);
                    return;
                  }
                  // SEND_TO_CONSTRUCTOR: backend в одной транзакции создал
                  // DRAFT-лекало, заявку и заказ.
                  setSavedConstructorTask(result.result);
                  setPatternItemId(result.result.patternItemId);
                  setInlineOpen(false);
                  if (result.result.orderId) setOrderId(result.result.orderId);
                }}
              />
            ) : (
              <>
                <div className="order-wizard__branches" role="group">
                  <BranchCard
                    active={branch === 'EXISTING'}
                    title="Выбрать из номенклатуры"
                    hint="Готовое лекало с техкартой и размерами"
                    onClick={() => setBranch('EXISTING')}
                  />
                  <BranchCard
                    active={branch === 'CREATE'}
                    title="Создать изделие"
                    hint="Новое лекало: группа, техкарта, площади по размерам"
                    onClick={() => {
                      setBranch('CREATE');
                      setInlineTab('calculate');
                      setInlineOpen(true);
                    }}
                  />
                  <BranchCard
                    active={branch === 'CONSTRUCTOR'}
                    title="Отправить конструктору"
                    hint="Лекала ещё нет — заявка в КБ, заказ ждёт разработки"
                    onClick={() => {
                      setBranch('CONSTRUCTOR');
                      setInlineTab('constructor');
                      setInlineOpen(true);
                    }}
                  />
                </div>

                {branch === 'EXISTING' && (
                  <div className="order-wizard__product-grid">
                    <div className="order-wizard__product-main">
                      <div className="admin-field">
                        <label htmlFor="wiz-pattern">
                          Номенклатура / лекало{' '}
                          <span className="order-wizard__req">*</span>
                        </label>
                        <select
                          id="wiz-pattern"
                          value={patternItemId}
                          onChange={(e) => setPatternItemId(e.target.value)}
                          disabled={orderId !== null}
                          aria-invalid={
                            fieldError('patternItemId') ? true : undefined
                          }
                        >
                          <option value="">— выберите изделие —</option>
                          {patterns.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                              {p.article ? ` · ${p.article}` : ''}
                            </option>
                          ))}
                        </select>
                        {fieldError('patternItemId') && (
                          <span className="order-wizard__field-error">
                            {fieldError('patternItemId')}
                          </span>
                        )}
                        {orderId !== null && (
                          <span className="admin-field__hint">
                            Черновик уже создан — сменить лекало можно в
                            карточке заказа.
                          </span>
                        )}
                      </div>

                      {/*
                        Техкарта по умолчанию для заказа. При включённых
                        расцветках техкарта выбирается на КАЖДЫЙ цвет
                        (шаг 3), поэтому общий селект прячем — иначе два
                        контрола об одном.
                      */}
                      {!colorwaysEnabled && (
                        <div className="admin-field">
                          <label htmlFor="wiz-techcard">Техкарта</label>
                          <TechCardCombobox
                            id="wiz-techcard"
                            name="techCardId"
                            techCards={techCards}
                            categories={patternCategories}
                            value={techCardId}
                            onChange={setTechCardId}
                          />
                        </div>
                      )}
                    </div>

                    {selectedPattern && (
                      <div className="order-wizard__product-aside">
                        <PatternHeroPreview pattern={selectedPattern} />
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ---------------- Шаг 3: расцветки и размеры ---------------- */}
        {step === 'colorways' && (
          <div className="order-wizard__body">
            {colorwaysEnabled ? (
              <OrderColorwaysFieldset
                availableSizes={availableSizes}
                allSizes={sortedSizes}
                techCards={techCards}
                value={colorways}
                onChange={setColorways}
              />
            ) : (
              <SizePlanSelector
                allSizes={sortedSizes}
                availableSizes={availableSizes}
                quantities={quantities}
                onQuantitiesChange={setQuantities}
                selectedPatternName={selectedPattern?.name ?? null}
                selectedPatternArticle={selectedPattern?.article ?? null}
              />
            )}
            <div className="order-wizard__total">
              Итого по плану:{' '}
              <strong>{sizesTotal.toLocaleString('ru-RU')} шт</strong>
            </div>
          </div>
        )}

        {/* ---------------- Шаг 4: маршрут ---------------- */}
        {step === 'route' && (
          <div className="order-wizard__body">
            <div className="admin-field">
              <label htmlFor="wiz-route">Шаблон маршрута</label>
              <CreatableSelect
                entity="routeTemplate"
                id="wiz-route"
                value={routeTemplateId}
                onValueChange={setRouteTemplateId}
                existingValues={routeTemplates.map((t) => t.id)}
                onCreated={(tpl) =>
                  setExtraRoutePreviews((prev) => ({
                    ...prev,
                    [tpl.id]: {
                      id: tpl.id,
                      name: tpl.name,
                      steps: tpl.steps.map((s) => ({
                        id: s.id,
                        index: s.index,
                        name: s.operationName,
                      })),
                    },
                  }))
                }
              >
                <option value="">— без маршрута —</option>
                {routeTemplates.map((t) => (
                  <option
                    key={t.id}
                    value={t.id}
                    disabled={t.stepsCount === 0}
                  >
                    {t.name}
                    {t.stepsCount === 0
                      ? ' — нет шагов'
                      : ` — ${t.stepsCount} шагов`}
                  </option>
                ))}
              </CreatableSelect>
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
              <p className="admin-muted order-wizard__note">
                Маршрут можно выбрать позже — в карточке заказа. Без него
                заказ не запустится в производство.
              </p>
            )}
          </div>
        )}

        {/* ---------------- Шаг 5: нанесение ---------------- */}
        {step === 'applications' && (
          <div className="order-wizard__body">
            {/*
              `OrderApplicationsEditor` пишет строки в скрытый input
              `applicationsJson` — контракт, общий с формой правки и
              карточкой заказа. Оборачиваем в `<form>`, чтобы прочитать
              его через FormData на «Далее», не трогая сам редактор.
            */}
            <form
              ref={applicationsFormRef}
              onSubmit={(e) => e.preventDefault()}
            >
              <OrderApplicationsEditor
                availableSizes={availableSizes.map((s) => ({
                  id: s.id,
                  code: s.code,
                }))}
                disabled={pending}
              />
            </form>
            <p className="admin-muted order-wizard__note">
              На крое блокируется раскладка, пока параметры нанесения не
              заполнены. Шаг можно пропустить и вернуться к нему в карточке.
            </p>
          </div>
        )}

        {/* ---------------- Шаг 6: проверка ---------------- */}
        {step === 'review' && (
          <div className="order-wizard__body">
            <div className="order-wizard__review">
              <ReviewItem
                label="Клиент"
                value={selectedClient?.name ?? null}
                extra={selectedDivision?.name ?? null}
                onEdit={() => setStep('client')}
              />
              <ReviewItem
                label="Срок сдачи"
                value={dueDate || null}
                onEdit={() => setStep('client')}
              />
              <ReviewItem
                label="Изделие"
                value={
                  selectedPattern?.name ??
                  savedConstructorTask?.patternName ??
                  (savedInlineProduct ? 'Новое изделие' : null)
                }
                extra={
                  selectedPattern?.article ??
                  savedConstructorTask?.patternArticle ??
                  null
                }
                onEdit={() => setStep('product')}
              />
              <ReviewItem
                label="Тираж"
                value={sizesTotal > 0 ? `${sizesTotal} шт` : null}
                extra={
                  colorwaysEnabled && variantsPayload.length > 0
                    ? variantsPayload
                        .map((v) => `${v.color} ${v.sizes.reduce((s, x) => s + x.qtyPlan, 0)}`)
                        .join(' · ')
                    : null
                }
                onEdit={
                  awaitingPattern ? undefined : () => setStep('colorways')
                }
              />
              <ReviewItem
                label="Маршрут"
                value={selectedRoute?.name ?? null}
                extra={
                  selectedRoute ? `${selectedRoute.steps.length} шагов` : null
                }
                onEdit={awaitingPattern ? undefined : () => setStep('route')}
              />
              <ReviewItem
                label="Нанесение"
                value={skipped.has('applications') ? null : null}
                onEdit={
                  awaitingPattern ? undefined : () => setStep('applications')
                }
              />
            </div>

            {awaitingPattern && (
              <p className="order-wizard__warn">
                Заказ привязан к заявке в КБ и ждёт лекала. Размеры, маршрут и
                нанесение появятся, когда конструктор приложит лекало — до
                этого отправить заказ в расчёт нельзя.
              </p>
            )}
            {!awaitingPattern && sizesTotal === 0 && (
              <p className="order-wizard__warn">
                План по размерам не заполнен — без него заказ не уйдёт в
                расчёт. Вернитесь на шаг «Расцветки и размеры».
              </p>
            )}
            {/*
              Гейт `startCalculation` требует техкарту (400
              `ORDER_TECH_CARD_REQUIRED`). При расцветках order-level
              поле пустое, и backend поднимает техкарту из первой
              расцветки — считаем так же и предупреждаем ДО клика, а не
              ошибкой после него.
            */}
            {!awaitingPattern && !resolvedTechCardId && (
              <p className="order-wizard__warn">
                Техкарта не выбрана — без неё заказ не уйдёт в расчёт и
                материалы не рассчитаются. Укажите её{' '}
                {colorwaysEnabled
                  ? 'в карточке расцветки на шаге «Расцветки и размеры»'
                  : 'на шаге «Изделие»'}
                .
              </p>
            )}
            {!awaitingPattern && skipped.has('applications') && (
              <p className="order-wizard__warn">
                Нанесение пропущено. На крое будет заблокирована раскладка,
                пока параметры не заполнены — это можно сделать позже в
                карточке заказа.
              </p>
            )}
          </div>
        )}
      </AdminCard>

      {/* ---------------- Навигация мастера ---------------- */}
      <div className="order-wizard__foot">
        <div className="order-wizard__foot-left">
          {step === 'client' ? (
            <Link href="/admin/orders" className="admin-btn admin-btn--ghost">
              <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
            </Link>
          ) : (
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={goBack}
              disabled={pending}
            >
              <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
              Назад
            </button>
          )}
          {isOptional && step !== 'review' && (
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={skipStep}
              disabled={pending}
            >
              Пропустить
            </button>
          )}
          {step === 'review' && orderId && (
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={() => finish('draft')}
              disabled={pending}
            >
              Оставить черновиком
            </button>
          )}
        </div>

        {step === 'review' ? (
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            onClick={() => finish('calculation')}
            disabled={
              pending ||
              !orderId ||
              awaitingPattern ||
              sizesTotal === 0 ||
              !resolvedTechCardId
            }
            title={
              awaitingPattern
                ? 'Заказ ждёт лекала от конструктора'
                : sizesTotal === 0
                  ? 'Заполните план по размерам'
                  : !resolvedTechCardId
                    ? 'Выберите техкарту'
                    : undefined
            }
          >
            {pending && <Loader2 size={16} className="admin-spin" aria-hidden />}
            Отправить в расчёт
            <ArrowRight size={16} strokeWidth={1.6} aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            onClick={goNext}
            disabled={pending || inlineOpen}
            data-testid="order-wizard-next"
          >
            {pending && <Loader2 size={16} className="admin-spin" aria-hidden />}
            {currentCfg.nextLabel}
            <ArrowRight size={16} strokeWidth={1.6} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

function BranchCard({
  active,
  title,
  hint,
  onClick,
}: {
  active: boolean;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`order-wizard__branch${active ? ' order-wizard__branch--active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className="order-wizard__branch-title">{title}</span>
      <span className="order-wizard__branch-hint">{hint}</span>
    </button>
  );
}

function ReviewItem({
  label,
  value,
  extra,
  onEdit,
}: {
  label: string;
  value: string | null;
  extra?: string | null;
  onEdit?: () => void;
}) {
  return (
    <div className="order-wizard__review-item">
      <div className="order-wizard__review-head">
        <span className="order-wizard__review-label">{label}</span>
        {onEdit && (
          <button
            type="button"
            className="order-wizard__review-edit"
            onClick={onEdit}
            aria-label={`Изменить: ${label}`}
          >
            Изменить
          </button>
        )}
      </div>
      <div className="order-wizard__review-value">
        {value ? (
          <strong>{value}</strong>
        ) : (
          <span className="admin-muted">не задано</span>
        )}
        {extra && <span className="order-wizard__review-extra">{extra}</span>}
      </div>
    </div>
  );
}
