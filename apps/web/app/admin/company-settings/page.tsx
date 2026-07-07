import Link from 'next/link';
import { Building2, Layers, Plug, Settings, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { CompanySettingsDto } from '@sewing/shared/company-settings';
import type { EmployeeListItemDto } from '@sewing/shared/employees';
import type { IntegrationSettingsDto } from '@sewing/shared/integration';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  getCompanySettings,
  listCompanyDivisions,
} from '@/lib/company-settings-api';
import { getIntegrationSettings } from '@/lib/integration-api';
import { isErpIntegrationEnabled } from '@/lib/feature-flags';
import { listEmployees } from '@/lib/employees-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { AdminCard, AdminPageShell } from '@/components/admin';
import {
  CompanySettingsForm,
  MaterialStockSettingsForm,
} from './settings-form';
import { DivisionsSection } from './divisions-section';
import { MaterialStockDivisionOverridesSection } from './material-stock-division-overrides-section';
import { EmployeeRolesSection } from './employee-roles-section';
import { IntegrationsSection } from './integrations-section';

export const dynamic = 'force-dynamic';

/**
 * Страница «Настройки компании» (`/admin/company-settings`).
 *
 * Разбита на тематические вкладки (состояние в URL — `?tab=`, без
 * client-state, чисто под RSC):
 *   - `org`          — Организация: реквизиты, контакты, банк;
 *   - `divisions`    — Подразделения и склад: глобальные флаги
 *                      «Материалы и склад», справочник подразделений и
 *                      переопределения флагов по цехам (одна связка —
 *                      дефолт → цеха → исключения);
 *   - `access`       — Доступ: роли сотрудников;
 *   - `integrations` — Интеграции: ERP upgifts (только под флагом
 *                      FEATURE_ERP_INTEGRATION, иначе вкладки нет).
 *
 * Backend GET `/api/company-settings` идемпотентно создаёт singleton-
 * строку, если её ещё нет (см. `CompanySettingsService.getOrCreate`),
 * поэтому страница всегда работает без отдельного сценария «первый запуск».
 *
 * RBAC — `SHOP_MANAGER` / `ADMIN` (на backend) + `app/admin/layout.tsx`
 * редиректит остальных пользователей.
 */

type TabKey = 'org' | 'divisions' | 'access' | 'integrations';

function TabLink({
  active,
  href,
  Icon,
  label,
}: {
  active: boolean;
  href: string;
  Icon: LucideIcon;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={`admin-tab ${active ? 'admin-tab--active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <Icon size={15} strokeWidth={1.6} aria-hidden />
      {label}
    </Link>
  );
}

export default async function AdminCompanySettingsPage({
  searchParams,
}: {
  searchParams?: { tab?: string };
}) {
  let settings: CompanySettingsDto | null = null;
  let divisions: CompanyDivisionDto[] = [];
  let error: string | null = null;

  try {
    [settings, divisions] = await Promise.all([
      getCompanySettings(),
      listCompanyDivisions({ includeInactive: true }),
    ]);
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить настройки компании';
  }

  // Список сотрудников + права текущего пользователя для секции «Роли
  // сотрудников». Падение этих запросов не должно ронять страницу
  // настроек — деградируем до пустого списка / без права на ADMIN.
  const [employees, viewer] = await Promise.all([
    listEmployees().catch((): EmployeeListItemDto[] => []),
    getCurrentUserOrNull().catch(() => null),
  ]);
  const canAssignAdmin = (viewer?.user.roles ?? [viewer?.user.role]).includes(
    'ADMIN',
  );

  // Раздел «Интеграции» — под флагом FEATURE_ERP_INTEGRATION. Падение
  // запроса не должно ронять страницу настроек (деградируем до без раздела).
  const erpIntegrationEnabled = isErpIntegrationEnabled();
  const integrationSettings: IntegrationSettingsDto | null =
    erpIntegrationEnabled
      ? await getIntegrationSettings().catch(() => null)
      : null;
  const integrationsAvailable = erpIntegrationEnabled && integrationSettings != null;

  // Активная вкладка из URL. Неизвестное/недоступное значение → «org».
  const requestedTab = searchParams?.tab;
  const tab: TabKey =
    requestedTab === 'divisions' ||
    requestedTab === 'access' ||
    (requestedTab === 'integrations' && integrationsAvailable)
      ? (requestedTab as TabKey)
      : 'org';

  return (
    <AdminPageShell
      icon={<Settings size={22} strokeWidth={1.6} aria-hidden />}
      title="Настройки компании"
      subtitle="Реквизиты, подразделения и склад, доступ, интеграции"
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard compact>
        <div className="admin-tabs" role="tablist">
          <TabLink
            active={tab === 'org'}
            href="/admin/company-settings?tab=org"
            Icon={Building2}
            label="Организация"
          />
          <TabLink
            active={tab === 'divisions'}
            href="/admin/company-settings?tab=divisions"
            Icon={Layers}
            label="Подразделения и склад"
          />
          <TabLink
            active={tab === 'access'}
            href="/admin/company-settings?tab=access"
            Icon={ShieldCheck}
            label="Доступ"
          />
          {integrationsAvailable && (
            <TabLink
              active={tab === 'integrations'}
              href="/admin/company-settings?tab=integrations"
              Icon={Plug}
              label="Интеграции"
            />
          )}
        </div>
      </AdminCard>

      {tab === 'org' && settings && <CompanySettingsForm settings={settings} />}

      {tab === 'divisions' && (
        <>
          {settings && <MaterialStockSettingsForm settings={settings} />}
          {settings && <DivisionsSection divisions={divisions} />}
          {settings && (
            <MaterialStockDivisionOverridesSection
              divisions={divisions}
              settings={settings}
            />
          )}
        </>
      )}

      {tab === 'access' && (
        <EmployeeRolesSection
          employees={employees}
          canAssignAdmin={canAssignAdmin}
        />
      )}

      {tab === 'integrations' && integrationsAvailable && integrationSettings && (
        <IntegrationsSection settings={integrationSettings} />
      )}
    </AdminPageShell>
  );
}
