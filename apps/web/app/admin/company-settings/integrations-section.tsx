'use client';

import { useFormState, useFormStatus } from 'react-dom';
import {
  CheckCircle,
  Plug,
  RefreshCw,
  Save,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { IntegrationSettingsDto } from '@sewing/shared/integration';
import { AdminCard, AdminSectionHeader } from '@/components/admin';
import {
  testUpgiftsConnectionAction,
  updateIntegrationSettingsAction,
} from './integrations-actions';
import {
  initialTestUpgiftsConnectionState,
  initialUpdateIntegrationSettingsState,
  type TestUpgiftsConnectionState,
  type UpdateIntegrationSettingsState,
} from './integration-form-state';

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

function TestButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--ghost"
      disabled={pending}
    >
      <RefreshCw size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Проверяем…' : 'Проверить соединение'}
    </button>
  );
}

/**
 * Статус подключения из СОХРАНЁННЫХ настроек (не из текущих правок формы).
 * Одна строка-баннер вверху карточки: выключено / включено-не-проверено /
 * подключено / ошибка последней проверки.
 */
function StatusBanner({ settings }: { settings: IntegrationSettingsDto }) {
  const lastOk = settings.lastConnectionOkAt
    ? new Date(settings.lastConnectionOkAt).toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
      })
    : null;

  if (!settings.upgiftsEnabled) {
    return (
      <div className="admin-integration-status admin-integration-status--off">
        <Plug size={16} strokeWidth={1.6} aria-hidden />
        Интеграция выключена
      </div>
    );
  }
  if (settings.lastConnectionError) {
    return (
      <div className="admin-integration-status admin-integration-status--error">
        <XCircle size={16} strokeWidth={1.6} aria-hidden />
        Последняя проверка не удалась: {settings.lastConnectionError}
      </div>
    );
  }
  if (lastOk) {
    return (
      <div className="admin-integration-status admin-integration-status--ok">
        <CheckCircle size={16} strokeWidth={1.6} aria-hidden />
        Подключено · проверено {lastOk} (МСК)
      </div>
    );
  }
  return (
    <div className="admin-integration-status admin-integration-status--warn">
      <RefreshCw size={16} strokeWidth={1.6} aria-hidden />
      Включено, соединение ещё не проверялось
    </div>
  );
}

