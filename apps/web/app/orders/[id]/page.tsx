import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { OrderSizeBreakdownRow, OrderSummary } from '@sewing/shared/orders';
import type { PassportListItemDto } from '@sewing/shared/passports';
import { ApiRequestError } from '@/lib/api';
import { getOrder } from '@/lib/orders-api';
import {
  PASSPORT_STATUS_LABELS,
  listOrderPassports,
} from '@/lib/passports-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listCuttingClosureRequests } from '@/lib/cutting-closure-api';
import { StatusBadge } from '@/components/status-badge';
import { OrderActions } from './order-actions';

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

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="meta-grid">
          <div>
            <div className="meta-line">Дата заказа</div>
            <strong>{formatDate(order.orderDate)}</strong>
          </div>
          <div>
            <div className="meta-line">Изделие</div>
            <strong>{order.productName ?? '—'}</strong>
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
