import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ClipboardList,
  Copy,
  ExternalLink,
  FileDown,
  Paperclip,
} from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { getConstructorTask } from '@/lib/constructor-tasks-api';
import { getPattern } from '@/lib/patterns-api';
import {
  CONSTRUCTOR_TASK_STATUS_LABELS,
  CONSTRUCTOR_TASK_STATUS_TONE,
  type ConstructorTaskDetailDto,
  type ConstructorTaskFileDto,
} from '@sewing/shared/constructor-tasks';
import type { PatternDetailDto } from '@sewing/shared/patterns';
import {
  AdminCard,
  AdminPageShell,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { AcceptTaskButton } from './accept-task-button';
import { CancelTaskButton } from './cancel-task-button';
import { RequestReworkForm } from './request-rework-form';

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

  // Дополнительно тянем PatternDetailDto, чтобы показать готовые DXF
  // лекала от конструктора (если уже загружены). Это отдельный запрос
  // — не критично по перфу, страница admin.
  let pattern: PatternDetailDto | null = null;
  try {
    pattern = await getPattern(task.patternItemId);
  } catch {
    // Не критично — секция «Готовые лекала» просто не отрендерится.
  }

  // Только реально загруженные файлы (PDF/PLT/DXF/PLO) — размеры-заглушки
  // без файла (fileUrl = null) в секции «Готовые лекала» не показываем.
  const activeSizeFiles =
    pattern?.sizeFiles.filter(
      (sf) => sf.status === 'ACTIVE' && sf.fileUrl != null,
    ) ?? [];
  const initialFiles = task.files.filter(
    (f) => f.direction !== 'REWORK',
  );
  const reworkFiles = task.files.filter((f) => f.direction === 'REWORK');

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
        <div style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
          <Link
            href="/admin/constructor-tasks"
            className="admin-btn admin-btn--ghost"
          >
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
          </Link>
          {task.status === 'PENDING_ACCEPT' && (
            <>
              <AcceptTaskButton taskId={task.id} />
              <RequestReworkForm taskId={task.id} />
            </>
          )}
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
              <AdminStatusBadge tone={CONSTRUCTOR_TASK_STATUS_TONE[task.status]}>
                {CONSTRUCTOR_TASK_STATUS_LABELS[task.status]}
              </AdminStatusBadge>
            </dd>
            {task.acceptedAt && (
              <>
                <dt style={{ color: '#475569' }}>Принято</dt>
                <dd style={{ margin: 0 }}>
                  {new Date(task.acceptedAt).toLocaleString('ru-RU', {
                    timeZone: 'Europe/Moscow',
                  })}
                </dd>
              </>
            )}
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
            Бриф от менеджера{' '}
            <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
              ({initialFiles.length})
            </span>
          </h3>
          <FileList files={initialFiles} emptyHint="Бриф не прикреплён." />
        </AdminCard>
      </div>

      {activeSizeFiles.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <AdminCard>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
                marginBottom: 8,
              }}
            >
              <h3 className="admin-card__title" style={{ margin: 0 }}>
                Готовые лекала от конструктора{' '}
                <span
                  className="admin-muted"
                  style={{ fontSize: '0.85rem' }}
                >
                  ({activeSizeFiles.length})
                </span>
              </h3>
              {task.status === 'DONE' && (
                <Link
                  href={`/admin/patterns/${task.patternItemId}?clone=1`}
                  className="admin-btn admin-btn--ghost"
                  title="Создать новую номенклатуру на основе этих DXF / категории / расхода"
                >
                  <Copy size={16} strokeWidth={1.6} aria-hidden />
                  Создать ещё одну номенклатуру
                </Link>
              )}
            </div>
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
              {activeSizeFiles.map((sf) => (
                <li
                  key={sf.id}
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
                  <FileDown size={14} strokeWidth={1.6} aria-hidden />
                  <strong style={{ minWidth: 64 }}>{sf.size.code}</strong>
                  <a
                    href={sf.fileUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      flex: 1,
                      color: 'var(--admin-primary, #2563eb)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {sf.originalFileName}
                  </a>
                  <span
                    className="admin-muted"
                    style={{ fontSize: '0.8rem' }}
                  >
                    v{sf.version}
                  </span>
                </li>
              ))}
            </ul>
          </AdminCard>
        </div>
      )}

      {reworkFiles.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <AdminCard>
            <h3 className="admin-card__title">
              Замечания на доработку{' '}
              <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
                ({reworkFiles.length})
              </span>
            </h3>
            <FileList files={reworkFiles} emptyHint="—" />
          </AdminCard>
        </div>
      )}
    </AdminPageShell>
  );
}

/**
 * Локальный рендерер списка `ConstructorTaskFile`-ов. Использован
 * дважды (бриф + замечания), отличия только в заголовке секции.
 */
function FileList({
  files,
  emptyHint,
}: {
  files: ConstructorTaskFileDto[];
  emptyHint: string;
}) {
  if (files.length === 0) {
    return (
      <p className="admin-muted" style={{ margin: 0 }}>
        {emptyHint}
      </p>
    );
  }
  return (
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
      {files.map((f) => (
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
        </li>
      ))}
    </ul>
  );
}
