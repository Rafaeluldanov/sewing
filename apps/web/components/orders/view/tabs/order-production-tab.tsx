/**
 * `OrderProductionTab` — вкладка «Производство» управленческой
 * карточки `/admin/orders/[id]?tab=production`.
 *
 * ПРОТОТИП объединённой таблицы (см. обсуждение «объединить три
 * таблицы вкладки производство»). Раньше срез заказа жил в ТРЁХ
 * раздельных таблицах:
 *   - «По размерам»  — плановая воронка (`OrderSizeBreakdownRow[]`):
 *     план / раскроено / Δ / брак — НАКОПИТЕЛЬНЫЕ величины;
 *   - «Цех сейчас»   — где паспорта стоят ПРЯМО СЕЙЧАС
 *     (`GET /api/shopfloor/state`, бакеты CUT/SEWING/QC/QC_DONE/…);
 *   - «Отгрузка» (превью балансов готовой продукции).
 *
 * Теперь это ОДНА матрица «размер × этап» (`ProductionMatrix`) со
 * сгруппированной шапкой, читаемая слева направо как сквозная
 * воронка: План → В цеху сейчас → Отгрузка. Группа «В цеху сейчас»
 * повторяет модель доски монитора — на каждом этапе показываем
 * «▶ в работе сейчас» (красным) и «✔ выполнено, ждёт следующий шаг»
 * (зелёным буфером). Данные `*_DONE` для этого уже есть в
 * `ShopfloorRowDto` — бэкенд не трогаем.
 *
 * Что СОЗНАТЕЛЬНО остаётся отдельно:
 *   - ОТГРУЗКА: блок «Отгрузка готовой продукции» (превью остатков +
 *     журнал документов) убран — созданные отгрузки теперь живут в
 *     отдельной таблице «Отгрузка». В этой вкладке осталась только
 *     кнопка «Создать отгрузку» в шапке карточки «Производство по
 *     размерам» (открывает модалку), а превью балансов отражено
 *     колонкой «К отгрузке» матрицы.
 *   - список паспортов (вкладка «Паспорта»), материалы (вкладка
 *     «Потребности»), hero-метрики (шапка).
 *
 * 26.07 «вкладки под шапку». Раньше между постоянной шапкой заказа и
 * линейкой вкладок стояли ещё два блока во всю ширину — «Расцветки»
 * (`OrderColorwaysBlock`) и «Заявки в КБ» (`OrderConstructorTaskCard`):
 * они висели над ВСЕМИ вкладками и отодвигали линейку вниз, хотя
 * относятся к плану заказа, а не к разделу. Оба переехали сюда, в
 * начало «Производства» — к настроечным блокам («Цвета по строкам
 * техкарты», «Очередь выдачи кроя»), которые уже жили в этой вкладке.
 * В hero остался только `OrderManagementHeader`, поэтому вкладки
 * теперь идут сразу под шапкой.
 *
 * Backend / DTO / Prisma здесь не задействованы — это presentation-
 * слой, склейка трёх готовых read-only проекций по `sizeId`.
 */
