/**
 * Управленческая карточка заказа `/admin/orders/[id]` (view-mode).
 *
 * Целевая структура (см. ТЗ «Целевая структура страницы заказа»):
 *
 *   1. Постоянная компактная шапка `OrderManagementHeader` —
 *      summary заказа + основные workflow-actions (видна на всех
 *      вкладках).
 *   2. `OrderActionCenter` — короткие задачи / предупреждения с
 *      ссылками в нужную вкладку (без таблиц / метрик).
 *   3. Линейка вкладок `OrderViewTabs`:
 *        - Производство     — KPI стадий, размерный breakdown,
 *          текущие stage buckets из `/api/shopfloor/state`;
 *        - Паспорта         — список паспортов + фильтры (только
 *          эта вкладка показывает паспорта);
 *        - План             — продукт / лекало / цвет / план по
 *          размерам / маршрут / привязка к техкарте;
 *        - Операции         — единый рабочий экран по операциям
 *          заказа (`OrderOperationsUnifiedTable`): маршрут, нормы,
 *          план/факт, операционный план, узкое место. Это
 *          профильный компонент операций, **не** itemized cost
 *          breakdown — для cost-screen существует отдельная вкладка
 *          «Сводно по заказу» (`OrderSummaryTab`), а не «Операции»
 *          и тем более не «Потребности»;
 *        - Сводно по заказу — отдельная финансовая вкладка,
 *          dedicated cost deep-dive: расходы (материалы, фурнитура,
 *          операции, внешние работы / нанесение), итоговая
 *          себестоимость тиража и за 1 изделие, цена продажи,
 *          выручка, прибыль и маржинальность, плюс предупреждения
 *          по себестоимости. Использует `OrderSummaryTab` →
 *          `OrderSummaryUnifiedTable`. Здесь допустимо показывать
 *          материалы как строки себестоимости — это не дублирует
 *          «Потребности», потому что у вкладок разные роли
 *          (procurement vs cost breakdown). id вкладки —
 *          `costSummary`, чтобы явно отделить новую финансовую
 *          вкладку от старого generic `summary`, который раньше
 *          создавал путаницу;
 *        - Потребности      — материалы (+ потребность цеха +
 *          готовность к крою + закупки), внешние подряды,
 *          aggregate-only себестоимость
 *          (`OrderPlannedCostSummaryCard`). Itemized cost breakdown
 *          (`OrderSummaryUnifiedTable`) сюда подключать нельзя —
 *          ownership rule живёт в JSDoc `OrderNeedsTab`;
 *        - История          — empty-state-плашка с TODO-комментарием,
 *          пока нет API audit-log.
 *
 * Что СОЗНАТЕЛЬНО НЕ показываем (см. ТЗ §«Не делай»):
 *   - вкладки «Обзор» нет — её содержимое разнесено в шапку и
 *     соответствующие тематические вкладки;
 *   - вкладки «Продукция» нет — изделие/лекало/цвет в шапке + детали
 *     в вкладке «План»;
 *   - вкладки «Логистика» как самостоятельной нет — закупки и приёмки
 *     уже включены в `OrderMaterialsUnifiedTable`;
 *   - вкладки «Рекомендации» как самостоятельной нет — алерты живут в
 *     `OrderActionCenter`.
 *
 * RBAC. Layout `/admin/*` уже пускает только `ADMIN`/`SHOP_MANAGER`
 * (см. `apps/web/app/admin/layout.tsx`), поэтому мы здесь не дублируем
 * проверку. Все workflow-actions делегируются существующим
 * server-actions из `app/orders/actions.ts` — backend независимо
 * валидирует RBAC и переходы статусов.
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 */
import { notFound } from 'next/navigation';
import { Package } from 'lucide-react';
import type { OrderDetailDto } from '@sewing/shared/orders';
import type { PassportListItemDto } from '@sewing/shared/passports';
import type {
  OrderCalculationsDto,
  OrderColorwaysDto,
} from '@sewing/shared';
import type { OrderTechCardParametersDto } from '@sewing/shared/order-tech-cards';
import { ApiRequestError } from '@/lib/api';
import { getOrder } from '@/lib/orders-api';
import { listOrderPassports } from '@/lib/passports-api';
import { getOrderCutIssueRules } from '@/lib/order-cut-issue-rules-api';
import { getOrderColorways } from '@/lib/colorways-api';
import { getOrderTechCardParameters } from '@/lib/order-tech-card-api';
import {
  isColorwaysEnabled,
  isOrderCalculationsEnabled,
} from '@/lib/feature-flags';
import { getOrderCalculations } from '@/lib/order-calculations-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { OrderCalcTabs } from '@/components/orders/calculations/order-calc-tabs';
import { OrderColorwaysBlock } from '@/components/orders/colorways/order-colorways-block';
import { AdminPageShell } from '@/components/admin';
import {
  OrderTabEmptyState,
  OrderWorkspaceLayout,
} from '@/components/orders/order-workspace-layout';
import { OrderActionCenter } from '@/components/orders/view/order-action-center';
import { OrderConstructorTaskCard } from '@/components/orders/order-constructor-task-card';
import { OrderManagementHeader } from '@/components/orders/view/order-management-header';
import { OrderViewTabs } from '@/components/orders/view/order-view-tabs';
import {
  parseOrderViewTab,
  type OrderViewTabId,
} from '@/components/orders/view/order-view-tabs-config';
import { OrderProductionTab } from '@/components/orders/view/tabs/order-production-tab';
import { OrderPassportsTab } from '@/components/orders/view/tabs/order-passports-tab';
import { OrderOperationsTab } from '@/components/orders/tabs/order-operations-tab';
import { OrderSummaryTab } from '@/components/orders/tabs/order-summary-tab';
import { OrderNeedsTab } from '@/components/orders/view/tabs/order-needs-tab';
import { OrderSignalSampleTab } from '@/components/orders/view/tabs/order-signal-sample-tab';
import { OrderHistoryTab } from '@/components/orders/view/tabs/order-history-tab';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
  searchParams?: { tab?: string | string[] };
}

