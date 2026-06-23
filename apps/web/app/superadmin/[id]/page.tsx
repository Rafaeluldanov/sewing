import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Building2 } from 'lucide-react';
import type { TenantSummaryDto } from '@sewing/shared/superadmin';
import { ApiRequestError } from '@/lib/api';
import { getTenant } from '@/lib/superadmin-api';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTechInfo,
} from '@/components/admin';
import {
  removeDomainAction,
  setModuleAction,
  setStatusAction,
} from '../actions';
import { AddDomainForm } from '../add-domain-form';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

export default async function SuperadminTenantDetailPage({ params }: Params) {
  let tenant: TenantSummaryDto;
  try {
    tenant = await getTenant(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  const active = tenant.status === 'ACTIVE';

  return (
    <AdminPageShell
      icon={<Building2 size={22} strokeWidth={1.6} aria-hidden />}
      title={tenant.name}
      subtitle={`slug: ${tenant.slug} · БД: ${tenant.dbName}`}
      actions={
        <>
          <Link href="/superadmin" className="admin-btn admin-btn--ghost">
            <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
          </Link>
          <AdminStatusBadge tone={active ? 'success' : 'danger'}>
            {active ? 'Активен' : 'Приостановлен'}
          </AdminStatusBadge>
        </>
      }
    >
      <div className="admin-grid-2">
        <div className="admin-stack">
          {/* Статус */}
          <AdminCard>
            <AdminSectionHeader title="Статус" />
            <p className="admin-muted">
              {active
                ? 'Тенант активен — резолвится по своим доменам.'
                : 'Тенант приостановлен — домены отдают 404 UNKNOWN_TENANT.'}
            </p>
            <form action={setStatusAction}>
              <input type="hidden" name="tenantId" value={tenant.id} />
              <input
                type="hidden"
                name="status"
                value={active ? 'SUSPENDED' : 'ACTIVE'}
              />
              <button
                type="submit"
                className={`admin-btn ${active ? '' : 'admin-btn--primary'}`}
              >
                {active ? 'Приостановить' : 'Активировать'}
              </button>
            </form>
          </AdminCard>

          {/* Домены */}
          <AdminCard>
            <AdminSectionHeader
              title="Домены"
              hint={`${tenant.domains.length}`}
            />
            {tenant.domains.length === 0 ? (
              <p className="admin-muted">Доменов нет — тенант недоступен по сети.</p>
            ) : (
              <ul className="admin-list">
                {tenant.domains.map((d) => (
                  <li
                    key={d.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <strong>{d.host}</strong>
                    {d.isPrimary && (
                      <AdminStatusBadge tone="info">основной</AdminStatusBadge>
                    )}
                    <form action={removeDomainAction} style={{ marginLeft: 'auto' }}>
                      <input type="hidden" name="tenantId" value={tenant.id} />
                      <input type="hidden" name="domainId" value={d.id} />
                      <button type="submit" className="admin-btn admin-btn--ghost">
                        Удалить
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <div style={{ marginTop: 12 }}>
              <AddDomainForm tenantId={tenant.id} />
            </div>
          </AdminCard>
        </div>

        <div className="admin-stack">
          {/* Модули */}
          <AdminCard>
            <AdminSectionHeader
              title="Модули"
              hint="нет строки = включён (default-on)"
            />
            <ul className="admin-list">
              {tenant.modules.map((m) => (
                <li
                  key={m.moduleKey}
                  style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  <AdminStatusBadge tone={m.enabled ? 'success' : 'muted'}>
                    {m.enabled ? 'вкл' : 'выкл'}
                  </AdminStatusBadge>
                  <span>{m.moduleKey}</span>
                  {!m.explicit && (
                    <span className="admin-muted" style={{ fontSize: 12 }}>
                      (дефолт)
                    </span>
                  )}
                  <form action={setModuleAction} style={{ marginLeft: 'auto' }}>
                    <input type="hidden" name="tenantId" value={tenant.id} />
                    <input type="hidden" name="moduleKey" value={m.moduleKey} />
                    <input
                      type="hidden"
                      name="enabled"
                      value={m.enabled ? 'false' : 'true'}
                    />
                    <button type="submit" className="admin-btn admin-btn--ghost">
                      {m.enabled ? 'Выключить' : 'Включить'}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </AdminCard>

          <AdminTechInfo
            title="Служебное"
            items={[
              { label: 'Tenant ID', value: tenant.id },
              { label: 'Создан', value: fmt(tenant.createdAt) },
              { label: 'Миграция', value: tenant.migration?.lastMigration ?? '—' },
              { label: 'Статус миграции', value: tenant.migration?.lastStatus ?? '—' },
              { label: 'Обновлено', value: fmt(tenant.migration?.updatedAt ?? null) },
            ]}
          />
        </div>
      </div>
    </AdminPageShell>
  );
}
