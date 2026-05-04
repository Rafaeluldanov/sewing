import { redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listOpenMasterCalls } from '@/lib/master-calls-api';
import { getActiveCutReleasePolicy } from '@/lib/cut-release-policy-api';
import { listSizes } from '@/lib/orders-api';
import { canSeeEmployeeQrButton, canSeeMasterPage } from '@/lib/rbac';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { MasterPageClient } from './master-page-client';

export const dynamic = 'force-dynamic';

/**
 * Мобильный экран мастера цеха (`/master`, MVP).
 *
 * Серверная часть:
 *   1) Гард сессии и роли (`canSeeMasterPage` — SHOPFLOOR_MASTER /
 *      ADMIN / SHOP_MANAGER, см. `apps/web/lib/rbac.ts` и
 *      `docs/screens.md §«/master»`);
 *   2) initial fetch очереди открытых вызовов
 *      (`GET /api/master-calls`); ошибка не валит экран — клиентская
 *      обёртка повторно попробует запрос polling'ом и покажет inline-
 *      ошибку.
 *
 * Вся интерактивность (polling + QR-сканер + resolve) живёт в
 * клиентском `MasterPageClient`.
 */
export default async function MasterPage() {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/master');
  if (!canSeeMasterPage(me.user.role)) redirect('/');

  let initialItems = null;
  let initialError: string | null = null;
  try {
    initialItems = await listOpenMasterCalls();
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    initialError = e.message;
  }

  // Stage 3 «Мастер цеха»: подтягиваем активную политику выдачи кроя
  // и справочник размеров для формы. Любая ошибка тут — soft-fail:
  // экран мастера и без блока ограничений должен открываться (вызовы
  // мастера — приоритет).
  let initialPolicy = null;
  let initialSizes: Awaited<ReturnType<typeof listSizes>> = [];
  try {
    const res = await getActiveCutReleasePolicy();
    initialPolicy = res.policy;
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
  }
  try {
    initialSizes = await listSizes();
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
  }

  return (
    <>
      <MasterPageClient
        initialItems={initialItems ?? []}
        initialError={initialError}
        initialPolicy={initialPolicy}
        sizes={initialSizes}
      />
      {canSeeEmployeeQrButton(me.user.role) ? (
        <EmployeeQrButton variant="floating" />
      ) : null}
    </>
  );
}
