import { RefreshCw, Search } from 'lucide-react';
import { ApiRequestError } from '@/lib/api';
import { getDiagnosticConsistencyReport } from '@/lib/admin-api';
import type {
  DiagnosticConsistencyReportDto,
  DiagnosticIssueDto,
} from '@sewing/shared/diagnostics';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';

export const dynamic = 'force-dynamic';

/**
 * Диагностика данных (Admin UI 2.5).
 *
 * Backend / DTO не меняем. Read-only отчёт; ничего не правится
 * автоматически.
 */
export default async function AdminDiagnosticsPage() {
  let report: DiagnosticConsistencyReportDto | null = null;
  let error: string | null = null;
  try {
    report = await getDiagnosticConsistencyReport();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? `${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'Не удалось загрузить отчёт диагностики';
  }

  if (!report) {
    return (
      <AdminPageShell
        icon={<Search size={22} strokeWidth={1.6} aria-hidden />}
        title="Диагностика данных"
        subtitle="Отчёт по подозрительным состояниям БД"
      >
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
      </AdminPageShell>
    );
  }

  const updatedLabel = new Date(report.generatedAt).toLocaleString('ru-RU');
  const { summary, issues } = report;

  const issueColumns: AdminTableColumn<DiagnosticIssueDto>[] = [
    {
      key: 'severity',
      header: 'Severity',
      render: (issue) => (
        <AdminStatusBadge
          tone={issue.severity === 'CRITICAL' ? 'danger' : 'warning'}
        >
          {issue.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING'}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'code',
      header: 'Code',
      render: (issue) => <code>{issue.code}</code>,
    },
    {
      key: 'entity',
      header: 'Сущность',
      render: (issue) => (
        <div>
          <div>{issue.entityType}</div>
          <div className="admin-muted" style={{ fontSize: '0.8rem' }}>
            <code>{issue.entityId}</code>
          </div>
        </div>
      ),
    },
    {
      key: 'message',
      header: 'Сообщение',
      render: (issue) => issue.message,
    },
    {
      key: 'context',
      header: 'Context',
      render: (issue) => (
        <pre
          style={{
            margin: 0,
            fontSize: '0.78rem',
            background: 'var(--admin-primary-soft)',
            padding: '0.5rem 0.7rem',
            borderRadius: '0.4rem',
            maxHeight: '10rem',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {JSON.stringify(issue.context, null, 2)}
        </pre>
      ),
    },
  ];

  return (
    <AdminPageShell
      icon={<Search size={22} strokeWidth={1.6} aria-hidden />}
      title="Диагностика данных"
      subtitle={`Обновлено ${updatedLabel}`}
      actions={
        <form action="">
          <button type="submit" className="admin-btn">
            <RefreshCw size={16} strokeWidth={1.6} aria-hidden />
            Обновить
          </button>
        </form>
      }
    >
      <div className="admin-grid-2">
        <AdminCard>
          <AdminSectionHeader title="Всего" />
          <div style={{ fontSize: '2rem', fontWeight: 700 }}>{summary.total}</div>
        </AdminCard>
        <div className="admin-stack">
          <AdminCard>
            <AdminSectionHeader title="Critical" />
            <div
              style={{
                fontSize: '1.5rem',
                fontWeight: 700,
                color:
                  summary.critical > 0
                    ? 'var(--admin-danger, #b91c1c)'
                    : 'var(--admin-muted)',
              }}
            >
              {summary.critical}
            </div>
          </AdminCard>
          <AdminCard>
            <AdminSectionHeader title="Warning" />
            <div
              style={{
                fontSize: '1.5rem',
                fontWeight: 700,
                color:
                  summary.warning > 0
                    ? 'var(--admin-warning, #b45309)'
                    : 'var(--admin-muted)',
              }}
            >
              {summary.warning}
            </div>
          </AdminCard>
        </div>
      </div>

      <AdminCard>
        <AdminSectionHeader title="Находки" hint={`${issues.length}`} />
        {issues.length === 0 ? (
          <p className="admin-muted" style={{ margin: 0 }}>
            Проблем не найдено.
          </p>
        ) : (
          <AdminTable
            rows={issues}
            columns={issueColumns}
            rowKey={(i) => `${i.code}:${i.entityId}`}
          />
        )}
      </AdminCard>
    </AdminPageShell>
  );
}
