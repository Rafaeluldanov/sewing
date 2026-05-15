import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { PASSPORT_STATUS_LABELS } from '@/lib/passports-api';
import { getQcPassport, listDefectTypes } from '@/lib/qc-api';
import { DefectForm } from './defect-form';

export const dynamic = 'force-dynamic';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

export default async function QcPassportDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let passport;
  try {
    passport = await getQcPassport(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }
  const defectTypes = await listDefectTypes();

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            ОТК · Паспорт {passport.passportNumber}
            <span className={`status-badge ${passport.status.toLowerCase()}`}>
              {PASSPORT_STATUS_LABELS[passport.status]}
            </span>
          </h1>
          <div className="meta-line">
            Заказ{' '}
            <Link href={`/orders/${passport.orderId}`}>
              {passport.orderNumber}
            </Link>{' '}
            · Создан {formatDateTime(passport.createdAt)} · Обновлён{' '}
            {formatDateTime(passport.updatedAt)}
          </div>
        </div>
        <div className="actions-row" style={{ margin: 0 }}>
          <Link className="btn" href="/qc">
            ← К списку ОТК
          </Link>
          <Link className="btn" href={`/passports/${passport.passportId}`}>
            Открыть карточку паспорта
          </Link>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="meta-grid">
          <div>
            <div className="meta-line">Изделие</div>
            <strong>{passport.productName}</strong>
          </div>
          <div>
            <div className="meta-line">Цвет</div>
            <strong>{passport.color}</strong>
          </div>
          <div>
            <div className="meta-line">Размер</div>
            <strong>{passport.sizeCode}</strong>
          </div>
          <div>
            <div className="meta-line">Номер рулона</div>
            <strong>{passport.rollNumber}</strong>
          </div>
          <div>
            <div className="meta-line">Дата кроя</div>
            <strong>{formatDate(passport.cutDate)}</strong>
          </div>
          <div>
            <div className="meta-line">Текущая операция</div>
            <strong>{passport.currentOperationName ?? '—'}</strong>
          </div>
          <div>
            <div className="meta-line">Текущий сотрудник</div>
            <strong>{passport.currentEmployeeName ?? '—'}</strong>
          </div>
        </div>
      </div>

      <div
        className="card"
        style={{
          marginBottom: '1rem',
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '1rem',
        }}
      >
        <div>
          <div className="meta-line">Раскроено</div>
          <strong style={{ fontSize: '1.5rem' }}>{passport.qtyCut}</strong>
        </div>
        <div>
          <div className="meta-line">Брак</div>
          <strong style={{ fontSize: '1.5rem', color: 'var(--danger, #b91c1c)' }}>
            {passport.qtyDefect}
          </strong>
        </div>
        <div>
          <div className="meta-line">Годных</div>
          <strong style={{ fontSize: '1.5rem', color: 'var(--success, #15803d)' }}>
            {passport.qtyGood}
          </strong>
        </div>
      </div>

      <h2 style={{ margin: '1rem 0 0.5rem', fontSize: '1.15rem' }}>
        Зафиксировать брак
      </h2>
      {passport.canRecordDefect ? (
        <DefectForm
          passportId={passport.passportId}
          defectTypes={defectTypes}
          remaining={passport.remainingForDefect}
        />
      ) : (
        <div className="card empty">
          {passport.status !== 'IN_PROGRESS'
            ? 'Паспорт ещё не в работе или уже завершён — фиксировать брак нельзя.'
            : 'Все штуки этого паспорта уже отмечены как брак.'}
        </div>
      )}

      <h2 style={{ margin: '1.5rem 0 0.5rem', fontSize: '1.15rem' }}>
        История дефектов
      </h2>
      {passport.defects.length === 0 ? (
        <div className="card empty">По паспорту брак ещё не фиксировали.</div>
      ) : (
        <div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Вид</th>
                <th style={{ textAlign: 'right' }}>Кол-во</th>
                <th>Комментарий</th>
                <th>Кто</th>
              </tr>
            </thead>
            <tbody>
              {passport.defects.map((d) => (
                <tr key={d.id}>
                  <td>{formatDateTime(d.createdAt)}</td>
                  <td>
                    {d.defectTypeName}
                    <div className="meta-line">
                      <code>{d.defectTypeCode}</code>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <strong>{d.qty}</strong>
                  </td>
                  <td>{d.comment ?? '—'}</td>
                  <td>{d.createdByEmployeeName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