export default async function AdminOrderDetailPage({
  params,
  searchParams,
}: Params) {
  const activeTab: OrderViewTabId = parseOrderViewTab(searchParams?.tab);

  let order: OrderDetailDto;
  try {
    order = await getOrder(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  let passports: PassportListItemDto[] = [];
  try {
    passports = await listOrderPassports(order.id);
  } catch {
    // Не валим карточку, если по какой-то причине запрос паспортов
    // упал (например, временный 5xx). Шапка / алерты по факту 0
    // паспортов всё равно работают.
    passports = [];
  }

  const me = await getCurrentUserOrNull();
  // Layout `/admin/*` уже пустил только ADMIN / SHOP_MANAGER, но мы
  // явно вычисляем флаг — на нём завязаны управленческие кнопки в
  // outsource-блоке (mark ordered / received).
  const role = me?.user.role;
  const isManager = role === 'ADMIN' || role === 'SHOP_MANAGER';
  // «Очередь выдачи кроя по размерам» — отдельная карточка во вкладке
  // «План» (см. `OrderCutIssueRulesCard` /
  // `apps/api/src/modules/order-cut-issue-rules/*`). Тянем сводку
  // тут, чтобы tab-компонент остался синхронным.
  const cutIssueRulesSummary = await getOrderCutIssueRules(order.id);

  // Фича «Расцветки» (FEATURE_COLORWAYS): аддитивный блок в шапке
  // карточки. Флаг OFF на проде по умолчанию, ON на dev. Ошибку
  // запроса глушим — блок просто не рисуется, карточка не падает.
  let colorways: OrderColorwaysDto | null = null;
  // Фича «Параметры техкарт»: слоты и их значения по расцветкам. Живут в том
  // же блоке (плитка расцветки показывает, сколько ещё не заполнено).
  let techCardParams: OrderTechCardParametersDto | null = null;
  if (isColorwaysEnabled()) {
    try {
      [colorways, techCardParams] = await Promise.all([
        getOrderColorways(order.id),
        getOrderTechCardParameters(order.id),
      ]);
    } catch {
      colorways = null;
      techCardParams = null;
    }
  }

  // Фича «Варианты просчёта» (FEATURE_ORDER_CALCULATIONS): ряд вкладок
  // вариантов НАД окном заказа. Ошибку запроса глушим — ряд просто не
  // рисуется, карточка не падает (тот же приём, что у colorways).
  let calculations: OrderCalculationsDto | null = null;
  if (isOrderCalculationsEnabled()) {
    try {
      calculations = await getOrderCalculations(order.id);
    } catch {
      calculations = null;
    }
  }
  // Итерация 3 «стадия per вариант»: активный вариант — черновик →
  // в шапке появляется «Рассчитать вариант» (заказ уже в CALCULATION).
  const activeCalculationDraft =
    calculations != null &&
    (calculations.items.find((i) => i.isActive)?.sentToCalculationAt ==
      null);
  // Фича «Варианты просчёта»: окно заказа зависит от АКТИВНОГО варианта.
  // Client-компоненты внутри (блок расцветок/параметров, таблицы
  // материалов) держат состояние в useState(initial) и своих fetch —
  // после переключения варианта `router.refresh()` отдаёт новые
  // серверные пропсы, но без remount client-state показывал бы данные
  // прошлого варианта. `key` по активной калькуляции форсит перемонтаж
  // всего поддерева на свежие данные варианта.
  const workspaceKey = calculations?.activeId ?? 'no-calc';

  const clientName = order.client?.name ?? order.customer ?? null;
  const canIssuePassport = order.status === 'IN_PRODUCTION';
  // Подразделение заказа — FK на `CompanyDivision` (см.
  // `docs/domain.md §«Подразделения заказа»`). Для заказов без
  // привязки показываем «Не указано» в подзаголовке.
  const divisionLabel = order.companyDivision?.name ?? 'Не указано';

  return (
    <AdminPageShell
      icon={<Package size={22} strokeWidth={1.6} aria-hidden />}
      title="Заказы"
      subtitle={clientName ? `${divisionLabel} · ${clientName}` : divisionLabel}
    >
      {/* Ряд вкладок вариантов — ВНЕ `key` окна: при переключении варианта
          окно перемонтируется (свежие данные варианта), а сам ряд должен
          оставаться стабильным, иначе его перемонтаж во время собственного
          перехода (activate) мигает и рвёт состояние. */}
      {calculations && (
        <OrderCalcTabs orderId={order.id} initial={calculations} />
      )}
      <OrderWorkspaceLayout
        key={workspaceKey}
        mode="view"
        hero={
          <>
            <OrderManagementHeader
              order={order}
              passports={passports}
              activeCalculationDraft={activeCalculationDraft}
            />
            <OrderActionCenter order={order} passports={passports} />
            {colorways && (
              <OrderColorwaysBlock
                orderId={order.id}
                initial={colorways}
                techCardParams={techCardParams}
                // Расцветки редактируемы только пока план не заморожен
                // (DRAFT/CALCULATION) — то же окно, что и бэкенд-гайд
                // `ORDER_COLORWAYS_LOCKED`. Иначе блок показываем read-only,
                // чтобы форма не «сохраняла» правки, которые не поднимутся в
                // общий план заказа.
                editable={
                  order.status === 'DRAFT' || order.status === 'CALCULATION'
                }
              />
            )}
            {order.constructorTask && (
              <OrderConstructorTaskCard task={order.constructorTask} />
            )}
          </>
        }
        tabs={<OrderViewTabs orderId={order.id} activeTab={activeTab} />}
      >
        {activeTab === 'production' && (
          <div className="order-tab-panel">
            <OrderProductionTab
              order={order}
              canManage={isManager}
              cutIssueRulesSummary={cutIssueRulesSummary}
            />
          </div>
        )}

        {activeTab === 'passports' && (
          <div className="order-tab-panel">
            <OrderPassportsTab
              orderId={order.id}
              passports={passports}
              routeSteps={order.routeSteps}
              canIssuePassport={canIssuePassport}
              canDelete={isManager}
            />
          </div>
        )}

        {activeTab === 'operations' && (
          <div className="order-tab-panel">
            {/*
              Профильный компонент операций (`OrderOperationsTab` →
              `OrderOperationsUnifiedTable`). СОЗНАТЕЛЬНО НЕ возвращаем
              операции через `OrderSummaryUnifiedTable` — это itemized
              cost breakdown, его место в отдельной вкладке «Сводно по
              заказу», а не в «Операциях» и не в «Потребностях»
              (см. JSDoc `OrderNeedsTab`).
            */}
            <OrderOperationsTab order={order} passports={passports} />
          </div>
        )}

        {activeTab === 'costSummary' && (
          <div className="order-tab-panel order-summary-tab">
            {/*
              Финансовая вкладка «Сводно по заказу» — dedicated cost
              deep-dive: расходы (материалы / фурнитура / операции /
              нанесение / прочее) одной таблицей,
              KPI-полоса (себестоимость / шт, тираж, цена продажи /
              шт, выручка, маржа, маржинальность), итоговый блок и
              предупреждения. Здесь допустимо показывать материалы и
              операции как строки cost breakdown — это не дублирует
              «Потребности», потому что у вкладок разные роли:
              «Потребности» владеет procurement state
              (`OrderMaterialsUnifiedTable` + закупки + приёмки),
              «Сводно по заказу» владеет финансовой картиной заказа.
              id вкладки — `costSummary`, чтобы явно отделить новую
              финансовую вкладку от старого generic `summary`.
            */}
            <OrderSummaryTab order={order} passports={passports} />
          </div>
        )}

        {activeTab === 'needs' && (
          <div className="order-tab-panel">
            <OrderNeedsTab
              order={order}
              passports={passports}
              canManage={isManager}
            />
          </div>
        )}

        {activeTab === 'signalSample' && (
          <div className="order-tab-panel">
            {/*
              Вкладка «Сигнальный образец» (MVP, см.
              `docs/order-signal-sample-flow.md`,
              `docs/order-signal-sample-recon.md`).

              Запуск образца, согласование / отклонение / отмена,
              отображение эффекта на тираж. backend модуль —
              `apps/api/src/modules/order-samples/*`.
            */}
            <OrderSignalSampleTab order={order} canManage={isManager} />
          </div>
        )}

        {activeTab === 'history' && (
          <div className="order-tab-panel">
            {/*
              History сознательно идёт без props: пока нет публичного
              audit-log API, мы не хотим пробрасывать `order` /
              `passports` и плодить искушение собрать псевдо-таймлайн
              из текущих полей. См. TODO в `order-history-tab.tsx`.
            */}
            <OrderHistoryTab />
          </div>
        )}

        {/* Защита от случайного `?tab=что-то-неизвестное`: parseOrderViewTab
            всегда вернёт известный id, но мы держим fallback empty-state
            здесь, чтобы tsx-компилятор был доволен exhaustive-проверкой
            и UI не оказался пустым в случае будущей рассинхронизации. */}
        {activeTab !== 'production' &&
          activeTab !== 'passports' &&
          activeTab !== 'operations' &&
          activeTab !== 'costSummary' &&
          activeTab !== 'needs' &&
          activeTab !== 'signalSample' &&
          activeTab !== 'history' && (
            <OrderTabEmptyState
              title="Раздел не найден"
              hint="Откройте «Производство» — это default-вкладка карточки заказа."
            />
          )}
      </OrderWorkspaceLayout>
    </AdminPageShell>
  );
}
