import Link from 'next/link';
import { ArrowRight, ClipboardList } from 'lucide-react';
import {
  CONSTRUCTOR_TASK_STATUS_LABELS,
  CONSTRUCTOR_TASK_STATUS_TONE,
  type ConstructorTaskSummaryDto,
} from '@sewing/shared/constructor-tasks';
import { AdminCard, AdminStatusBadge } from '@/components/admin';

/**
 * Карточка «Конструкторское бюро» для страниц заказа
 * (`/admin/orders/[id]` view и edit). Показывает текущий статус
 * связанной задачи, кто ведёт, ключевые даты, и ссылку «Открыть
 * задачу» — кнопок «Принять»/«Вернуть на доработку» здесь нет, чтобы
 * не дублировать UI: они живут на детальной странице задачи
 * (`/admin/constructor-tasks/[id]`).
 *
 * Если `task = null` (у заказа нет связанной задачи — стандартный
 * flow с готовым лекалом) — компонент НЕ рендерится (`return null`),
 * страница заказа выглядит как раньше.
 */
export function OrderConstructorTaskCard({
  task,
  title = 'Конструкторское бюро',
}: {
  task: ConstructorTaskSummaryDto | null | undefined;
  /**
   * Заголовок карточки. На странице заказа (view + edit-форма после
   * блока «Изделие») передаём «Заявки в КБ» — это узнаваемое имя
   * вкладки, которая раньше жила в модалке `CreateProductInline`. На
   * остальных местах (admin-страница задачи и т.д.) используется
   * default «Конструкторское бюро».
   */
  title?: string;
}) {
  if (!task) return null;

  return (
    <AdminCard>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: '0.75rem',
          marginBottom: '0.4rem',
        }}
      >
        <h3
          className="admin-card__title"
          style={{
            margin: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
          }}
        >
          <ClipboardList size={16} strokeWidth={1.6} aria-hidden />
          {title}
        </h3>
        <AdminStatusBadge tone={CONSTRUCTOR_TASK_STATUS_TONE[task.status]}>
          {CONSTRUCTOR_TASK_STATUS_LABELS[task.status]}
        </AdminStatusBadge>
      </div>

      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '4px 12px',
          fontSize: '0.88rem',
        }}
      >
        <dt style={{ color: '#475569' }}>Конструктор</dt>
        <dd style={{ margin: 0 }}>
          {task.assignedToName ?? (
            <span className="admin-muted">не назначен</span>
          )}
        </dd>
        <dt style={{ color: '#475569' }}>Отправлена</dt>
        <dd style={{ margin: 0 }}>
          {new Date(task.createdAt).toLocaleString('ru-RU', {
            timeZone: 'Europe/Moscow',
          })}
        </dd>
        {task.acceptedAt && (
          <>
            <dt style={{ color: '#475569' }}>Принята</dt>
            <dd style={{ margin: 0 }}>
              {new Date(task.acceptedAt).toLocaleString('ru-RU', {
                timeZone: 'Europe/Moscow',
              })}
            </dd>
          </>
        )}
      </dl>

      <div style={{ marginTop: '0.6rem' }}>
        <Link
          href={`/admin/constructor-tasks/${task.id}`}
          className="admin-table__action-link"
        >
          Открыть задачу
          <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      </div>

      {task.status === 'PENDING_ACCEPT' && (
        <p
          className="admin-muted"
          style={{
            marginTop: '0.5rem',
            fontSize: '0.85rem',
            padding: '0.4rem 0.6rem',
            background: '#fef3c7',
            color: '#92400e',
            borderRadius: 4,
          }}
        >
          Лекало готово конструктором — откройте задачу, чтобы принять или
          вернуть на доработку.
        </p>
      )}
      {task.status === 'REWORK' && (
        <p
          className="admin-muted"
          style={{
            marginTop: '0.5rem',
            fontSize: '0.85rem',
            padding: '0.4rem 0.6rem',
            background: '#fee2e2',
            color: '#991b1b',
            borderRadius: 4,
          }}
        >
          Возвращена на доработку — конструктор должен исправить замечания.
        </p>
      )}
      {task.status === 'DONE' && (
        <p
          className="admin-muted"
          style={{
            marginTop: '0.5rem',
            fontSize: '0.85rem',
            padding: '0.4rem 0.6rem',
            background: '#dcfce7',
            color: '#166534',
            borderRadius: 4,
          }}
        >
          Лекало принято — заказ можно запускать в производство.
        </p>
      )}
    </AdminCard>
  );
}
