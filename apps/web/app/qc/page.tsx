import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listDefectTypes } from '@/lib/qc-api';
import { RoleHeaderCard } from '@/components/role-header-card';
import { QcTerminal } from './qc-terminal';

export const dynamic = 'force-dynamic';

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SHOP_MANAGER: 'Начальник цеха',
  QC: 'ОТК',
};

/**
 * QC primary workspace — scan-driven терминал по той же модели, что
 * `/work` для швеи (см. `apps/web/app/work/seamstress-active-panel.tsx`).
 *
 * Страница только подтягивает справочник видов брака и личные данные
 * сотрудника для шапки; вся интерактивная логика — в client-компоненте
 * `QcTerminal`. Поведение и инварианты описаны в `docs/screens.md §5`
 * и `docs/flows.md §F5`.
 */
export default async function QcPage() {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/qc');

  const defectTypes = await listDefectTypes();
  const roleLabel = ROLE_LABELS[me.user.role] ?? me.user.role;

  return (
    <div className="work work--seamstress">
      <RoleHeaderCard
        name={me.user.fullName}
        role={roleLabel}
        statusText="Готов к сканированию"
      />
      <QcTerminal defectTypes={defectTypes} />
    </div>
  );
}
