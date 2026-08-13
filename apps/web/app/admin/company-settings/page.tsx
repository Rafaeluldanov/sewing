import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Building2, Factory, Layers, Plug, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type {
  CompanySettingsDto,
  OffRouteReadinessDto,
} from '@sewing/shared/company-settings';
import type { IntegrationSettingsDto } from '@sewing/shared/integration';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  getCompanySettings,
  getOffRouteReadiness,
  listCompanyDivisions,
} from '@/lib/company-settings-api';
import { getIntegrationSettings } from '@/lib/integration-api';
import { isAssistantEnabled, isErpIntegrationEnabled } from '@/lib/feature-flags';
import { AdminCard, AdminPageShell } from '@/components/admin';
import {
  CompanySettingsForm,
  MaterialStockSettingsForm,
} from './settings-form';
import { DivisionsSection } from './divisions-section';
import { MaterialStockDivisionOverridesSection } from './material-stock-division-overrides-section';
import { OffRoutePolicySection } from './off-route-policy-section';
import { AssistantSection } from './assistant-section';
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
 *   - `production`   — Производство: строгость гейта «работа мимо
 *                      маршрута». Отдельная вкладка, а не подпункт
 *                      «Подразделений и склада»: это правило
 *                      производственного потока, к материалам оно
 *                      отношения не имеет;
 *   - `integrations` — Интеграции: ERP upgifts (только под флагом
 *                      FEATURE_ERP_INTEGRATION, иначе вкладки нет).
 *
 * Вкладки «Доступ» (матрица «сотрудник → роли») здесь больше нет — она
 * переехала в «Персонал» (`/admin/employees?tab=access`, 11.08.2026):
 * доступы — данные про людей, а не разовая настройка организации.
 * Старый `?tab=access` из закладок редиректим на новое место, чтобы
 * человек не попал молча на «Организацию» и не решил, что фичу убрали.
 *
 * Backend GET `/api/company-settings` идемпотентно создаёт singleton-
 * строку, если её ещё нет (см. `CompanySettingsService.getOrCreate`),
 * поэтому страница всегда работает без отдельного сценария «первый запуск».
 *
 * RBAC — `SHOP_MANAGER` / `ADMIN` (на backend) + `app/admin/layout.tsx`
 * редиректит остальных пользователей.
 */

type TabKey = 'org' | 'divisions' | 'production' | 'integrations';

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
  // Закладки на уехавшую вкладку «Доступ» — сразу в «Персонал».
  if (searchParams?.tab === 'access') redirect('/admin/employees?tab=access');

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

  // Готовность к блокировке — вспомогательная read-модель поверх
  // AuditLog. Её падение не должно ронять страницу настроек: секция
  // просто покажется без блока цифр.
  const offRouteReadiness: OffRouteReadinessDto | null =
    await getOffRouteReadiness().catch(() => null);

  // Вкладка «Интеграции» — две независимые карточки под своими флагами:
  // ERP upgifts (FEATURE_ERP_INTEGRATION) и ассистент (FEATURE_AI_ASSISTANT).
  // Настройки у них общие (одна singleton-строка), поэтому грузим их, если
  // включена хотя бы одна. Падение запроса не должно ронять страницу
  // настроек — деградируем до вкладки без карточек.
  const erpIntegrationEnabled = isErpIntegrationEnabled();
  const assistantEnabled = isAssistantEnabled();
  const anyIntegrationEnabled = erpIntegrationEnabled || assistantEnabled;
  const integrationSettings: IntegrationSettingsDto | null =
    anyIntegrationEnabled
      ? await getIntegrationSettings().catch(() => null)
      : null;
  const integrationsAvailable =
    anyIntegrationEnabled && integrationSettings != null;

  // Активная вкладка из URL. Неизвестное/недоступное значение → «org».
  const requestedTab = searchParams?.tab;
  const tab: TabKey =
    requestedTab === 'divisions' ||
    requestedTab === 'production' ||
    (requestedTab === 'integrations' && integrationsAvailable)
      ? (requestedTab as TabKey)
      : 'org';

  return (
    <AdminPageShell
      icon={<Settings size={22} strokeWidth={1.6} aria-hidden />}
      title="Настройки компании"
      subtitle="Реквизиты, подразделения и склад, производство, интеграции"
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
            active={tab === 'production'}
            href="/admin/company-settings?tab=production"
            Icon={Factory}
            label="Производство"
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

      {tab === 'production' && settings && (
        <OffRoutePolicySection
          settings={settings}
          readiness={offRouteReadiness}
        />
      )}

      {tab === 'integrations' && integrationsAvailable && integrationSettings && (
        <>
          {erpIntegrationEnabled && (
            <IntegrationsSection settings={integrationSettings} />
          )}
          {assistantEnabled && (
            <AssistantSection settings={integrationSettings} />
          )}
        </>
      )}
    </AdminPageShell>
  );
}
