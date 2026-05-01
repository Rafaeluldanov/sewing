import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { RoleHeaderCard } from '@/components/role-header-card';
import { WtoTerminal } from './wto-terminal';

export const dynamic = 'force-dynamic';

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SHOP_MANAGER: 'Начальник цеха',
  IRONING: 'ВТО',
};

/**
 * WTO primary workspace — scan-driven терминал по той же модели, что
 * `/qc` для ОТК (см. `apps/web/app/qc/qc-terminal.tsx`).
 *
 * Страница только подтягивает личные данные сотрудника для шапки;
 * вся интерактивная логика — в client-компоненте `WtoTerminal`.
 * Поведение и инварианты описаны в `docs/screens.md §10` и
 * `docs/flows.md §F6`.
 */
export default async function WtoPage() {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/wto');

  const roleLabel = ROLE_LABELS[me.user.role] ?? me.user.role;

  return (
    <div className="work work--seamstress">
      <RoleHeaderCard
        name={me.user.fullName}
        role={roleLabel}
        statusText="Готов к сканированию"
      />
      <WtoTerminal />
    </div>
  );
}
