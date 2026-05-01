import Link from 'next/link';
import { ApiRequestError } from '@/lib/api';
import { listPrinters } from '@/lib/printers-api';
import { listEquipment } from '@/lib/equipment-api';
import type { PrinterSummaryDto } from '@sewing/shared/printers';
import type { EquipmentSummaryDto } from '@sewing/shared/equipment';
import { Icon } from '@/components/icon';
import { CreatePrinterForm } from './create-form';

export const dynamic = 'force-dynamic';

/**
 * Список принтеров (см. `docs/screens.md §18`).
 *
 * Показываем имя, привязанное рабочее место, тип, статус online/offline
 * (derived из `lastSeenAt`), сколько pending job-ов в очереди.
 * Создание нового принтера — встроенная форма сверху, чтобы менеджер
 * не уходил со страницы и сразу видел свежесозданный принтер в списке.
 */
export default async function AdminPrintersPage() {
  let items: PrinterSummaryDto[] = [];
  let equipment: EquipmentSummaryDto[] = [];
  let error: string | null = null;
  try {
    [items, equipment] = await Promise.all([listPrinters(), listEquipment()]);
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить список принтеров';
  }

  return (
    <div className="admin-overview page-shell">
      <header className="admin-overview__header">
        <div>
          <div className="page-eyebrow">
            <Icon name="equipment" />
            Печать рабочих мест
          </div>
          <h1 className="page-title">
            <Icon name="equipment" />
            Принтеры
          </h1>
          <p className="page-subtitle">
            Один принтер на рабочее место. Агент рядом с принтером ловит
            задания и печатает автоматически — сотрудник просто жмёт «Печать».
          </p>
        </div>
      </header>

      {error && <div className="error-box">{error}</div>}

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="orders" />
            Новый принтер
          </h2>
        </div>
        <p className="detail-form__hint">
          Введите имя (например, «Принтер ОТК-1») и привяжите к рабочему
          месту. После создания нажмите «Сгенерировать код» в карточке
          принтера и передайте код оператору, который запустит агент.
        </p>
        <CreatePrinterForm equipment={equipment} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="equipment" />
            Список
          </h2>
          <span className="section-header__hint">
            Всего: {items.length}
          </span>
        </div>

        {items.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state__icon">
              <Icon name="equipment" />
            </span>
            <span className="empty-state__title">Принтеров ещё нет</span>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Имя</th>
                <th>Тип</th>
                <th>Рабочее место</th>
                <th>Статус</th>
                <th>В очереди</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/admin/printers/${p.id}`}>
                      <strong>{p.name}</strong>
                    </Link>
                    {!p.isActive && (
                      <span className="meta-line"> · деактивирован</span>
                    )}
                  </td>
                  <td>{p.type}</td>
                  <td>
                    {p.equipmentId ? (
                      <Link href={`/admin/equipment/${p.equipmentId}`}>
                        {p.equipmentName ?? '—'}{' '}
                        <span className="meta-line">
                          <code>{p.equipmentCode ?? ''}</code>
                        </span>
                      </Link>
                    ) : (
                      <span className="meta-line">не привязан</span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        p.isOnline ? 'pill--ok' : 'pill--ghost'
                      }`}
                    >
                      <Icon
                        name={p.isOnline ? 'success' : 'idle'}
                        size={14}
                      />
                      {p.isOnline ? 'онлайн' : 'офлайн'}
                    </span>
                    {p.lastSeenAt && (
                      <span
                        className="meta-line"
                        style={{ marginLeft: '0.5rem' }}
                        title={p.lastSeenAt}
                      >
                        {new Date(p.lastSeenAt).toLocaleString('ru-RU')}
                      </span>
                    )}
                  </td>
                  <td>
                    {p.pendingJobsCount === 0 ? (
                      <span className="meta-line">—</span>
                    ) : (
                      <strong>{p.pendingJobsCount}</strong>
                    )}
                  </td>
                  <td>
                    <Link href={`/admin/printers/${p.id}`}>
                      Открыть <Icon name="arrow-right" size={13} />
                    </Link>
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
