import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Printer as PrinterIcon,
  Send,
} from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import {
  buildAgentDownloadUrl,
  getPrinter,
  listPrintJobsForPrinter,
} from '@/lib/printers-api';
import { formatRole } from '@/lib/admin-labels';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  AdminTechInfo,
  type AdminTableColumn,
} from '@/components/admin';
import { EditPrinterForm } from './edit-form';
import { PairingPanel } from './pairing-panel';
import { TestPrintForm } from './test-print-form';
import { DeletePrinterForm } from './delete-form';
import { WindowsPrinterForm } from './windows-printer-form';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { id: string };
}

interface JobRow {
  id: string;
  createdAt: string;
  sourceType: string;
  sourceId: string | null;
  status: string;
  completedAt: string | null;
  errorMessage: string | null;
}

const PRINTER_TYPE_LABEL: Record<string, string> = {
  DEFAULT: 'По умолчанию',
  WINDOWS: 'Windows',
  ZEBRA: 'Zebra',
};

/**
 * Карточка принтера (Admin UI 2.6).
 *
 * Backend / DTO не меняем. Структура — компактные карточки без
 * длинных описаний:
 *   - левая колонка: «Основное», «Подключение» (Windows + pairing),
 *     «Тест печати», «Опасная зона»;
 *   - правая колонка: «Очередь» с последними заданиями и AdminTechInfo.
 */
export default async function PrinterDetailPage({ params }: PageProps) {
  const id = params.id;

  let printer: Awaited<ReturnType<typeof getPrinter>>;
  try {
    printer = await getPrinter(id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  const jobs = await listPrintJobsForPrinter(id, 20).catch(() => []);

  const agentUrl = buildAgentDownloadUrl();

  const jobColumns: AdminTableColumn<JobRow>[] = [
    {
      key: 'createdAt',
      header: 'Создан',
      render: (j) => (
        <span style={{ fontSize: '0.85rem' }}>
          {new Date(j.createdAt).toLocaleString('ru-RU')}
        </span>
      ),
    },
    {
      key: 'source',
      header: 'Источник',
      render: (j) => <span style={{ fontSize: '0.85rem' }}>{j.sourceType}</span>,
    },
    {
      key: 'status',
      header: 'Статус',
      render: (j) => (
        <AdminStatusBadge
          tone={
            j.status === 'PRINTED'
              ? 'success'
              : j.status === 'FAILED'
                ? 'danger'
                : 'muted'
          }
        >
          {j.status}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'completed',
      header: 'Завершён',
      render: (j) =>
        j.completedAt
          ? new Date(j.completedAt).toLocaleString('ru-RU')
          : '—',
    },
  ];

  return (
    <AdminPageShell
      icon={<PrinterIcon size={22} strokeWidth={1.6} aria-hidden />}
      title={printer.name}
      subtitle={PRINTER_TYPE_LABEL[printer.type] ?? printer.type}
      actions={
        <>
          <Link href="/admin/printers" className="admin-btn admin-btn--ghost">
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
            К списку
          </Link>
          <AdminStatusBadge tone={printer.isOnline ? 'success' : 'muted'}>
            {printer.isOnline ? 'онлайн' : 'офлайн'}
          </AdminStatusBadge>
          {!printer.isActive && (
            <AdminStatusBadge tone="warning">деактивирован</AdminStatusBadge>
          )}
        </>
      }
    >
      <div className="admin-grid-2">
        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="Основное" />
            <EditPrinterForm printer={printer} />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Подключение" />
            <WindowsPrinterForm printer={printer} />
            <PairingPanel printer={printer} agentDownloadUrl={agentUrl} />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Тест печати" />
            <TestPrintForm printerId={printer.id} />
          </AdminCard>

          <AdminCard>
            <AdminSectionHeader title="Опасная зона" />
            <DeletePrinterForm printerId={printer.id} />
          </AdminCard>
        </div>

        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader
              title="Очередь"
              hint={jobs.length > 0 ? `${jobs.length}` : undefined}
            />
            {jobs.length === 0 ? (
              <AdminEmptyState
                icon={<Send size={26} strokeWidth={1.6} aria-hidden />}
                title="Заданий нет"
              />
            ) : (
              <AdminTable
                rows={jobs as JobRow[]}
                columns={jobColumns}
                rowKey={(j) => j.id}
              />
            )}
          </AdminCard>

          <AdminTechInfo
            items={[
              { label: 'ID', value: <code>{printer.id}</code> },
              { label: 'Тип', value: <code>{printer.type}</code> },
              {
                label: 'Роль',
                value: printer.role ? formatRole(printer.role) : '—',
              },
              {
                label: 'Создан',
                value: new Date(printer.createdAt).toLocaleString('ru-RU'),
              },
              {
                label: 'Hostname агента',
                value: printer.agentHostName ?? '—',
              },
              {
                label: 'Последний контакт',
                value: printer.lastSeenAt
                  ? new Date(printer.lastSeenAt).toLocaleString('ru-RU')
                  : '—',
              },
            ]}
          />
        </div>
      </div>
    </AdminPageShell>
  );
}
