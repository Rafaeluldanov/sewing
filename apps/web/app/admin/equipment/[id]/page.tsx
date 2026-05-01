import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { buildEquipmentPrintUrl, getEquipment } from '@/lib/equipment-api';
import { getShiftMeta } from '@/lib/shifts-api';
import { Icon } from '@/components/icon';
import { DetailPageHeader } from '@/components/detail-page-header';
import {
  EquipmentDisplayNumberForm,
  EquipmentNameForm,
  EquipmentOperationsEditor,
} from './edit-form';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

/**
 * Карточка оборудования с чек-листом разрешённых операций
 * (см. ADR-0017, `docs/screens.md §10a`).
 *
 * Список доступных операций берём из `GET /api/shifts/meta` —
 * там уже отдаются только активные операции, отсортированные по
 * `sortOrder`. Это позволяет не плодить отдельный
 * `/api/operations` endpoint ради одного экрана.
 */
export default async function AdminEquipmentDetailPage({ params }: Params) {
  let equipment;
  try {
    equipment = await getEquipment(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  const meta = await getShiftMeta();
  const printUrl = buildEquipmentPrintUrl(equipment.id);

  const titleNode = (
    <>
      {equipment.displayNumber && (
        <span
          style={{ marginRight: '0.5rem', color: 'var(--color-fg-muted)' }}
          title="Ручной номер станка для физической маркировки"
        >
          №{equipment.displayNumber}
        </span>
      )}
      {equipment.name}
    </>
  );

  return (
    <div className="page-shell">
      <DetailPageHeader
        eyebrow="Оборудование"
        icon="equipment"
        title={titleNode}
        subtitle="Карточка станка: ручной номер для физической маркировки и набор операций, доступных швее на /work."
        backHref="/admin/equipment"
        backLabel="К списку оборудования"
        meta={
          <>
            <span>
              Код: <code>{equipment.code}</code>
            </span>
            <span>·</span>
            <span>
              QR: <code>{equipment.qrCode}</code>
            </span>
          </>
        }
        badges={
          <span
            className={`pill ${equipment.active ? 'pill--ok' : 'pill--ghost'}`}
          >
            <Icon name={equipment.active ? 'success' : 'idle'} size={14} />
            {equipment.active ? 'Активно' : 'Неактивно'}
          </span>
        }
        actions={
          <a
            href={printUrl}
            className="btn btn-primary"
            target="_blank"
            rel="noopener noreferrer"
            title="Открыть печатную форму QR-этикетки в новой вкладке"
          >
            <Icon name="scan" size={16} />
            Печать QR
          </a>
        }
      />

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="equipment" />
            Название оборудования
          </h2>
        </div>
        <p className="detail-form__hint">
          Человекочитаемое название станка/рабочего места. Видно в списке
          оборудования, на печатной QR-этикетке и в форме старта смены у
          швеи на /work. Технический код (`{equipment.code}`) и QR-payload
          не меняются при переименовании.
        </p>
        <EquipmentNameForm equipment={equipment} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="equipment" />
            Номер станка
          </h2>
        </div>
        <p className="detail-form__hint">
          Ручной порядковый номер для физической маркировки. Печатается крупно
          на QR-этикетке, чтобы швея/начальник цеха не путали станки визуально
          (например, два соседних оверлока). Уникальность по типу — допустима
          (Оверлок №1 и Распошив №1 могут жить рядом).
        </p>
        <EquipmentDisplayNumberForm equipment={equipment} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="operations" />
            Разрешённые операции
          </h2>
          <span className="section-header__hint">
            Чек-лист синхронизирован с /work
          </span>
        </div>
        <p className="detail-form__hint">
          Отметьте операции, которые швея сможет выбрать на этом станке при
          старте смены. Изменения вступают в силу сразу — на /work новый набор
          появится при следующем сканировании QR оборудования.
        </p>
        <EquipmentOperationsEditor
          equipment={equipment}
          operations={meta.operations}
        />
      </section>
    </div>
  );
}
