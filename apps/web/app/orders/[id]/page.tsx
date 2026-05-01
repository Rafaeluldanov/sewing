import Link from 'next/link';
import { notFound } from 'next/navigation';
import type {
  OrderDetailDto,
  OrderMaterialRequirementDto,
  OrderOutsourceRequirementDto,
  OrderRouteStepDto,
  OrderSizeBreakdownRow,
  OrderSummary,
} from '@sewing/shared/orders';
import {
  TECH_CARD_MATERIAL_COLOR_RULE_LABELS,
  getTechCardMaterialRoleLabel,
} from '@sewing/shared/tech-cards';
import type { PassportListItemDto } from '@sewing/shared/passports';
import { ApiRequestError } from '@/lib/api';
import {
  ORDER_NOMENCLATURE_SOURCE_BADGE,
  resolveOrderNomenclature,
} from '@/lib/order-nomenclature';
import { getOrder } from '@/lib/orders-api';
import {
  PASSPORT_STATUS_LABELS,
  listOrderPassports,
} from '@/lib/passports-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listCuttingClosureRequests } from '@/lib/cutting-closure-api';
import { StatusBadge } from '@/components/status-badge';
import { PatternPreviewCard } from '@/components/orders/pattern-preview-card';
import { MaterialColorForm } from './material-color-form';
import { OrderActions } from './order-actions';
import { OutsourceStatusActions } from './outsource-status-actions';

export const dynamic = 'force-dynamic';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU');
}
function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

interface SummaryCard {
  label: string;
  value: number;
  kind?: 'delta';
}

function summaryCards(s: OrderSummary): SummaryCard[] {
  return [
    { label: 'План всего', value: s.qtyPlanTotal },
    { label: 'Раскроено', value: s.qtyCutFactTotal },
    { label: 'В пошиве', value: s.qtyInSewingTotal },
    { label: 'На ОТК', value: s.qtyQcTotal },
    { label: 'На ВТО', value: s.qtyWtoTotal },
    { label: 'На упаковке', value: s.qtyPackingTotal },
    { label: 'Выпущено', value: s.qtyFinishedTotal },
    { label: 'Брак', value: s.qtyDefectTotal },
    { label: 'Отклонение (крой − план)', value: s.qtyDeltaTotal, kind: 'delta' },
  ];
}