/** Форма настроек подключения к upgifts. */
function SettingsForm({ settings }: { settings: IntegrationSettingsDto }) {
  const [state, formAction] = useFormState<
    UpdateIntegrationSettingsState,
    FormData
  >(updateIntegrationSettingsAction, initialUpdateIntegrationSettingsState);

  return (
    <form action={formAction} className="admin-stack" style={{ gap: 14 }}>
      <label className="admin-toggle-row">
        <span className="admin-toggle-row__text">
          <strong>Интеграция включена</strong>
          <span className="admin-field__hint">
            Продукты работают автономно — данные передаются в upgifts, только
            когда включено.
          </span>
        </span>
        <span className="admin-switch">
          {/* hidden-marker: браузер не шлёт unchecked-checkbox */}
          <input type="hidden" name="upgiftsEnabled__present" value="1" />
          <input
            type="checkbox"
            name="upgiftsEnabled"
            defaultChecked={settings.upgiftsEnabled}
          />
          <span className="admin-switch__track" aria-hidden />
          <span className="admin-switch__thumb" aria-hidden />
        </span>
      </label>

      <div className="admin-subhead">Учётные данные подключения</div>
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="upgifts-base-url">Base URL API upgifts</label>
          <input
            id="upgifts-base-url"
            name="upgiftsBaseUrl"
            type="url"
            inputMode="url"
            maxLength={500}
            placeholder="https://erp.upgifts.ru"
            defaultValue={settings.upgiftsBaseUrl ?? ''}
            autoComplete="off"
          />
          <span className="admin-field__hint">
            Адрес REST API upgifts (без завершающего слэша).
          </span>
        </div>
        <div className="admin-field">
          <label htmlFor="upgifts-tenant">Тенант upgifts</label>
          <input
            id="upgifts-tenant"
            name="upgiftsTenant"
            type="text"
            maxLength={200}
            placeholder="tenant / slug"
            defaultValue={settings.upgiftsTenant ?? ''}
            autoComplete="off"
          />
          <span className="admin-field__hint">
            Поле «tenant» при логине сервисного аккаунта.
          </span>
        </div>
        <div className="admin-field">
          <label htmlFor="upgifts-email">Email сервисного аккаунта</label>
          <input
            id="upgifts-email"
            name="upgiftsEmail"
            type="email"
            maxLength={200}
            placeholder="integration@your-org.ru"
            defaultValue={settings.upgiftsEmail ?? ''}
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="upgifts-password">Пароль сервисного аккаунта</label>
          <input
            id="upgifts-password"
            name="upgiftsPassword"
            type="password"
            maxLength={300}
            placeholder={
              settings.hasPassword
                ? '•••••••• (оставьте пустым, чтобы не менять)'
                : 'Пароль сервисного аккаунта'
            }
            autoComplete="new-password"
          />
          <span className="admin-field__hint">
            Хранится в зашифрованном виде. Наружу не показывается.
          </span>
        </div>
        <div className="admin-field">
          <label htmlFor="upgifts-org-id">organization_id (опц.)</label>
          <input
            id="upgifts-org-id"
            name="upgiftsOrganizationId"
            type="text"
            maxLength={100}
            placeholder="UUID организации в upgifts"
            defaultValue={settings.upgiftsOrganizationId ?? ''}
            autoComplete="off"
          />
          <span className="admin-field__hint">
            Организация по умолчанию (нужна части операций, напр. запись
            себестоимости).
          </span>
        </div>
      </div>

      <p className="admin-note">
        <ShieldCheck size={16} strokeWidth={1.6} aria-hidden />
        Пароль сервисного аккаунта хранится в зашифрованном виде и наружу не
        показывается.
      </p>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
        </div>
      )}

      <div className="admin-actions-row">
        <SaveButton />
      </div>
    </form>
  );
}

/** Блок «Проверить соединение» + итог текущей/сохранённой проверки. */
function ConnectionCheck({ settings }: { settings: IntegrationSettingsDto }) {
  const [state, formAction] = useFormState<
    TestUpgiftsConnectionState,
    FormData
  >(testUpgiftsConnectionAction, initialTestUpgiftsConnectionState);

  return (
    <div className="admin-stack" style={{ gap: 10 }}>
      <div className="admin-subhead">Проверка соединения</div>
      <div className="admin-actions-row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <form action={formAction}>
          <TestButton />
        </form>
        <span className="admin-field__hint">
          Проверка использует сохранённые настройки — сначала сохраните
          изменения.
        </span>
      </div>

      {/* Итог текущей проверки (из server action) */}
      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}
      {state.result && state.result.ok && (
        <div className="success-box" role="status">
          <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.result.message}
          {state.result.principal && (
            <span className="admin-muted" style={{ marginLeft: 8 }}>
              (tenant {state.result.principal.tenantId ?? '—'},{' '}
              {state.result.principal.scopesCount} scope-ов)
            </span>
          )}
        </div>
      )}
      {state.result && !state.result.ok && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.result.message}
        </div>
      )}
    </div>
  );
}

/**
 * Карточка-секция «Интеграция с ERP upgifts» (вкладка «Интеграции»
 * на `/admin/company-settings`). Под флагом `FEATURE_ERP_INTEGRATION`
 * (см. `apps/web/lib/feature-flags.ts::isErpIntegrationEnabled`).
 *
 * Фаза 1: подключение сервисного аккаунта per-org + «Проверить
 * соединение». Обмен данными (заказы/статусы/себестоимость) —
 * следующие фазы, см. `docs/upgifts-integration.md`.
 */
export function IntegrationsSection({
  settings,
}: {
  settings: IntegrationSettingsDto;
}) {
  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<Plug size={18} strokeWidth={1.6} aria-hidden />}
        title="Интеграция с ERP upgifts"
        hint="Обмен заказами, статусами и себестоимостью с erp.upgifts.ru"
      />

      <StatusBanner settings={settings} />
      <SettingsForm settings={settings} />
      <hr className="admin-hr" />
      <ConnectionCheck settings={settings} />
    </AdminCard>
  );
}
