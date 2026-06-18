import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Factory, Printer, ScanLine } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { buildEquipmentPrintUrl, getEquipment } from '@/lib/equipment-api';
import { getShiftMeta } from '@/lib/shifts-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTechInfo,
} from '@/components/admin';
import { formatStatus, statusTone } from '@/lib/admin-labels';
import {
  EquipmentDisplayNumberForm,
  EquipmentNameForm,
  EquipmentOperationsEditor,
  EquipmentRoleForm,
} from './edit-form';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

/**
 * Карточка оборудования (Admin UI 2.0, ADR-0017).
 *
 * Структура страницы — единый стандарт для всех admin detail-pages:
 *   1. Header — back-link, заголовок, статус, главные действия
 *      (печать QR, и т.д.).
 *   2. Основная информация — название и ручной номер станка
 *      (`EquipmentNameForm`, `EquipmentDisplayNumberForm`).
 *   3. Связи — чек-лист разрешённых операций
 *      (`EquipmentOperationsEditor`).
 *   4. QR — карточка с кнопкой «Печать QR» (одна на странице).
 *   5. Техническая информация — id / code / qrCode внутри
 *      collapsible-блока (`AdminTechInfo`), чтобы не шумело в списке
 *      полей, но сохранялось для разбора инцидентов.
 *
 * Все формы (`edit-form.tsx`) остались прежними — мы меняем только
 * раскладку и обёртку, чтобы не трогать server actions и валидацию.
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

  return (
    <AdminPageShell
      icon={<Factory size={22} strokeWidth={1.6} aria-hidden />}
      title={
        equipment.displayNumber
          ? `№${equipment.displayNumber} · ${equipment.name}`
          : equipment.name
      }
      subtitle={`${equipment.allowedOperations.length} операций`}
      actions={
        <>
          <Link href="/admin/equipment" className="admin-btn admin-btn--ghost">
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К списку
          </Link>
          <AdminStatusBadge tone={statusTone(equipment.active)}>
            {formatStatus(equipment.active)}
          </AdminStatusBadge>
          <a
            href={printUrl}
            className="admin-btn admin-btn--primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Printer size={16} strokeWidth={1.6} aria-hidden />
            Печать QR
          </a>
        </>
      }
    >
      <div className="admin-grid-2">
        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="Основное" />
            <EquipmentNameForm equipment={equipment} />
            <EquipmentDisplayNumberForm equipment={equipment} />
            <EquipmentRoleForm equipment={equipment} />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Разрешённые операции" />
            <EquipmentOperationsEditor
              equipment={equipment}
              operations={meta.operations}
            />
          </AdminCard>
        </div>

        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="QR-этикетка" />
            <div className="admin-actions-row" style={{ justifyContent: 'flex-start' }}>
              <a
                href={printUrl}
                className="admin-btn admin-btn--primary"
                target="_blank"
                rel="noopener noreferrer"
              >
                <ScanLine size={16} strokeWidth={1.6} aria-hidden />
                Открыть печатную форму
              </a>
            </div>
          </AdminCard>

          <AdminTechInfo
            items={[
              { label: 'ID', value: <code>{equipment.id}</code> },
              { label: 'Код', value: <code>{equipment.code}</code> },
              { label: 'QR', value: <code>{equipment.qrCode}</code> },
            ]}
          />
        </div>
      </div>
    </AdminPageShell>
  );
}
