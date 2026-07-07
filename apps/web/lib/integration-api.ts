/**
 * Серверные обёртки над `/api/integrations/*` (модуль «Интеграции»,
 * связь с внешним ERP upgifts). См. `apps/api/src/modules/integrations/*`
 * и `docs/upgifts-integration.md`.
 *
 * Используется из RSC `/admin/company-settings` и из server actions
 * раздела «Интеграции». Контракты — Zod-схемы из
 * `@sewing/shared/integration`, что валидирует backend. Пароль
 * сервисного аккаунта наружу не приходит (в DTO только `hasPassword`).
 */
import type {
  IntegrationSettingsDto,
  UpdateIntegrationSettingsDto,
  UpgiftsTestConnectionResult,
} from '@sewing/shared/integration';
import { apiFetch } from './api';

export function getIntegrationSettings(): Promise<IntegrationSettingsDto> {
  return apiFetch<IntegrationSettingsDto>('/integrations/settings', {
    cache: 'no-store',
  });
}

export function updateIntegrationSettings(
  body: UpdateIntegrationSettingsDto,
): Promise<IntegrationSettingsDto> {
  return apiFetch<IntegrationSettingsDto>('/integrations/settings', {
    method: 'PATCH',
    body,
  });
}

export function testUpgiftsConnection(): Promise<UpgiftsTestConnectionResult> {
  return apiFetch<UpgiftsTestConnectionResult>(
    '/integrations/upgifts/test-connection',
    { method: 'POST' },
  );
}
