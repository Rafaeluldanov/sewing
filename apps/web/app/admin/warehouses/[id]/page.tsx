import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { listCells } from '@/lib/passports-api';
import { listPrinters } from '@/lib/printers-api';
import { getWarehouse } from '@/lib/warehouses-api';
import type { CellDetailDto } from '@sewing/shared/passports';
import type { PrinterSummaryDto } from '@sewing/shared/printers';
import { Icon } from '@/components/icon';
import { DetailPageHeader } from '@/components/detail-page-header';
import { WarehouseBulkPrintPanel } from './bulk-print-panel';
import {
  AssignCellForm,
  CreateLineForm,
  DetachCellButton,
  WarehouseEditForm,
} from './edit-form';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

/**
 * Карточка склада (см. `docs/screens.md §10b`).
 *
 * Показывает:
 *   - редактирование name/code/isActive;
 *   - список ячеек, привязанных к складу, с кнопкой «Печать QR»;
 *   - форму привязки новой ячейки (select из доступных).
 *
 * Доступ — `app/admin/layout.tsx` режет всех, кроме `ADMIN`/`SHOP_MANAGER`.
 * Backend независимо защищает `/api/warehouses/*` и `PATCH /api/cells/:id`
 * через `@Roles('SHOP_MANAGER', 'ADMIN')`.
 */
export default async function AdminWarehouseDetailPage({ params }: Params) {
  let warehouse;
  try {
    warehouse = await getWarehouse(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  // Все ячейки нужны для select «Привязать ячейку»: показываем
  // активные ячейки, которые ещё не привязаны к этому складу. Ячейки
  // с другим warehouseId менеджер может явно перепривязать — отметим
  // это в UI, но не блокируем (см. ADR-0019).
  let allCells: CellDetailDto[] = [];
  try {
    allCells = await listCells();
  } catch {
    allCells = [];
  }
  const attachedIds = new Set(warehouse.cells.map((c) => c.id));
  const availableCells = allCells.filter((c) => !attachedIds.has(c.id));

  // Принтеры нужны для модалки «Печать всех ячеек» (см. §10b screens.md).
  // На MVP берём весь список — менеджер сам выбирает в dropdown-е.
  // Если backend упал — открываем страницу всё равно: модалка
  // покажет «нет активных принтеров» и попросит зайти в /admin/printers.
  let printers: PrinterSummaryDto[] = [];
  try {
    printers = await listPrinters();
  } catch {
    printers = [];
  }

  return (
    <div className="page-shell">
      <DetailPageHeader
        eyebrow="Склад"
        icon="warehouses"
        title={warehouse.name}
        subtitle="Управленческая группировка ячеек физического хранения. Привязка ячейки к складу и печать QR — здесь же."
        backHref="/admin/warehouses"
        backLabel="К списку складов"
        meta={
          <>
            {warehouse.code ? (
              <span>
                Код: <code>{warehouse.code}</code>
              </span>
            ) : (
              <span>Код не задан</span>
            )}
            <span>·</span>
            <span>
              Линий: <strong>{warehouse.lines.length}</strong>
            </span>
            <span>·</span>
            <span>
              Ячеек: <strong>{warehouse.cellsCount}</strong>
            </span>
          </>
        }
        badges={
          <span
            className={`pill ${warehouse.isActive ? 'pill--ok' : 'pill--ghost'}`}
          >
            <Icon name={warehouse.isActive ? 'success' : 'idle'} size={14} />
            {warehouse.isActive ? 'Активен' : 'Неактивен'}
          </span>
        }
      />

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="edit" />
            Реквизиты склада
          </h2>
        </div>
        <WarehouseEditForm warehouse={warehouse} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="plus" />
            Создать линию
          </h2>
          <span className="section-header__hint">
            Массовое создание ячеек по шаблону <code>A1..A20</code>.
          </span>
        </div>
        <p className="detail-form__hint">
          Укажите код линии (например, <code>A</code>) и количество (например,{' '}
          <code>20</code>) — система создаст линию и ячейки <code>A1</code>…
          <code>A20</code>, привязанные к этому складу. Код линии должен быть
          уникальным глобально.
        </p>
        <CreateLineForm warehouseId={warehouse.id} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="overview" />
            Линии склада
          </h2>
          {warehouse.lines.length > 0 && (
            <span className="section-header__hint">
              Всего линий: {warehouse.lines.length}
            </span>
          )}
        </div>
        {warehouse.lines.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state__icon">
              <Icon name="overview" />
            </span>
            <span className="empty-state__title">Линий ещё нет</span>
            <span className="empty-state__hint">
              Создайте первую через форму выше — это удобный способ массово
              развернуть ячейки одной серии.
            </span>
          </div>
        ) : (
          <div className="inline-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Код линии</th>
                  <th className="num">Ячеек</th>
                  <th>Создана</th>
                </tr>
              </thead>
              <tbody>
                {warehouse.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <strong>{l.code}</strong>
                    </td>
                    <td className="num">{l.cellsCount}</td>
                    <td>
                      <span className="data-list__value--muted">
                        {new Date(l.createdAt).toLocaleString('ru-RU')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="warehouses" />
            Ячейки склада
          </h2>
          <div className="section-header__actions">
            {warehouse.cells.length > 0 && (
              <span className="section-header__hint">
                Всего ячеек: {warehouse.cells.length}
              </span>
            )}
            <WarehouseBulkPrintPanel
              warehouse={warehouse}
              printers={printers}
            />
          </div>
        </div>
        {warehouse.cells.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state__icon">
              <Icon name="warehouses" />
            </span>
            <span className="empty-state__title">Ячеек пока нет</span>
            <span className="empty-state__hint">
              К этому складу не привязано ни одной ячейки. Создайте линию
              выше или привяжите существующую ячейку ниже.
            </span>
          </div>
        ) : (
          <div className="inline-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Код</th>
                  <th>QR</th>
                  <th>Активна</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {warehouse.cells.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.code}</strong>
                    </td>
                    <td>
                      <code style={{ fontSize: '0.78rem' }}>{c.qrCode}</code>
                    </td>
                    <td>
                      {c.active ? (
                        <span className="pill pill--ok">
                          <Icon name="success" size={13} /> да
                        </span>
                      ) : (
                        <span className="pill pill--ghost">нет</span>
                      )}
                    </td>
                    <td>
                      <div className="table-actions">
                        <a
                          href={c.printUrl}
                          className="btn btn-primary"
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Открыть печатную форму QR-этикетки в новой вкладке"
                        >
                          <Icon name="scan" size={14} />
                          Печать QR
                        </a>
                        <DetachCellButton
                          warehouseId={warehouse.id}
                          cellId={c.id}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="plus" />
            Привязать ячейку
          </h2>
        </div>
        <p className="detail-form__hint">
          Выберите существующую ячейку из общего списка. Если ячейка уже
          привязана к другому складу, привязка явно переезжает — складская
          группировка не влияет на размещение паспортов (flow «scan cell →
          place passport» работает как раньше).
        </p>
        <AssignCellForm
          warehouseId={warehouse.id}
          availableCells={availableCells}
        />
      </section>
    </div>
  );
}
