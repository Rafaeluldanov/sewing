/**
 * Серверный helper для рантайм-набора модулей тенанта.
 *
 * Под мультитенантность (Фаза 1) флаги модулей больше НЕ зашиты в web-билд
 * (`NEXT_PUBLIC_FEATURE_*`), а приходят с сервера через `GET /api/auth/me`
 * (поле `modules`). Этот helper достаёт их для server-компонентов/страниц,
 * которым нужно гейтить inline-блоки (карточки заказа/потребности и т. п.).
 *
 * ВАЖНО: модуль server-only (тянет `auth-api` → `next/headers`). НЕ
 * импортировать из client-компонентов — им `modules` передаются пропсом
 * (см. `components/admin-sidebar.tsx`).
 */
import { getCurrentUserOrNull } from './auth-api';
import { FEATURE_MODULE_KEYS, type ModuleFlags } from '@sewing/shared/auth';

/** Фолбэк «всё включено» (default-on), если сессии/ответа нет. */
export const MODULES_ALL_ON: ModuleFlags = Object.fromEntries(
  FEATURE_MODULE_KEYS.map((key) => [key, true]),
) as ModuleFlags;

/**
 * Набор включённых модулей для текущего запроса. При отсутствии сессии
 * (или ответа `/auth/me`) — default-on, чтобы не прятать готовый UI.
 */
export async function getModules(): Promise<ModuleFlags> {
  const me = await getCurrentUserOrNull();
  return me?.modules ?? MODULES_ALL_ON;
}
