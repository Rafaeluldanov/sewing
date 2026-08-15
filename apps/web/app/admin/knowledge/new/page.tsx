import Link from 'next/link';
import { ArrowLeft, BookOpen } from 'lucide-react';
import { AdminCard, AdminPageShell } from '@/components/admin';
import { listAppRolesSafe } from '@/lib/app-roles-api';
import { KnowledgeArticleForm } from '../article-form.client';

export const dynamic = 'force-dynamic';

/**
 * Новая статья базы знаний.
 *
 * Роли тянем справочником тенанта, а не константой: набор ролей у
 * каждого свой (см. `/admin/roles`), и захардкоженный список рано или
 * поздно разошёлся бы с реальностью.
 */
export default async function NewKnowledgeArticlePage() {
  const roles = await listAppRolesSafe();

  return (
    <AdminPageShell
      icon={<BookOpen size={22} strokeWidth={1.6} aria-hidden />}
      title="Новая статья"
      subtitle="Справка компании — то, чего нет ни в коде, ни в документации"
      actions={
        <Link href="/admin/knowledge" className="admin-btn">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
        </Link>
      }
    >
      <AdminCard>
        <KnowledgeArticleForm
          roles={roles.map((r) => ({ code: r.code, name: r.name }))}
        />
      </AdminCard>
    </AdminPageShell>
  );
}
