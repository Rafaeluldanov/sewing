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
import { DeleteTenantForm } from '../delete-tenant-form';

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
  // Дефолтного тенанта (single-tenant fallback) удалять нельзя — не рисуем
  // danger-zone вовсе, чтобы не смущать оператора неработающей кнопкой.
  const isDefault =
    tenant.id === (process.env.DEFAULT_TENANT_ID ?? 'default') ||
    tenant.slug === (process.env.DEFAULT_TENANT_SLUG ?? 'default');

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
                    <a
                      href={`https://${d.host}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <strong>{d.host}</strong>
                    </a>
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

      {/* Опасная зона — необратимое удаление. Только для не-дефолтного тенанта;
          сама кнопка доступна лишь из статуса «Приостановлен». */}
      {!isDefault && (
        <AdminCard>
          <AdminSectionHeader title="Опасная зона" hint="необратимо" />
          {active ? (
            <p className="admin-muted">
              Удаление доступно только для приостановленного тенанта. Сначала
              нажмите «Приостановить» — это снимает домены с резолва, живого
              трафика к БД не остаётся, и только тогда БД можно безопасно
              удалить.
            </p>
          ) : (
            <>
              <p className="admin-muted">
                Удаляет тенанта <strong>{tenant.slug}</strong> НЕОБРАТИМО:
                снимается бэкап-дамп (<code>backups/tenants/…</code>), затем{' '}
                <code>DROP DATABASE {tenant.dbName}</code> и запись из
                control-plane (каскадом домены и модули). Восстановление —
                только из бэкап-дампа вручную.
              </p>
              <DeleteTenantForm tenantId={tenant.id} slug={tenant.slug} />
            </>
          )}
        </AdminCard>
      )}
    </AdminPageShell>
  );
}
