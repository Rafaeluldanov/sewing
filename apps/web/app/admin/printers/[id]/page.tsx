import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { listEquipment } from '@/lib/equipment-api';
import {
  buildAgentDownloadUrl,
  getPrinter,
  listPrintJobsForPrinter,
} from '@/lib/printers-api';
import { Icon } from '@/components/icon';
import { EditPrinterForm } from './edit-form';
import { PairingPanel } from './pairing-panel';
import { TestPrintForm } from './test-print-form';
import { DeletePrinterForm } from './delete-form';
import { WindowsPrinterForm } from './windows-printer-form';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { id: string };
}

/**
 * Карточка принтера (см. `docs/screens.md §18`).
 *
 * Объединяет три use-case-а менеджера:
 *   1. редактировать имя/тип/привязку к рабочему месту;
 *   2. сгенерировать pairingCode и скачать агент (подключение);
 *   3. отправить тестовое задание, чтобы убедиться, что агент жив.
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

  const [equipment, jobs] = await Promise.all([
    listEquipment(),
    listPrintJobsForPrinter(id, 20).catch(() => []),
  ]);

  const agentUrl = buildAgentDownloadUrl();

  return (
    <div className="page-shell">
      <header className="admin-overview__header">
        <div>
          <div className="page-eyebrow">
            <Link href="/admin/printers">← Принтеры</Link>
          </div>
          <h1 className="page-title">
            <Icon name="equipment" />
            {printer.name}
          </h1>
          <p className="page-subtitle">
            <span
              className={`pill ${
                printer.isOnline ? 'pill--ok' : 'pill--ghost'
              }`}
            >
              <Icon
                name={printer.isOnline ? 'success' : 'idle'}
                size={14}
              />
              {printer.isOnline ? 'онлайн' : 'офлайн'}
            </span>
            {printer.lastSeenAt && (
              <>
                {' · последний контакт '}
                <time dateTime={printer.lastSeenAt}>
                  {new Date(printer.lastSeenAt).toLocaleString('ru-RU')}
                </time>
              </>
            )}
            {!printer.isActive && ' · деактивирован'}
          </p>
        </div>
      </header>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="edit" />
            Параметры
          </h2>
        </div>
        <EditPrinterForm printer={printer} equipment={equipment} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="login" />
            Подключение агента
          </h2>
        </div>
        <PairingPanel printer={printer} agentDownloadUrl={agentUrl} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="equipment" />
            Физический принтер Windows
          </h2>
        </div>
        <p className="detail-form__hint">
          Логический принтер выше — это просто карточка в системе.
          Реально печатает агент на одном из системных Windows-принтеров,
          установленных на компьютере. Выберите, на какой именно.
        </p>
        <WindowsPrinterForm printer={printer} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="orders" />
            Тестовая печать
          </h2>
        </div>
        <p className="detail-form__hint">
          Создаст задание-заглушку. Если агент работает — напечатает
          короткий тестовый payload и отметит «PRINTED».
        </p>
        <TestPrintForm printerId={printer.id} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="orders" />
            Последние задания
          </h2>
          <span className="section-header__hint">{jobs.length}</span>
        </div>
        {jobs.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state__title">Заданий пока нет</span>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Создан</th>
                <th>Источник</th>
                <th>Статус</th>
                <th>Завершён</th>
                <th>Ошибка</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{new Date(j.createdAt).toLocaleString('ru-RU')}</td>
                  <td>
                    {j.sourceType}
                    {j.sourceId && (
                      <span className="meta-line"> · {j.sourceId}</span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`pill ${
                        j.status === 'PRINTED'
                          ? 'pill--ok'
                          : j.status === 'FAILED'
                            ? 'pill--error'
                            : 'pill--ghost'
                      }`}
                    >
                      {j.status}
                    </span>
                  </td>
                  <td>
                    {j.completedAt
                      ? new Date(j.completedAt).toLocaleString('ru-RU')
                      : '—'}
                  </td>
                  <td>
                    {j.errorMessage ? (
                      <span className="meta-line">{j.errorMessage}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="section-header">
          <h2>
            <Icon name="reset" />
            Опасная зона
          </h2>
        </div>
        <p className="detail-form__hint">
          Удаление принтера также удаляет историю заданий печати (cascade).
          Для временного отключения снимите галочку «Активен» в параметрах.
        </p>
        <DeletePrinterForm printerId={printer.id} />
      </section>
    </div>
  );
}
