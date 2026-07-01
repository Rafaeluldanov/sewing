import Link from 'next/link';
import { Building2, ArrowRight } from 'lucide-react';
import type { TenantSummaryDto } from '@sewing/shared/superadmin';
import { ApiRequestError, errorText } from '@/lib/api';
import { listTenants } from '@/lib/superadmin-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import { CreateTenantForm } from './create-tenant-form';

export const dynamic = 'force-dynamic';

function modulesSummary(t: TenantSummaryDto): string {
  const off = t.modules.filter((m) => !m.enabled).map((m) => m.moduleKey);
  return off.length === 0 ? 'все включены' : `выкл: ${off.join(', ')}`;
}

export default async function SuperadminTenantsPage() {
  // Базовый домен для авто-подстановки host в форме создания (runtime, не
  // build-time NEXT_PUBLIC_*): пер-окружение — dev ⇒ dev.teeon.ru,
  // prod ⇒ prod.teeon.ru (прокидывается в web через docker-compose.*.yml).
  // Фолбэк localhost — только если переменная вообще не задана.
  const tenantBaseDomain = process.env.TENANT_BASE_DOMAIN?.trim() || 'localhost';
  let tenants: TenantSummaryDto[] = [];
  let error: string | null = null;
  try {
    tenants = await listTenants();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список тенантов (control-plane выключен?)';
  }

  return (
    <AdminPageShell
      icon={<Building2 size={22} strokeWidth={1.6} aria-hidden />}
      title="Тенанты"
      subtitle={`Компаний в control-plane: ${tenants.length}`}
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader title="Список тенантов" hint={`${tenants.length}`} />
        {tenants.length === 0 && !error ? (
          <p className="admin-muted">Тенантов пока нет.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Компания</th>
                <th>Статус</th>
                <th>Домены</th>
                <th>БД</th>
                <th>Модули</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link
                      href={`/superadmin/${t.id}`}
                      className="admin-table__action-link"
                    >
                      <strong>{t.name}</strong>
                    </Link>
                    <div className="admin-muted" style={{ fontSize: 12 }}>
                      {t.slug}
                    </div>
                  </td>
                  <td>
                    <AdminStatusBadge tone={t.status === 'ACTIVE' ? 'success' : 'danger'}>
                      {t.status === 'ACTIVE' ? 'Активен' : 'Приостановлен'}
                    </AdminStatusBadge>
                  </td>
                  <td>
                    {t.domains.length === 0 ? (
                      <span className="admin-muted">—</span>
                    ) : (
                      t.domains.map((d) => d.host).join(', ')
                    )}
                  </td>
                  <td>{t.dbName}</td>
                  <td className="admin-muted" style={{ fontSize: 13 }}>
                    {modulesSummary(t)}
                  </td>
                  <td>
                    <Link
                      href={`/superadmin/${t.id}`}
                      className="admin-table__action-link"
                      aria-label="Открыть"
                    >
                      <ArrowRight size={16} strokeWidth={1.6} aria-hidden />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader
          title="Создать тенанта"
          hint="CREATE DB → миграции → сид → админ → регистрация"
        />
        <CreateTenantForm baseDomain={tenantBaseDomain} />
      </AdminCard>
    </AdminPageShell>
  );
}
