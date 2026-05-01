/**
 * Browser-safe лейблы статусов паспорта.
 *
 * Вынесено из `lib/passports-api.ts`, чтобы клиентские компоненты
 * (например, `app/qc/qc-work-card.tsx`) могли импортировать константу
 * без затягивания серверного `apiFetch` → `next/headers`. Серверная
 * сторона по-прежнему получает символ через re-export из
 * `lib/passports-api.ts` — никаких изменений в RSC-импортерах не нужно.
 */

import type { PassportStatus } from '@sewing/shared/passports';

export const PASSPORT_STATUS_LABELS: Record<PassportStatus, string> = {
  CREATED: 'Создан',
  IN_PROGRESS: 'В пошиве',
  PACKED: 'Упакован',
  CANCELLED: 'Отменён',
};
