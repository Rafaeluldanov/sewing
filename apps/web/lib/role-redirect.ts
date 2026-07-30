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
const SUPERADMIN_HOME_PATH = '/superadmin';
const ANON_PATH = '/login';

/**
 * @param role       основная (или активная) роль сотрудника
 * @param workspace  рабочий экран из `/api/auth/me`
 *                   (`AuthUserDto.workspace`, считается сервером по
 *                   справочнику `AppRole`). ОБЯЗАТЕЛЕН для кастомных
 *                   ролей: их кодов нет в захардкоженной матрице
 *                   `PRIMARY_WORKSPACE_BY_ROLE`, и без этого параметра
 *                   роль «Технолог» получила бы `/login` вместо своего
 *                   экрана — то есть не смогла бы войти.
 */
export function getDefaultRouteForRole(
  role: string | null | undefined,
  workspace?: string | null,
): string {
  if (!role) return ANON_PATH;
  // Супер-админ control-plane (мультитенантность) — отдельный landing.
  if (role === 'SUPERADMIN') return SUPERADMIN_HOME_PATH;
  if (role === 'ADMIN' || role === 'SHOP_MANAGER') return ADMIN_HOME_PATH;
  // Экран с сервера приоритетнее: он знает и про роли из `/admin/roles`.
  // Корень `/` от него не отличается от «не задан» — обрабатываем ниже.
  const primary =
    workspace && workspace !== '/' ? workspace : getPrimaryWorkspace(role);
  // Если primary workspace — корень `/`, значит роль без явного
  // рабочего экрана (кастомная роль с `workspace = '/'` или unknown).
  // Такую роль ведём в админ-landing, если сервер дал ей `/`, и на
  // `/login` — если роль вообще неизвестна. `/` не возвращаем никогда,
  // чтобы не замкнуть цикл: root зовёт этот же хелпер (`app/page.tsx`).
  if (primary === '/') return workspace === '/' ? ADMIN_HOME_PATH : ANON_PATH;
  return primary;
}
