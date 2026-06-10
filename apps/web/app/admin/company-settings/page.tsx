import { Settings } from 'lucide-react';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { CompanySettingsDto } from '@sewing/shared/company-settings';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  getCompanySettings,
  listCompanyDivisions,
} from '@/lib/company-settings-api';
import { AdminPageShell } from '@/components/admin';
import { CompanySettingsForm } from './settings-form';
import { DivisionsSection } from './divisions-section';
import { MaterialStockDivisionOverridesSection } from './material-stock-division-overrides-section';

export const dynamic = 'force-dynamic';

/**
 * Страница «Настройки компании» (`/admin/company-settings`).
 *
 * Один экран на весь блок (по дизайну «Вариант A» — без отдельных
 * detail-страниц на каждую сущность):
 *   - три карточки реквизитов (`CompanySettingsForm`);
 *   - карточка «Подразделения» (`DivisionsSection`).
 *
 * Backend GET `/api/company-settings` идемпотентно создаёт singleton-
 * строку, если её ещё нет (см. `CompanySettingsService.getOrCreate`),
 * поэтому страница всегда работает без отдельного сценария «первый
 * запуск».
 *
 * `GET /api/company-divisions?includeInactive=true` подгружает все
 * карточки (активные + отключённые) — фильтрацией/группировкой
 * занимается клиентская секция `DivisionsSection`.
 *
 * RBAC — `SHOP_MANAGER` / `ADMIN` (на backend) + `app/admin/layout.tsx`
 * редиректит остальных пользователей.
 */
export default async function AdminCompanySettingsPage() {
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

  return (
    <AdminPageShell
      icon={<Settings size={22} strokeWidth={1.6} aria-hidden />}
      title="Настройки компании"
      subtitle="Реквизиты организации, контакты, банк и подразделения"
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {settings && <CompanySettingsForm settings={settings} />}
      {settings && (
        <MaterialStockDivisionOverridesSection
          divisions={divisions}
          settings={settings}
        />
      )}
      {settings && <DivisionsSection divisions={divisions} />}
    </AdminPageShell>
  );
}