import type {
  OrderDetailDto,
  OrderRouteStepDto,
  OrderSizeBreakdownRow,
} from '@sewing/shared/orders';
import { isOrderRouteEditable } from '@sewing/shared/orders';
import type {
  OperationAmendmentStateDto,
  OrderColorwaysDto,
  OrderCutIssueRulesSummaryDto,
  QuantityAmendmentStateDto,
  SizeAmendmentStateDto,
} from '@sewing/shared';
import type { OrderTechCardParametersDto } from '@sewing/shared/order-tech-cards';
import type {
  ShopfloorRowDto,
  ShopfloorStateDto,
} from '@sewing/shared/shopfloor';
import {
  AdminCard,
  AdminEmptyState,
  AdminRouteSteps,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import { ApiRequestError, errorText } from '@/lib/api';
import { getShopfloorState } from '@/lib/shopfloor-api';
import {
  listFinishedGoodsBalances,
  listOrderFinishedGoodsShipments,
  type FinishedGoodsBalanceListItem,
} from '@/lib/finished-goods-api';
import { Activity, Layers, Lock, Workflow } from 'lucide-react';
import { CreateFinishedGoodsShipmentButton } from '@/components/orders/finished-goods/create-finished-goods-shipment-button';
import { OrderAmendmentButton } from '@/components/orders/amendments/order-amendment-button';
import { OrderAmendmentHistoryCard } from '@/components/orders/amendments/order-amendment-history-card';
import {
  getAmendmentHistory,
  getOperationAmendmentState,
  getQuantityAmendmentState,
  getSizeAmendmentState,
} from '@/lib/amendments-api';
import { isOrderAmendmentsEnabled } from '@/lib/feature-flags';
import type { AmendmentHistoryEntryDto } from '@sewing/shared';
import { OrderMaterialColorsCard } from '@/components/orders/view/order-material-colors-card';
import { OrderCutIssueRulesCard } from '@/components/orders/order-cut-issue-rules-card';
import { RouteModeToggle } from '@/components/orders/view/route-mode-toggle';
import { OrderColorwaysBlock } from '@/components/orders/colorways/order-colorways-block';
import { OrderConstructorTaskCard } from '@/components/orders/order-constructor-task-card';
import { OrderApplicationsCard } from '@/components/orders/order-applications-card';

interface Props {
  order: OrderDetailDto;
  /**
   * ADMIN / SHOP_MANAGER — определяет видимость кнопки «Создать
   * отгрузку» в блоке готовой продукции и управление блоками «Цвета
   * по строкам техкарты» / «Очередь выдачи кроя» (переехали сюда из
   * удалённой вкладки «План»). Layout `/admin/*` уже пускает только
   * этих ролей, флаг нужен для симметрии с остальными action-блоками
   * карточки заказа.
   */
  canManage: boolean;
  /**
   * Сводка «Очередь выдачи кроя по размерам» (см.
   * `apps/web/components/orders/order-cut-issue-rules-card.tsx`).
   * Получаем готовой из admin-page (`/admin/orders/[id]`), чтобы не
   * делать дополнительный запрос внутри tab-компонента. Раньше блок
   * жил во вкладке «План».
   */
  cutIssueRulesSummary: OrderCutIssueRulesSummaryDto;
  /**
   * Фича «Расцветки» (`FEATURE_COLORWAYS`): расцветки заказа + их
   * поразмерный план. Приходят готовыми из `/admin/orders/[id]` — тянуть
   * их внутри вкладки незачем, страница уже грузит их одной пачкой для
   * всей карточки. `null` — флаг выключен или запрос не удался: блок
   * просто не рисуется (вкладка из-за этого не падает).
   */
  colorways: OrderColorwaysDto | null;
  /**
   * Фича «Параметры техкарт»: слоты и их значения по расцветкам. Живут в
   * том же блоке (плитка расцветки открывает спецификацию материалов).
   */
  techCardParams: OrderTechCardParametersDto | null;
}

export async function OrderProductionTab({
  order,
  canManage,
  cutIssueRulesSummary,
  colorways,
  techCardParams,
}: Props) {
  // Stage buckets имеют смысл только когда заказ реально едет в
  // производстве: до запуска (DRAFT/CALCULATION/CALCULATION_DONE)
  // паспортов нет, проекция пуста, а endpoint `/api/shopfloor/state`
  // на DRAFT-заказ может отдать 4xx. После CANCELLED тоже грузить
  // незачем. Подключаем только для `IN_PRODUCTION` и `DONE`.
  const shopfloorEligible =
    order.status === 'IN_PRODUCTION' || order.status === 'DONE';
  // Маршрут — snapshot после запуска (ADR-0006): показываем плашку
  // «snapshot» в тех же статусах, что и на бывшей вкладке «План».
  const isStarted =
    order.status === 'IN_PRODUCTION' ||
    order.status === 'DONE' ||
    order.status === 'CANCELLED';

  let shopfloor: ShopfloorStateDto | null = null;
  let shopfloorError: string | null = null;
  if (shopfloorEligible) {
    try {
      shopfloor = await getShopfloorState(order.id);
    } catch (e) {
      shopfloorError =
        e instanceof ApiRequestError
          ? errorText(e)
          : 'Не удалось получить состояние цеха';
    }
  }

  // «Готово к отгрузке» (остаток на складе ГП) и «Отгружено» (Σ
  // POSTED-строк отгрузок) сводим к уровню размера, чтобы показать
  // хвост воронки прямо в матрице. Оба endpoint-а — read-only списки,
  // фильтрованные по orderId; на DRAFT просто отдают пусто, поэтому
  // грузим всегда и мягко деградируем при ошибке.
  const readyToShipBySize = new Map<string, number>();
  const shippedBySize = new Map<string, number>();
  // Остатки готовой продукции (positiveOnly) питают и колонку «К
  // отгрузке» матрицы, и форму кнопки «Создать отгрузку» в шапке
  // карточки «Производство по размерам».
  let shipmentBalances: FinishedGoodsBalanceListItem[] = [];
  try {
    const balances = await listFinishedGoodsBalances({
      orderId: order.id,
      positiveOnly: true,
      limit: 200,
    });
    shipmentBalances = balances.items;
    for (const b of balances.items) {
      readyToShipBySize.set(
        b.sizeId,
        (readyToShipBySize.get(b.sizeId) ?? 0) + b.qty,
      );
    }
  } catch {
    // Колонка «К отгрузке» останется пустой — не роняем весь срез.
  }
  try {
    const shipments = await listOrderFinishedGoodsShipments(order.id);
    for (const s of shipments) {
      if (s.status !== 'POSTED') continue;
      for (const line of s.lines) {
        shippedBySize.set(
          line.sizeId,
          (shippedBySize.get(line.sizeId) ?? 0) + line.qty,
        );
      }
    }
  } catch {
    // Колонка «Отгружено» останется пустой.
  }

  const shopBySize = new Map<string, ShopfloorRowDto>();
  if (shopfloor) {
    for (const r of shopfloor.rows) shopBySize.set(r.sizeId, r);
  }

  // Правка заказа (фича FEATURE_ORDER_AMENDMENTS). Два разных окна:
  //   - количество/размерность — только `IN_PRODUCTION` (второй ярус
  //     редактируемости поверх заморозки плана, ADR-0006);
  //   - маршрут — `ORDER_ROUTE_EDITABLE_STATUSES`, т.е. и на расчёте:
  //     состав операций меняют «на ходу», а до запуска фронт производства
  //     пуст и холст правит всю цепочку.
  // Грузим состояния только когда действие реально доступно. При ошибке
  // просто не показываем кнопку (не роняем вкладку).
  const amendmentsEnabled = canManage && isOrderAmendmentsEnabled();
  let quantityState: QuantityAmendmentStateDto | null = null;
  let sizeState: SizeAmendmentStateDto | null = null;
  let operationState: OperationAmendmentStateDto | null = null;
  if (amendmentsEnabled && order.status === 'IN_PRODUCTION') {
    try {
      [quantityState, sizeState] = await Promise.all([
        getQuantityAmendmentState(order.id),
        getSizeAmendmentState(order.id),
      ]);
    } catch {
      quantityState = null;
      sizeState = null;
    }
  }
  if (amendmentsEnabled && isOrderRouteEditable(order.status)) {
    try {
      operationState = await getOperationAmendmentState(order.id);
    } catch {
      operationState = null;
    }
  }
  // Полная правка (три вкладки) — только когда доступны ВСЕ состояния.
  const amendmentAvailable =
    quantityState !== null && sizeState !== null && operationState !== null;
  // Правка маршрута — отдельная кнопка в карточке «Маршрут операций».
  // Она видна и на расчёте, где количества/размерности в окне нет.
  const routeEditAction = operationState ? (
    <OrderAmendmentButton
      orderId={order.id}
      quantityState={null}
      sizeState={null}
      operationState={operationState}
      label="Изменить маршрут"
      variant="route"
      testId="order-route-edit-button"
    />
  ) : null;
  const matrixActions =
    amendmentAvailable || (canManage && shipmentBalances.length > 0) ? (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {amendmentAvailable && (
          <OrderAmendmentButton
            orderId={order.id}
            quantityState={quantityState!}
            sizeState={sizeState!}
            operationState={operationState!}
            label="Изменить в производстве"
          />
        )}
        {canManage && shipmentBalances.length > 0 && (
          <CreateFinishedGoodsShipmentButton
            orderId={order.id}
            balances={shipmentBalances}
          />
        )}
      </div>
    ) : null;

  // Журнал правок — read-only. Виден со статуса «Расчёт завершён» и дальше:
  // с этого момента правка спецификации техкарты идёт amendment-путём и
  // пишет `ORDER_TECH_CARD_AMENDED`, а после завершения (DONE) журнал нужен,
  // чтобы посмотреть, что меняли. Карточка сама возвращает null, если
  // записей нет, — на «чистых» заказах ничего не появится.
  let amendmentHistory: AmendmentHistoryEntryDto[] = [];
  if (
    isOrderAmendmentsEnabled() &&
    (order.status === 'CALCULATION_DONE' ||
      order.status === 'SAMPLE_PRODUCTION' ||
      order.status === 'IN_PRODUCTION' ||
      order.status === 'DONE')
  ) {
    try {
      amendmentHistory = await getAmendmentHistory(order.id);
    } catch {
      amendmentHistory = [];
    }
  }

  return (
    <div className="order-prod-tab">
      {/*
        Расцветки — первым блоком вкладки: до 26.07 они стояли над
        линейкой вкладок и были видны на любой из них. Правка расцветки
        поднимается в агрегат `OrderItem` только пока план не заморожен
        (`DRAFT`/`CALCULATION`) — то же окно, что и бэкенд-гайд
        `ORDER_COLORWAYS_LOCKED`. Вне его блок read-only, иначе форма
        «сохраняла» бы правки, которые не изменят общий план заказа.
      */}
      {colorways && (
        <OrderColorwaysBlock
          orderId={order.id}
          initial={colorways}
          techCardParams={techCardParams}
          editable={
            order.status === 'DRAFT' || order.status === 'CALCULATION'
          }
        />
      )}

      {/* «Заявки в КБ» — переехала сюда из hero вместе с расцветками.
          Компонент сам возвращает null, если задачи у заказа нет. */}
      <OrderConstructorTaskCard task={order.constructorTask} />

      {/*
        «Нанесение» — рядом с расцветками: это такой же атрибут плана
        заказа, и окно правки у них общее — пока расчёт не завершён
        (DRAFT/CALCULATION). В нём карточка рендерит форму (full-replace
        через `PUT /orders/:id/applications`, backend сам пересобирает
        потребность цеха), дальше — read-only список со статусом каждой
        строки (`ORDER_APPLICATION_ORDER_LOCKED`). Размеры для адресации
        «на выбранные размеры» берём из планового среза заказа.
      */}
      <AdminCard className="admin-order-detail-card-compact">
        <OrderApplicationsCard
          orderId={order.id}
          orderStatus={order.status}
          sizes={order.sizeBreakdown.map((r) => ({
            id: r.sizeId,
            code: r.sizeCode,
          }))}
        />
      </AdminCard>

      <AdminCard className="admin-order-detail-card-compact">
        <AdminSectionHeader
          icon={<Workflow size={18} strokeWidth={1.7} aria-hidden />}
          title="Маршрут операций"
          hint={order.routeTemplateName ?? order.techCardName ?? undefined}
          actions={
            routeEditAction || isStarted ? (
              <div
                style={{ display: 'flex', gap: 8, alignItems: 'center' }}
              >
                {isStarted && (
                  <AdminStatusBadge tone="muted">
                    <Lock size={12} strokeWidth={1.7} aria-hidden /> snapshot
                  </AdminStatusBadge>
                )}
                {routeEditAction}
              </div>
            ) : null
          }
        />
        <dl className="admin-deflist">
          <dt>Шаблон маршрута</dt>
          <dd>
            {order.routeTemplateName ? (
              <strong>{order.routeTemplateName}</strong>
            ) : (
              <span className="admin-muted">не выбран</span>
            )}
            {/*
              Маршрут правили руками: цепочка ниже больше не повторяет
              шаблон, названный строкой выше. Без этой пометки расхождение
              читается как баг, а не как решение менеджера. Заодно это
              предупреждение: правки шаблона в справочнике сюда не доедут.
            */}
            {order.routeCustomized && (
              <>
                {' '}
                <AdminStatusBadge tone="warning">
                  изменён в заказе
                </AdminStatusBadge>
              </>
            )}
          </dd>
          <dt>Шаблон техкарты</dt>
          <dd>
            {order.techCardName ? (
              <strong>{order.techCardName}</strong>
            ) : (
              <span className="admin-muted">не выбран</span>
            )}
          </dd>
        </dl>
        {(order.routeTemplateName?.toLowerCase().includes('сплит') ||
          order.routeModeOverride !== 'AUTO') && (
          <div className="order-plan-tab__route-mode">
            <span className="admin-deflist__subtitle">Режим распошива</span>
            <RouteModeToggle
              orderId={order.id}
              current={order.routeModeOverride}
            />
          </div>
        )}
        <RouteStepsList steps={order.routeSteps} />
        {order.operationPlanIsStale && (
          <p className="admin-muted" style={{ marginTop: 8, fontSize: '0.85rem' }}>
            <Layers size={12} strokeWidth={1.7} aria-hidden /> План операций
            устарел:{' '}
            {order.operationPlanStaleReason ??
              'после расчёта менялись операции, ставки или нормы времени.'}
          </p>
        )}
      </AdminCard>

      <AdminCard className="order-prod-tab__matrix-card">
        <AdminSectionHeader
          icon={<Activity size={18} strokeWidth={1.7} aria-hidden />}
          title="Производство по размерам"
          hint={
            shopfloor
              ? `Цех: срез ${formatTime(shopfloor.updatedAt)}`
              : 'План и отгрузка; цех — после запуска'
          }
          actions={matrixActions}
        />
        {shopfloorError && (
          <p className="order-prod-tab__shopfloor-warning">
            Не удалось получить срез цеха: {shopfloorError}. Колонки
            «В цеху сейчас» пусты, остальной срез показан.
          </p>
        )}
        {order.sizeBreakdown.length === 0 ? (
          <AdminEmptyState
            icon={<Activity size={26} strokeWidth={1.6} aria-hidden />}
            title="План по размерам не заполнен"
            hint="Добавьте строки в плане — затем заказ можно перевести в расчёт."
          />
        ) : (
          <ProductionMatrix
            rows={order.sizeBreakdown}
            shopBySize={shopBySize}
            shopfloorEligible={shopfloorEligible}
            readyToShipBySize={readyToShipBySize}
            shippedBySize={shippedBySize}
          />
        )}
      </AdminCard>

      <OrderAmendmentHistoryCard entries={amendmentHistory} />

      {/*
       * Блок «Отгрузка готовой продукции» (превью остатков + журнал
       * отгрузок) убран: созданные отгрузки теперь живут в отдельной
       * таблице «Отгрузка». Здесь осталась только кнопка «Создать
       * отгрузку» — она переехала в правый верхний угол карточки
       * «Производство по размерам» (см. `actions` выше).
       *
       * Блоки «Цвета по строкам техкарты» и «Очередь выдачи кроя по
       * размерам» переехали сюда из удалённой вкладки «План» (см.
       * `OrderMaterialColorsCard`, `OrderCutIssueRulesCard`). По
       * просьбе — в самом конце вкладки «Производство»: это
       * настроечные блоки, идут после основного производственного
       * среза.
       */}
      <OrderMaterialColorsCard order={order} />

      <OrderCutIssueRulesCard
        orderId={order.id}
        orderItems={order.items}
        initialSummary={cutIssueRulesSummary}
        canManage={canManage}
      />
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

interface ProductionMatrixProps {
  rows: OrderSizeBreakdownRow[];
  shopBySize: Map<string, ShopfloorRowDto>;
  /** До запуска в производство колонки «В цеху сейчас» = прочерк. */
  shopfloorEligible: boolean;
  readyToShipBySize: Map<string, number>;
  shippedBySize: Map<string, number>;
}

/**
 * Объединённая матрица «размер × этап» — единый источник истины
 * производственного среза заказа. Склеивает три проекции по `sizeId`:
 * план (`OrderSizeBreakdownRow`), живой цех (`ShopfloorRowDto`) и
 * хвост отгрузки (балансы ГП + Σ POSTED-отгрузок).
 *
 * Группа «В цеху сейчас» повторяет доску монитора: ▶ — в работе на
 * этапе сейчас (красным), ✔ — выполнено и ждёт следующий шаг (буфер,
 * зелёным). Бакет CUT = «раскроено, ждёт швею» → показываем как ✔
 * (готов к пошиву); SEWING/PACKING — только ▶ (промежуточного
 * «done»-бакета у них в проекции нет); QC/WTO — пара ▶/✔.
 */
function ProductionMatrix({
  rows,
  shopBySize,
  shopfloorEligible,
  readyToShipBySize,
  shippedBySize,
}: ProductionMatrixProps) {
  const sorted = [...rows].sort((a, b) => a.sizeSortOrder - b.sizeSortOrder);

  // Итоги по колонкам — собираем за один проход.
  const totals = {
    plan: 0,
    cut: 0,
    delta: 0,
    defect: 0,
    wCut: 0,
    wSew: 0,
    wQc: 0,
    wQcDone: 0,
    wWto: 0,
    wWtoDone: 0,
    wPack: 0,
    finished: 0,
    ready: 0,
    shipped: 0,
  };

  const body = sorted.map((r) => {
    const sf = shopBySize.get(r.sizeId);
    const ready = readyToShipBySize.get(r.sizeId) ?? 0;
    const shipped = shippedBySize.get(r.sizeId) ?? 0;

    totals.plan += r.qtyPlan;
    totals.cut += r.qtyCutFact;
    totals.delta += r.qtyDelta;
    totals.defect += r.qtyDefect;
    totals.finished += r.qtyFinished;
    totals.ready += ready;
    totals.shipped += shipped;
    if (sf) {
      totals.wCut += sf.qtyCut;
      totals.wSew += sf.qtySewing;
      totals.wQc += sf.qtyQc;
      totals.wQcDone += sf.qtyQcDone;
      totals.wWto += sf.qtyWto;
      totals.wWtoDone += sf.qtyWtoDone;
      totals.wPack += sf.qtyPacking;
    }

    return (
      <tr key={r.sizeId}>
        <th scope="row" className="order-prod-matrix__size">
          {r.sizeCode}
        </th>
        {/* План */}
        <td className="order-prod-matrix__num">{r.qtyPlan}</td>
        <td className="order-prod-matrix__num">{r.qtyCutFact}</td>
        <td className="order-prod-matrix__num">
          <DeltaValue value={r.qtyDelta} />
        </td>
        <td className="order-prod-matrix__num order-prod-matrix__group-end">
          <span style={{ color: r.qtyDefect > 0 ? '#b91c1c' : undefined }}>
            {r.qtyDefect}
          </span>
        </td>
        {/* В цеху сейчас (▶ в работе / ✔ готово к следующему шагу) */}
        <WipCell eligible={shopfloorEligible} done={sf?.qtyCut} />
        <WipCell eligible={shopfloorEligible} now={sf?.qtySewing} />
        <WipCell
          eligible={shopfloorEligible}
          now={sf?.qtyQc}
          done={sf?.qtyQcDone}
        />
        <WipCell
          eligible={shopfloorEligible}
          now={sf?.qtyWto}
          done={sf?.qtyWtoDone}
        />
        <WipCell
          eligible={shopfloorEligible}
          now={sf?.qtyPacking}
          groupEnd
        />
        {/* Отгрузка */}
        <td className="order-prod-matrix__num order-prod-matrix__finished">
          {r.qtyFinished}
        </td>
        <td className="order-prod-matrix__num order-prod-matrix__ready">
          {ready}
        </td>
        <td className="order-prod-matrix__num">{shipped}</td>
      </tr>
    );
  });

  return (
    <div className="order-prod-matrix__scroll">
      <table className="order-prod-matrix">
        <thead>
          <tr className="order-prod-matrix__group-row">
            <th rowSpan={2} className="order-prod-matrix__size">
              Размер
            </th>
            <th colSpan={4} className="order-prod-matrix__group">
              План
            </th>
            <th
              colSpan={5}
              className="order-prod-matrix__group order-prod-matrix__group--wip"
            >
              В цеху сейчас <span className="order-prod-matrix__legend">▶ в работе · ✔ готово</span>
            </th>
            <th
              colSpan={3}
              className="order-prod-matrix__group order-prod-matrix__group--ship"
            >
              Отгрузка
            </th>
          </tr>
          <tr className="order-prod-matrix__sub-row">
            <th>План</th>
            <th>Раскр.</th>
            <th>Δ</th>
            <th className="order-prod-matrix__group-end">Брак</th>
            <th>Крой</th>
            <th>Пошив</th>
            <th>ОТК</th>
            <th>ВТО</th>
            <th className="order-prod-matrix__group-end">Упак.</th>
            <th>Выпущено</th>
            <th>К отгр.</th>
            <th>Отгруж.</th>
          </tr>
        </thead>
        <tbody>{body}</tbody>
        <tfoot>
          <tr className="order-prod-matrix__totals">
            <th scope="row" className="order-prod-matrix__size">
              Итого
            </th>
            <td className="order-prod-matrix__num">{totals.plan}</td>
            <td className="order-prod-matrix__num">{totals.cut}</td>
            <td className="order-prod-matrix__num">
              <DeltaValue value={totals.delta} />
            </td>
            <td className="order-prod-matrix__num order-prod-matrix__group-end">
              {totals.defect}
            </td>
            <WipCell eligible={shopfloorEligible} done={totals.wCut} foot />
            <WipCell eligible={shopfloorEligible} now={totals.wSew} foot />
            <WipCell
              eligible={shopfloorEligible}
              now={totals.wQc}
              done={totals.wQcDone}
              foot
            />
            <WipCell
              eligible={shopfloorEligible}
              now={totals.wWto}
              done={totals.wWtoDone}
              foot
            />
            <WipCell
              eligible={shopfloorEligible}
              now={totals.wPack}
              groupEnd
              foot
            />
            <td className="order-prod-matrix__num order-prod-matrix__finished">
              {totals.finished}
            </td>
            <td className="order-prod-matrix__num order-prod-matrix__ready">
              {totals.ready}
            </td>
            <td className="order-prod-matrix__num">{totals.shipped}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function RouteStepsList({ steps }: { steps: OrderRouteStepDto[] }) {
  if (steps.length === 0) {
    return (
      <p className="admin-muted" style={{ marginTop: 8, fontSize: '0.85rem' }}>
        Маршрут не зафиксирован — заказ ещё не запущен либо запущен без
        шаблона.
      </p>
    );
  }
  const adminSteps = [...steps]
    .sort((a, b) => a.index - b.index)
    .map((s) => ({
      id: s.id,
      index: s.index + 1,
      name: s.operationName,
    }));
  return (
    <div style={{ marginTop: 8 }}>
      <AdminRouteSteps steps={adminSteps} dense />
    </div>
  );
}

function DeltaValue({ value }: { value: number }) {
  return (
    <span
      style={{
        color: value === 0 ? undefined : value > 0 ? '#1f7a1f' : '#b91c1c',
      }}
    >
      {value}
    </span>
  );
}

interface WipCellProps {
  eligible: boolean;
  /** ▶ — в работе на этапе сейчас (красным). */
  now?: number;
  /** ✔ — выполнено, ждёт следующий шаг (буфер, зелёным). */
  done?: number;
  /** Правая граница группы «В цеху сейчас». */
  groupEnd?: boolean;
  /** Строка итогов — приглушаем фон. */
  foot?: boolean;
}

/**
 * Ячейка этапа группы «В цеху сейчас». Повторяет доску монитора:
 * красная плашка «▶ N» (в работе) и/или зелёная «✔ N» (готово к
 * следующему шагу). До запуска в производство — прочерк; на этапе
 * без движения — приглушённая точка.
 */
function WipCell({ eligible, now, done, groupEnd, foot }: WipCellProps) {
  const cls = [
    'order-prod-matrix__num',
    'order-prod-matrix__wip',
    groupEnd ? 'order-prod-matrix__group-end' : '',
    foot ? 'order-prod-matrix__wip--foot' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (!eligible) {
    return (
      <td className={cls}>
        <span className="order-prod-matrix__wip-empty">—</span>
      </td>
    );
  }

  const n = now ?? 0;
  const d = done ?? 0;
  if (n === 0 && d === 0) {
    return (
      <td className={cls}>
        <span className="order-prod-matrix__wip-empty">·</span>
      </td>
    );
  }

  return (
    <td className={cls}>
      <span className="order-prod-matrix__wip-chips">
        {n > 0 && (
          <span className="order-prod-matrix__chip order-prod-matrix__chip--now">
            ▶ {n}
          </span>
        )}
        {d > 0 && (
          <span className="order-prod-matrix__chip order-prod-matrix__chip--done">
            ✔ {d}
          </span>
        )}
      </span>
    </td>
  );
}
