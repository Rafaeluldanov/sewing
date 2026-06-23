import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { canSeeSuperadmin } from '@/lib/rbac';

/**
 * Раздел супер-админа control-plane (мультитенантность, Фаза 4).
 *
 * Отдельный от `/admin` (тот тенант-скоупный): здесь управление РЕЕСТРОМ
 * тенантов. Доступ строго по роли `SUPERADMIN` (НЕ обычный ADMIN) — зеркалит
 * SuperadminGuard на бэкенде. Если control-plane выключен, API вернёт 404 на
 * запросах — страница покажет ошибку загрузки.
 */
export default async function SuperadminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/superadmin');
  if (!canSeeSuperadmin(me.user.roles ?? me.user.role)) redirect('/');
  return (
    <div className="admin-layout">
      <div className="admin-layout__content" style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 0 4px',
            color: 'var(--admin-muted, #667085)',
          }}
        >
          <ShieldCheck size={18} strokeWidth={1.6} aria-hidden />
          <Link href="/superadmin" style={{ fontWeight: 600 }}>
            Control-plane · Тенанты
          </Link>
          <span style={{ marginLeft: 'auto', fontSize: 13 }}>{me.user.fullName}</span>
        </div>
        {children}
      </div>
    </div>
  );
}
