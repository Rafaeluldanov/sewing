import Link from 'next/link';
import { ApiRequestError } from '@/lib/api';
import { getAdminOverview } from '@/lib/admin-api';
import type { AdminOverviewDto } from '@sewing/shared/admin';

export const dynamic = 'force-dynamic';

/**
 * Operational overview page (Шаг 12 / Pilot Rollout).
 *
 * Простая read-only страница для начальника цеха: какие смены сейчас
 * активны, какие коробки открыты, какие паспорта в работе, плюс
 * счётчики «движения» системы. Без поллинга и без графиков — кнопка
 * «Обновить» просто перезагружает страницу.
 *
 * Контракт API — `docs/api.md §11a`. UI — `docs/screens.md §10`.
 */
export default async function AdminOverviewPage() {
  let overview: AdminOverviewDto | null = null;
  let error: string | null = null;
  try {
    overview = await getAdminOverview();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить операционный обзор';
  }

  if (!overview) {
    return (
      <div className="admin-overview">
        <header className="admin-overview__header">
          <h1>Операционный обзор</h1>
        </header>
        {error && <div className="error-box">{error}</div>}
      </div>
    );
  }

  const c = overview.counters;
  const updatedAtLabel = new Date(overview.updatedAt).toLocaleString('ru-RU');

  return (
    <div className="admin-overview">
      <header className="admin-overview__header">
        <div>
          <h1>Операционный обзор</h1>
          <div className="meta-line">Обновлено: {updatedAtLabel}</div>
        </div>
        <form action="">
          <button type="submit" className="btn">↻ Обновить</button>
        </form>
      </header>

      <section className="admin-overview__counters">
        <Counter label="Активные смены" value={c.activeShifts} />
        <Counter label="Открытые коробки" value={c.openBoxes} />
        <Counter label="Паспорта в работе" value={c.passportsInProgress} />
        <Counter label="В ячейках" value={c.passportsInCells} />
        <Counter label="Создано сегодня" value={c.passportsCreatedToday} />
        <Counter label="Событий за 24ч" value={c.eventsLast24h} />
      </section>

      <section>
        <h2>Активные смены</h2>
        {overview.shifts.length === 0 ? (
          <div className="empty-hint">Нет активных смен.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>С</th>
                <th>Сотрудник</th>
                <th>Операция</th>
                <th>Оборудование</th>
              </tr>
            </thead>
            <tbody>
              {overview.shifts.map((s) => (
                <tr key={s.shiftId}>
                  <td>{new Date(s.startedAt).toLocaleTimeString('ru-RU')}</td>
                  <td>
                    {s.employeeName} <span className="meta-line">({s.employeeRole})</span>
                  </td>
                  <td>
                    {s.operationName} <span className="meta-line">{s.operationCode}</span>
                  </td>
                  <td>
                    {s.equipmentName} <span className="meta-line">{s.equipmentCode}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Открытые коробки</h2>
        {overview.openBoxes.length === 0 ? (
          <div className="empty-hint">Открытых коробок нет.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Коробка</th>
                <th>Заполнение</th>
                <th>Партия</th>
                <th>Создана</th>
              </tr>
            </thead>
            <tbody>
              {overview.openBoxes.map((b) => (
                <tr key={b.boxId}>
                  <td>
                    <Link href={`/packing/boxes/${b.boxId}`}>{b.number}</Link>
                  </td>
                  <td>
                    {b.totalQty} / {b.maxQty}{' '}
                    <span className="meta-line">({b.itemsCount} паспортов)</span>
                  </td>
                  <td>
                    {b.productName ? (
                      <>
                        {b.productName} · {b.color} · {b.sizeCode}
                      </>
                    ) : (
                      <span className="meta-line">—</span>
                    )}
                  </td>
                  <td>{new Date(b.createdAt).toLocaleString('ru-RU')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Паспорта в работе и в ячейках</h2>
        {overview.passports.length === 0 ? (
          <div className="empty-hint">Сейчас в цехе нет живых паспортов.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Паспорт</th>
                <th>Изделие</th>
                <th>Размер</th>
                <th>Кол-во</th>
                <th>Где</th>
                <th>Операция</th>
              </tr>
            </thead>
            <tbody>
              {overview.passports.map((p) => (
                <tr key={p.passportId}>
                  <td>
                    <Link href={`/passports/${p.passportId}`}>{p.number}</Link>{' '}
                    <span className={`status-badge ${p.status.toLowerCase()}`}>
                      {p.status === 'IN_PROGRESS' ? 'В работе' : 'Создан'}
                    </span>
                  </td>
                  <td>
                    {p.productName} · {p.color}
                  </td>
                  <td>{p.sizeCode}</td>
                  <td>
                    {p.qtyCut}{' '}
                    {p.qtyGood !== p.qtyCut && (
                      <span className="meta-line">(годных {p.qtyGood})</span>
                    )}
                  </td>
                  <td>
                    {p.location === 'EMPLOYEE' && p.currentEmployeeName}
                    {p.location === 'CELL' && (
                      <>ячейка {p.currentCellCode}</>
                    )}
                    {p.location === 'UNASSIGNED' && (
                      <span className="meta-line">—</span>
                    )}
                  </td>
                  <td>
                    {p.currentOperationName ? (
                      <>
                        {p.currentOperationName}{' '}
                        <span className="meta-line">{p.currentOperationCode}</span>
                      </>
                    ) : (
                      <span className="meta-line">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="admin-overview__counter">
      <div className="admin-overview__counter-value">{value}</div>
      <div className="admin-overview__counter-label">{label}</div>
    </div>
  );
}