export default async function OrderDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let order;
  try {
    order = await getOrder(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  const passports = await listOrderPassports(params.id);
  const cards = summaryCards(order.summary);
  const canIssuePassport = order.status === 'IN_PRODUCTION';
  // Управляющие действия (запуск/завершение/отмена/редактирование)
  // доступны только менеджерским ролям; CUTTER_ASSISTANT попадает на
  // эту страницу read-only ради кнопки «Выпустить паспорт».
  const me = await getCurrentUserOrNull();
  const role = me?.user.role;
  const isManager = role === 'ADMIN' || role === 'SHOP_MANAGER';
  // ADR-0018: список заявок на закрытие раскроя по этому заказу
  // менеджер видит прямо в карточке. Помощник раскройщика и admin —
  // тоже (бэкенд их пускает). Прочие роли сюда не доходят (RBAC).
  const closureRequests =
    role === 'SHOP_MANAGER' || role === 'CUTTER_ASSISTANT' || role === 'ADMIN'
      ? await listCuttingClosureRequests({ orderId: order.id })
      : [];
  const pendingClosures = closureRequests.filter((r) => r.status === 'REQUESTED');
  const approvedClosures = closureRequests.filter((r) => r.status === 'APPROVED');
  // Единый resolver «номенклатура заказа» — тот же, что в admin-карточке
  // и в `PatternPreviewCard`, чтобы менеджер всегда видел одно и то же
  // название изделия в превью и в мета-блоке (см.
  // `apps/web/lib/order-nomenclature.ts`). Раньше тут шёл `productName`,
  // и после переименования `PatternItem` мета-блок «Изделие» расходился
  // с PatternPreviewCard прямо рядом.
  const nomenclature = resolveOrderNomenclature(order);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            Заказ {order.number}
            <StatusBadge status={order.status} />
          </h1>
          <div className="meta-line">
            Создан {formatDateTime(order.createdAt)} · Обновлён{' '}
            {formatDateTime(order.updatedAt)}
          </div>
        </div>
        <div className="actions-row" style={{ margin: 0 }}>
          <Link className="btn" href="/orders">
            ← К списку
          </Link>
        </div>
      </div>

      {/*
        Soft-pattern MVP (этап 2 «Лекала»): мета-карточка слева,
        превью лекала справа. На широких экранах flex рисует две
        колонки; на узких — превью лекала уезжает под мета-карточку
        (`flex-wrap: wrap`). Сетку держим инлайном, чтобы не плодить
        новые CSS-классы под одну страницу.
      */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
          marginBottom: '1rem',
          alignItems: 'flex-start',
        }}
      >
        <div className="card" style={{ flex: '1 1 320px', margin: 0 }}>
          <div className="meta-grid">
            <div>
              <div className="meta-line">Дата заказа</div>
              <strong>{formatDate(order.orderDate)}</strong>
            </div>
            <div>
              <div className="meta-line">Номенклатура</div>
              <strong>{nomenclature.name ?? '—'}</strong>
              {nomenclature.source === 'legacyProduct' && (
                <span
                  style={{
                    display: 'inline-block',
                    marginLeft: '0.4rem',
                    padding: '1px 6px',
                    borderRadius: 999,
                    background: 'rgba(148, 163, 184, 0.18)',
                    color: 'rgba(0,0,0,0.55)',
                    fontSize: '0.7rem',
                    verticalAlign: 'middle',
                  }}
                  title="Историческое изделие без карточки лекала"
                >
                  {ORDER_NOMENCLATURE_SOURCE_BADGE.legacyProduct}
                </span>
              )}
            </div>
            <div>
              <div className="meta-line">Цвет</div>
              <strong>{order.color ?? '—'}</strong>
            </div>
            <div>
              <div className="meta-line">Срок (due)</div>
              <strong>{formatDate(order.dueDate)}</strong>
            </div>
          </div>
          {order.comment && (
            <>
              <div className="meta-line" style={{ marginTop: '0.5rem' }}>
                Комментарий
              </div>
              <div>{order.comment}</div>
            </>
          )}
        </div>
        <div style={{ flex: '0 1 320px', minWidth: 260 }}>
          <PatternPreviewCard order={order} variant="legacy" />
        </div>
      </div>

      <RouteSnapshotCard steps={order.routeSteps} />
      <MaterialsSnapshotCard
        orderId={order.id}
        items={order.materialRequirements}
        canManage={isManager}
        orderStatus={order.status}
      />
      <OutsourceSnapshotCard
        orderId={order.id}
        items={order.outsourceRequirements}
        canManage={isManager}
      />

      {isManager && <OrderActions id={order.id} status={order.status} />}

      <h2 style={{ margin: '1rem 0 0.5rem', fontSize: '1.15rem' }}>Сводка</h2>
      <div className="summary-grid">
        {cards.map((c) => (
          <div
            key={c.label}
            className={`summary-card ${c.kind === 'delta' ? 'delta' : ''}`}
          >
            <div className="summary-card__label">{c.label}</div>
            <div
              className={
                'summary-card__value' +
                (c.kind === 'delta'
                  ? c.value > 0
                    ? ' positive'
                    : c.value < 0
                    ? ' negative'
                    : ''
                  : '')
              }
            >
              {c.value}
            </div>
          </div>
        ))}
      </div>

      <h2 style={{ margin: '1.25rem 0 0.5rem', fontSize: '1.15rem' }}>
        По размерам
      </h2>
      {order.sizeBreakdown.length === 0 ? (
        <div className="card empty">В заказе нет строк.</div>
      ) : (
        <BreakdownTable rows={order.sizeBreakdown} />
      )}

      <p className="meta-line" style={{ marginTop: '0.75rem' }}>
        На Шаге 5 заполнен факт раскроя — он считается из паспортов
        (см. блок ниже). Поля «В пошиве / ОТК / ВТО / Упаковка / Выпущено
        / Брак» подключатся на Шагах 6–8 без изменения API-контракта.
      </p>

      {(pendingClosures.length > 0 || approvedClosures.length > 0) && (
        <ClosureRequestsBanner
          pending={pendingClosures}
          approved={approvedClosures}
          orderPassports={passports}
        />
      )}

      <div
        className="page-header"
        style={{ marginTop: '1.5rem', marginBottom: '0.5rem' }}
      >
        <h2 style={{ margin: 0, fontSize: '1.15rem' }}>
          Паспорта изделия ({passports.length})
        </h2>
        <div className="actions-row" style={{ margin: 0 }}>
          {canIssuePassport ? (
            <Link
              className="btn btn-primary"
              href={`/orders/${order.id}/passports/new`}
            >
              Выпустить паспорт
            </Link>
          ) : (
            <span className="meta-line">
              Выпуск паспорта доступен только для заказа в статусе
              «В производстве».
            </span>
          )}
        </div>
      </div>
      {passports.length === 0 ? (
        <div className="card empty">По заказу пока нет выпущенных паспортов.</div>
      ) : (
        <PassportsTable rows={passports} />
      )}
    </div>
  );
}

