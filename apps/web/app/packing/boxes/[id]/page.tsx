import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getBox, BOX_STATUS_LABELS } from '@/lib/packing-api';
import { getCurrentShift, getShiftMeta } from '@/lib/shifts-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { AddPassportForm } from './add-passport-form';
import { CloseBoxForm } from './close-box-form';

export const dynamic = 'force-dynamic';

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU');
}

export default async function BoxDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let box;
  try {
    box = await getBox(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  const me = await getCurrentUserOrNull();
  const meta = await getShiftMeta();
  const employee = me
    ? meta.employees.find((e) => e.id === me.user.id) ?? {
        id: me.user.id,
        login: me.user.login,
        fullName: me.user.fullName,
        role: me.user.role,
      }
    : null;
  let shift = null;
  if (employee) {
    try {
      shift = await getCurrentShift();
    } catch (e) {
      if (!(e instanceof ApiRequestError)) throw e;
    }
  }
  const shiftOperation = shift
    ? meta.operations.find((o) => o.id === shift.operationId)
    : null;
  // Как и в терминале, «можно работать с коробкой» решает признак
  // `Operation.boxPacking`, а не категория: в категории `PACKING` есть и
  // некоробочная «Распаковка» (приёмка сырья первым шагом маршрута).
  // По категории формы добавления/закрытия были бы активны и на её
  // смене, а серверный `PackingService.assertPackingActor` всё равно
  // вернул бы 409 `PACKING_SHIFT_REQUIRED` — уже после клика.
  const onPackingShift =
    !!shift && shift.active && (shiftOperation?.boxPacking ?? false);

  const isOpen = box.status === 'OPEN';

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            Коробка {box.number}
            <span
              className={`status-badge ${
                box.status === 'CLOSED' ? 'done' : 'in_production'
              }`}
            >
              {BOX_STATUS_LABELS[box.status]}
            </span>
          </h1>
          <div className="meta-line">
            Создана {formatDateTime(box.createdAt)} · Открыл{' '}
            <strong>{box.createdByName}</strong>
            {box.closedAt && (
              <> · Закрыта {formatDateTime(box.closedAt)}</>
            )}
          </div>
        </div>
        <div className="actions-row" style={{ margin: 0 }}>
          <Link className="btn" href="/packing">
            ← К списку
          </Link>
          <a
            className="btn"
            href={box.labelUrl}
            target="_blank"
            rel="noreferrer"
          >
            Этикетка
          </a>
        </div>
      </div>

      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-card__label">Упаковано</div>
          <div className="summary-card__value">
            {box.totalQty} <span className="meta-line">шт.</span>
          </div>
        </div>
        <div className="summary-card">
          <div className="summary-card__label">Паспортов</div>
          <div className="summary-card__value">{box.items.length}</div>
        </div>
        {box.summary && (
          <div className="summary-card">
            <div className="summary-card__label">Содержимое</div>
            <div className="summary-card__value" style={{ fontSize: '1rem' }}>
              {box.summary.productName}
              <div className="meta-line">
                {box.summary.color} · {box.summary.sizeCode}
              </div>
            </div>
          </div>
        )}
      </div>

      {isOpen ? (
        <>
          {!onPackingShift && (
            <div className="error-box">
              Чтобы добавлять паспорта и закрыть коробку, начните смену
              на операции категории «Упаковка» через{' '}
              <Link href="/work">/work</Link>.
            </div>
          )}

          <div className="card" style={{ marginBottom: '1rem' }}>
            <h2 style={{ margin: '0 0 0.5rem' }}>Добавить паспорт</h2>
            <p className="meta-line" style={{ margin: '0 0 0.75rem' }}>
              Отсканируйте QR паспорта или введите номер
              <code> P-…</code>. Однородность коробки
              (изделие/цвет/размер) проверяется автоматически.
            </p>
            <AddPassportForm
              boxId={box.id}
              disabled={!onPackingShift}
            />
          </div>

          <div className="card" style={{ marginBottom: '1rem' }}>
            <h2 style={{ margin: '0 0 0.5rem' }}>Закрыть коробку</h2>
            <p className="meta-line" style={{ margin: '0 0 0.75rem' }}>
              После закрытия добавлять паспорта в эту коробку нельзя.
              Сами паспорта уже выпущены при добавлении (статус
              «Упакован»). См. ADR-0011.
            </p>
            <CloseBoxForm
              boxId={box.id}
              disabled={!onPackingShift || box.items.length === 0}
            />
          </div>
        </>
      ) : (
        <div className="info-box" style={{ marginBottom: '1rem' }}>
          Коробка закрыта — изменения недоступны. Все паспорта уже
          выпущены.
        </div>
      )}

      <h2 style={{ margin: '1rem 0 0.5rem' }}>Содержимое</h2>
      {box.items.length === 0 ? (
        <div className="card empty">
          В коробке пока нет паспортов. Отсканируйте первый — это
          задаст изделие/цвет/размер для всей коробки.
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Паспорт</th>
              <th>Заказ</th>
              <th>Изделие · Цвет · Размер</th>
              <th className="num">Кол-во</th>
              <th>Добавлен</th>
            </tr>
          </thead>
          <tbody>
            {box.items.map((it) => (
              <tr key={it.id}>
                <td>
                  <Link href={`/passports/${it.passportId}`}>
                    <strong>{it.passportNumber}</strong>
                  </Link>
                </td>
                <td>
                  <Link href={`/orders/${it.orderId}`}>
                    {it.orderNumber}
                  </Link>
                </td>
                <td>
                  {it.productName}
                  <div className="meta-line">
                    {it.color} · {it.sizeCode}
                  </div>
                </td>
                <td className="num">
                  <strong>{it.qty}</strong>
                </td>
                <td>{formatDateTime(it.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
