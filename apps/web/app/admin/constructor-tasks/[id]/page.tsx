import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ClipboardList,
  ExternalLink,
  Paperclip,
} from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { getConstructorTask } from '@/lib/constructor-tasks-api';
import {
  CONSTRUCTOR_TASK_STATUS_LABELS,
  type ConstructorTaskDetailDto,
} from '@sewing/shared/constructor-tasks';
import {
  AdminCard,
  AdminPageShell,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { CancelTaskButton } from './cancel-task-button';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { id: string };
}

/**
 * Детальная страница заявки конструктору. Read-only в первой итерации
 * (см. ТЗ §«Что НЕ делаем»):
 *   - размерная таблица — read-only;
 *   - вложенные файлы — `<a>`-ссылки на `/uploads/...`;
 *   - комментарий — `<p>` без редактирования;
 *   - кнопок «Перевести в работу / Завершить / Отменить» НЕТ —
 *     управление будет добавлено вместе с кабинетом конструктора.
 *
 * Стиль зеркалирует другие admin-detail-страницы (`/admin/orders/[id]`,
 * `/admin/tech-cards/[id]`) — карточки `AdminCard` + список `<dl>` +
 * таблица размеров.
 */
export default async function AdminConstructorTaskDetailPage({
  params,
}: PageProps) {
  let task: ConstructorTaskDetailDto;
  try {
    task = await getConstructorTask(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  const sizeColumns: AdminTableColumn<
    ConstructorTaskDetailDto['sizeRows'][number]
  >[] = [
    {
      key: 'size',
      header: 'Размер',
      render: (r) => <strong>{r.sizeCodeSnapshot}</strong>,
    },
    {
      key: 'kulirka',
      header: 'Кулирка, м пог.',
      align: 'right',
      render: (r) =>
        r.kulirkaMeters == null ? (
          <span className="admin-muted">—</span>
        ) : (
          r.kulirkaMeters
        ),
    },
    {
      key: 'kashkorse',
      header: 'Кашкорсе, м пог.',
      align: 'right',
      render: (r) =>
        r.kashkorseMeters == null ? (
          <span className="admin-muted">—</span>
        ) : (
          r.kashkorseMeters
        ),
    },
  ];

  return (
    <AdminPageShell
      icon={<ClipboardList size={22} strokeWidth={1.6} aria-hidden />}
      title={task.patternName}
      subtitle={`Артикул: ${task.patternArticle}`}
      actions={
        <div style={{ display: 'inline-flex', gap: 8 }}>
          <Link
            href="/admin/constructor-tasks"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
          </Link>
          <CancelTaskButton taskId={task.id} currentStatus={task.status} />
        </div>
      }
    >
      <div
        style={{
          display: 'grid',
          gap: '1rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        }}
      >
        <AdminCard>
          <h3 className="admin-card__title">Параметры заявки</h3>
          <dl
            style={{
              margin: 0,
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '4px 12px',
              fontSize: '0.9rem',
            }}
          >
            <dt style={{ color: '#475569' }}>Статус</dt>
            <dd style={{ margin: 0 }}>
              <AdminStatusBadge
                tone={
                  task.status === 'DONE'
                    ? 'success'
                    : task.status === 'CANCELLED'
                      ? 'muted'
                      : task.status === 'IN_PROGRESS'
                        ? 'info'
                        : 'warning'
                }
              >
                {CONSTRUCTOR_TASK_STATUS_LABELS[task.status]}
              </AdminStatusBadge>
            </dd>
            <dt style={{ color: '#475569' }}>Создана</dt>
            <dd style={{ margin: 0 }}>
              {new Date(task.createdAt).toLocaleString('ru-RU')}
            </dd>
            <dt style={{ color: '#475569' }}>Кем создана</dt>
            <dd style={{ margin: 0 }}>
              {task.createdByName ?? <span className="admin-muted">—</span>}
            </dd>
            <dt style={{ color: '#475569' }}>Конструктор</dt>
            <dd style={{ margin: 0 }}>
              {task.assignedToName ?? (
                <span className="admin-muted">не назначен</span>
              )}
            </dd>
            <dt style={{ color: '#475569' }}>Лекало</dt>
            <dd style={{ margin: 0 }}>
              <Link
                href={`/admin/patterns/${task.patternItemId}`}
                style={{
                  color: 'var(--admin-primary, #2563eb)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {task.patternName}
                <ExternalLink size={12} strokeWidth={1.6} aria-hidden />
              </Link>
            </dd>
          </dl>
        </AdminCard>

        <AdminCard>
          <h3 className="admin-card__title">Комментарий</h3>
          {task.comment.trim() === '' ? (
            <p className="admin-muted" style={{ margin: 0 }}>
              Комментарий не задан.
            </p>
          ) : (
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{task.comment}</p>
          )}
        </AdminCard>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <AdminCard>
          <h3 className="admin-card__title">Размерная таблица</h3>
        {task.sizeRows.length === 0 ? (
          <p className="admin-muted" style={{ margin: 0 }}>
            Размеры не заданы.
          </p>
        ) : (
          <AdminTable
            rows={task.sizeRows}
            columns={sizeColumns}
            rowKey={(r) => r.id}
          />
        )}
        </AdminCard>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <AdminCard>
          <h3 className="admin-card__title">
            Вложения{' '}
            <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
              ({task.files.length})
            </span>
          </h3>
        {task.files.length === 0 ? (
          <p className="admin-muted" style={{ margin: 0 }}>
            Файлы не прикреплены.
          </p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.25rem',
            }}
          >
            {task.files.map((f) => (
              <li
                key={f.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.25rem 0.5rem',
                  border: '1px solid var(--admin-border, #e5e7eb)',
                  borderRadius: 4,
                  fontSize: '0.9rem',
                }}
              >
                <Paperclip size={14} strokeWidth={1.6} aria-hidden />
                <a
                  href={f.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    flex: 1,
                    color: 'var(--admin-primary, #2563eb)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {f.originalFileName}
                </a>
                <span className="admin-muted" style={{ fontSize: '0.8rem' }}>
                  {(f.sizeBytes / 1024).toFixed(0)} КБ
                </span>
                <span className="admin-muted" style={{ fontSize: '0.8rem' }}>
                  {f.contentType || 'unknown'}
                </span>
              </li>
            ))}
          </ul>
        )}
        </AdminCard>
      </div>
    </AdminPageShell>
  );
}