function ClosureRequestsBanner({
  pending,
  approved,
  orderPassports,
}: {
  pending: import('@sewing/shared/cutting-closure').CuttingClosureRequestDto[];
  approved: import('@sewing/shared/cutting-closure').CuttingClosureRequestDto[];
  orderPassports: PassportListItemDto[];
}) {
  // Чтобы дать менеджеру быструю ссылку «открыть паспорт и решить»,
  // ищем первый паспорт нужного размера. Если по строке ещё нет
  // паспорта (теоретически возможно, если кроили мало), просто
  // показываем размер без ссылки.
  function passportLinkFor(sizeId: string): string | null {
    const p = orderPassports.find((x) => x.sizeId === sizeId);
    return p ? `/passports/${p.id}` : null;
  }
  return (
    <div className="card" style={{ marginTop: '1.25rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem' }}>
        Закрытие раскроя по размерам
      </h2>
      {pending.length > 0 && (
        <>
          <div className="meta-line" style={{ marginBottom: '0.4rem' }}>
            Заявки в работе ({pending.length}):
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {pending.map((r) => {
              const href = passportLinkFor(r.sizeId);
              return (
                <li key={r.id}>
                  Размер <strong>{r.sizeCode}</strong> · план{' '}
                  {r.planFact.qtyPlan} · выпущено {r.planFact.qtyCut} ·
                  остаток {r.planFact.qtyRemaining}
                  {r.reason ? <> · «{r.reason}»</> : null}
                  {' '}—{' '}
                  {href ? (
                    <Link href={href}>открыть паспорт →</Link>
                  ) : (
                    <span className="meta-line">паспорт не выпущен</span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {approved.length > 0 && (
        <>
          <div
            className="meta-line"
            style={{ marginTop: '0.5rem', marginBottom: '0.4rem' }}
          >
            Раскрой закрыт ({approved.length}):
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {approved.map((r) => (
              <li key={r.id}>
                Размер <strong>{r.sizeCode}</strong> · план {r.planFact.qtyPlan} ·
                выпущено {r.planFact.qtyCut} · остаток {r.planFact.qtyRemaining}
                {r.reviewerNote ? <> · комментарий: «{r.reviewerNote}»</> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Tech card MVP (ADR-0022): read-only snapshot строк материалов на
 * заказе. Источник истины — `OrderMaterialRequirement` (его создаёт
 * `OrdersService.start()`). Здесь UI НЕ догружает live-строки шаблона —
 * это позволило бы поздним правкам техкарты «протекать» в карточку
 * запущенного заказа.
 *
 * Этап 3 «Потребности цеха» (см. `docs/recon-soft-integration.md
 * §«Этап 3»`): к строке добавлены опциональные snapshot-поля
 * `materialRole` / `fabricType` / `densityGsm` / `plannedWidthCm` /
 * `colorRule` / `fixedColorText` / `resolvedColorText`. Все nullable,
 * у старых snapshot-строк (созданных до этапа 3) → пусто. Здесь UI
 * показывает их одной компактной строкой «meta», ничего не считает —
 * формула «Потребности цеха» появится позже.
 */
function MaterialsSnapshotCard({
  orderId,
  items,
  canManage,
  orderStatus,
}: {
  orderId: string;
  items: OrderMaterialRequirementDto[];
  canManage: boolean;
  orderStatus: OrderDetailDto['status'];
}) {
  // Этап «Указать в заказе» (см. ТЗ §7): поле «Цвет» доступно для
  // редактирования только до запуска производства, чтобы не
  // расходиться с зафиксированным в работу snapshot-ом. Остальные
  // статусы — read-only (показываем выбранный цвет / подсказку
  // без формы).
  const isColorEditable =
    canManage &&
    (orderStatus === 'DRAFT' ||
      orderStatus === 'CALCULATION' ||
      orderStatus === 'CALCULATION_DONE');
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem' }}>Материалы</h2>
      {items.length === 0 ? (
        <div className="meta-line">
          Материалы для заказа не зафиксированы
        </div>
      ) : (
        <ol style={{ margin: 0, paddingLeft: '1.25rem' }}>
          {items.map((m) => {
            // Этап 3: собираем «параметры для потребности» в одну
            // строку, чтобы не раздувать карточку. Показываем только
            // непустые сегменты — для старых snapshot-строк блок
            // полностью отсутствует. Для роли используем
            // `getTechCardMaterialRoleLabel` (он же знает «Фурнитура»
            // для PACKAGING; см. ТЗ §1).
            const needsParts: string[] = [];
            if (m.materialRole) {
              needsParts.push(
                `Роль: ${getTechCardMaterialRoleLabel(m.materialRole)}`,
              );
            }
            if (m.fabricType) {
              needsParts.push(`Полотно: ${m.fabricType}`);
            }
            if (m.densityGsm != null) {
              needsParts.push(`Плотность: ${m.densityGsm} г/м²`);
            }
            if (m.plannedWidthCm != null) {
              needsParts.push(`Ширина: ${m.plannedWidthCm} см`);
            }
            // Этап «Фурнитура»: показываем размер/материал, если
            // заполнено (свойственно PACKAGING).
            if (m.hardwareSizeText) {
              needsParts.push(`Размер: ${m.hardwareSizeText}`);
            }
            if (m.hardwareMaterialText) {
              needsParts.push(`Материал: ${m.hardwareMaterialText}`);
            }
            // «Цвет» показываем приоритетно: snapshot-цвет
            // `resolvedColorText` (если посчитан), иначе сырое
            // правило. Для `ORDER_SELECTED_COLOR` пока цвет не
            // выбран — показываем подсказку через MaterialColorForm
            // ниже, в этой строке метка не дублируется.
            if (m.resolvedColorText) {
              needsParts.push(`Цвет: ${m.resolvedColorText}`);
            } else if (
              m.colorRule &&
              m.colorRule !== 'ORDER_SELECTED_COLOR'
            ) {
              const ruleLabel =
                TECH_CARD_MATERIAL_COLOR_RULE_LABELS[m.colorRule];
              needsParts.push(`Цвет: ${ruleLabel}`);
            }
            const requiresColor = m.requiresColorSelection === true;
            return (
              <li key={m.id}>
                <strong>{m.name}</strong>{' '}
                <span className="meta-line">
                  — {m.totalQty} {m.unit}
                </span>
                <div className="meta-line">
                  Норма: {m.qtyPerUnit} {m.unit} / 1 шт
                  {m.note ? <> · {m.note}</> : null}
                </div>
                {needsParts.length > 0 && (
                  <div className="meta-line">{needsParts.join(' · ')}</div>
                )}
                {/*
                  Этап «Изображение материала» (см. ТЗ §5): мини-превью
                  по `materialImageUrl`. Для строк без URL ничего не
                  отрисовываем — UI остаётся компактным.
                */}
                {m.materialImageUrl && (
                  <div className="meta-line" style={{ marginTop: 4 }}>
                    <a
                      href={m.materialImageUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={m.materialImageUrl}
                        alt={
                          m.materialImageOriginalFileName ??
                          'Изображение материала'
                        }
                        style={{
                          maxHeight: 48,
                          maxWidth: 64,
                          objectFit: 'contain',
                          border: '1px solid #e5e7eb',
                          borderRadius: 4,
                        }}
                      />
                    </a>
                  </div>
                )}
                {/*
                  Этап «Указать в заказе» (см. ТЗ §4, §7): если по строке
                  требуется выбрать цвет, показываем inline-форму с
                  подсказкой «Цвет нужно указать в заказе» и сохранением
                  через action. Форма видна только менеджерам и только
                  до запуска производства (DRAFT/CALCULATION/
                  CALCULATION_DONE). На IN_PRODUCTION/DONE/CANCELLED
                  показываем read-only метку — snapshot заморожен.
                */}
                {requiresColor && isColorEditable && (
                  <MaterialColorForm
                    orderId={orderId}
                    requirementId={m.id}
                    initialValue={m.selectedColorText ?? null}
                  />
                )}
                {requiresColor && !isColorEditable && (
                  <div
                    className="meta-line"
                    style={{ marginTop: 4, fontStyle: 'italic' }}
                  >
                    {m.selectedColorText
                      ? `Цвет: ${m.selectedColorText}`
                      : 'Цвет нужно указать в заказе'}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * Tech card MVP (ADR-0022): snapshot строк внешних подрядных
 * размещений (OUTSOURCED_SERVICE) на заказе. Источник истины —
 * `OrderOutsourceRequirement`. Семантика данных та же, что у
 * `MaterialsSnapshotCard`.
 *
 * MVP-2 (ADR-0022 §«Cut-ready readiness»): для строк с
 * `triggerType === 'CUT_READY'` показываем индикатор готовности
 * (`isReadyToOrder` / `readinessLabel`), вычисленный backend-ом по
 * правилу ALL_PASSPORTS.
 *
 * MVP-3 (ADR-0022 §«Manual execution status»): к строке добавлена
 * композитная подпись `displayStatusLabel` и две action-кнопки
 * («Отметить как заказано», «Отметить как получено»). Кнопки
 * показываются только менеджерским ролям (`canManage = true`) и
 * только когда соответствующий переход допустим. Никаких dropdown/
 * select-ов и inline-edit полей в этом блоке намеренно нет —
 * операционная карточка, не ERP.
 */
function OutsourceSnapshotCard({
  orderId,
  items,
  canManage,
}: {
  orderId: string;
  items: OrderOutsourceRequirementDto[];
  canManage: boolean;
}) {
  // MVP-2: общая «шапка-заметка» над блоком, если в заказе есть хотя
  // бы одна строка CUT_READY и крой ещё не готов. Показываем только
  // когда это действительно даёт менеджеру контекст; в остальных
  // случаях ничего не дорисовываем.
  const hasCutReadyAwaiting = items.some(
    (o) => o.triggerType === 'CUT_READY' && !o.isReadyToOrder,
  );
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem' }}>
        Внешние потребности
      </h2>
      {hasCutReadyAwaiting && (
        <div className="meta-line" style={{ marginBottom: '0.4rem' }}>
          Часть внешних потребностей станет доступна после размещения
          кроя в ячейки.
        </div>
      )}
      {items.length === 0 ? (
        <div className="meta-line">
          Внешние потребности для заказа не зафиксированы
        </div>
      ) : (
        <ol style={{ margin: 0, paddingLeft: '1.25rem' }}>
          {items.map((o) => {
            const showTotal = o.totalQty != null && o.unit != null;
            const showNorm = o.qtyPerUnit != null && o.unit != null;
            // MVP-3: цветовой акцент подписи статуса.
            //   - RECEIVED — нейтральный «успех» (зелёный)
            //   - ORDERED — янтарный (внимание: ждём подрядчика)
            //   - READY_TO_ORDER — зелёный (как у readinessLabel)
            //   - PLANNED + CUT_READY — янтарный (Ожидает размещения)
            //   - PLANNED + MANUAL — без подписи (label = null)
            const statusColor =
              o.displayStatus === 'RECEIVED'
                ? '#1f7a1f'
                : o.displayStatus === 'READY_TO_ORDER'
                ? '#1f7a1f'
                : o.displayStatus === 'ORDERED'
                ? '#9c6a00'
                : '#9c6a00';
            const orderedMeta =
              o.displayStatus === 'ORDERED' && o.orderedAt
                ? `Отмечено: ${formatDateTime(o.orderedAt)}`
                : null;
            const receivedMeta =
              o.displayStatus === 'RECEIVED' && o.receivedAt
                ? `Получено: ${formatDateTime(o.receivedAt)}`
                : null;
            return (
              <li key={o.id}>
                <strong>{o.name}</strong>
                {showTotal ? (
                  <span className="meta-line">
                    {' '}
                    — {o.totalQty} {o.unit}
                  </span>
                ) : null}
                {o.vendorName ? (
                  <div className="meta-line">Подрядчик: {o.vendorName}</div>
                ) : null}
                {showNorm ? (
                  <div className="meta-line">
                    Норма: {o.qtyPerUnit} {o.unit} / 1 шт
                  </div>
                ) : null}
                {o.note ? <div className="meta-line">{o.note}</div> : null}
                {o.displayStatusLabel ? (
                  <div
                    className="meta-line"
                    style={{
                      marginTop: '0.2rem',
                      color: statusColor,
                      fontWeight: 600,
                    }}
                  >
                    {o.displayStatusLabel}
                  </div>
                ) : null}
                {orderedMeta ? (
                  <div className="meta-line">{orderedMeta}</div>
                ) : null}
                {receivedMeta ? (
                  <div className="meta-line">{receivedMeta}</div>
                ) : null}
                {canManage ? (
                  <OutsourceStatusActions
                    orderId={orderId}
                    requirementId={o.id}
                    displayStatus={o.displayStatus}
                    triggerType={o.triggerType}
                    isReadyToOrder={o.isReadyToOrder}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function RouteSnapshotCard({ steps }: { steps: OrderRouteStepDto[] }) {
  // Snapshot маршрута на заказе (источник истины — `OrderRouteStep`).
  // Read-only представление: никакого редактирования, drag/drop или
  // прогресса паспортов — только зафиксированный план шагов.
  // Шаги уже отсортированы бэкендом по `index ASC`.
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem' }}>
        Маршрут производства
      </h2>
      {steps.length === 0 ? (
        <div className="meta-line">Маршрут для заказа не зафиксирован</div>
      ) : (
        <ol style={{ margin: 0, paddingLeft: '1.25rem' }}>
          {steps.map((s) => (
            <li key={s.id}>
              {s.operationName}{' '}
              <span className="meta-line">({s.operationCode})</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function PassportsTable({ rows }: { rows: PassportListItemDto[] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Номер</th>
          <th>Дата кроя</th>
          <th>Размер</th>
          <th className="num">Кол-во</th>
          <th>Рулон</th>
          <th>Статус</th>
          <th>Ячейка</th>
          <th>Создан</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.id}>
            <td>
              <Link href={`/passports/${p.id}`}>
                <strong>{p.number}</strong>
              </Link>
            </td>
            <td>{new Date(p.cutDate).toLocaleDateString('ru-RU')}</td>
            <td>
              <strong>{p.sizeCode}</strong>
            </td>
            <td className="num">{p.qtyCut}</td>
            <td>{p.rollNumber}</td>
            <td>
              <span className={`status-badge ${p.status.toLowerCase()}`}>
                {PASSPORT_STATUS_LABELS[p.status]}
              </span>
            </td>
            <td>{p.currentCell ? p.currentCell.code : '—'}</td>
            <td>{new Date(p.createdAt).toLocaleDateString('ru-RU')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BreakdownTable({ rows }: { rows: OrderSizeBreakdownRow[] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Размер</th>
          <th className="num">План</th>
          <th className="num">Раскроено</th>
          <th className="num">В пошиве</th>
          <th className="num">ОТК</th>
          <th className="num">ВТО</th>
          <th className="num">Упаковка</th>
          <th className="num">Выпущено</th>
          <th className="num">Брак</th>
          <th className="num">Остаток</th>
          <th className="num">Δ</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.sizeId}>
            <td>
              <strong>{r.sizeCode}</strong>
            </td>
            <td className="num">{r.qtyPlan}</td>
            <td className="num">{r.qtyCutFact}</td>
            <td className="num">{r.qtyInSewing}</td>
            <td className="num">{r.qtyQc}</td>
            <td className="num">{r.qtyWto}</td>
            <td className="num">{r.qtyPacking}</td>
            <td className="num">{r.qtyFinished}</td>
            <td className="num">{r.qtyDefect}</td>
            <td className="num">{r.qtyRemaining}</td>
            <td className="num">{r.qtyDelta}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
