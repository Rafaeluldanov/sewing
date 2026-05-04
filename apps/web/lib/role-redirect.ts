/**
 * Единый helper «куда отправить роль после login / при заходе на `/`».
 *
 * Отличается от `getPrimaryWorkspace` (см. `apps/web/lib/rbac.ts`)
 * только для ADMIN / SHOP_MANAGER: `getPrimaryWorkspace` исторически
 * возвращает им `/`, потому что когда-то корневая страница была
 * многосекционной домашней. После cleanup-а старого dashboard-а
 * (см. `docs/auth-design-cleanup-recon.md`) у `/` нет UI — это просто
 * редирект; админ-landing теперь живёт на `/admin`.
 *
 * Поэтому:
 *   - `getPrimaryWorkspace('ADMIN') === '/'` — остаётся как есть, на
 *     него опираются `app/page.tsx` через старый `isWorkingRole` (был)
 *     и тесты RBAC-матрицы;
 *   - `getDefaultRouteForRole('ADMIN') === '/admin'` — новый контракт
 *     для post-login и для `/`.
 *
 * Для unknown / null возвращаем `/login` — это безопасный «иди
 * представься» fallback, а не `/` (иначе получится цикл, если на `/`
 * висит редирект, использующий этот же helper).
 */
import { getPrimaryWorkspace } from './rbac';

const ADMIN_HOME_PATH = '/admin';
const ANON_PATH = '/login';

export function getDefaultRouteForRole(
  role: string | null | undefined,
): string {
  if (!role) return ANON_PATH;
  if (role === 'ADMIN' || role === 'SHOP_MANAGER') return ADMIN_HOME_PATH;
  const primary = getPrimaryWorkspace(role);
  // Если primary workspace — корень `/`, значит роль unknown / без
  // явного маппинга в `PRIMARY_WORKSPACE_BY_ROLE`. Возвращаем `/login`
  // вместо `/`, чтобы не замкнуть цикл редиректов (root тоже зовёт
  // этот хелпер, см. `apps/web/app/page.tsx`).
  if (primary === '/') return ANON_PATH;
  return primary;
}
