import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FolderPen } from 'lucide-react';
import type { PatternCategoryDto } from '@sewing/shared/pattern-categories';
import { ApiRequestError } from '@/lib/api';
import { getPatternCategory } from '@/lib/pattern-categories-api';
import { AdminCard, AdminPageShell } from '@/components/admin';
import { EditPatternCategoryForm } from './edit-pattern-category-form';

export const dynamic = 'force-dynamic';

/**
 * Страница «Редактировать категорию номенклатуры»
 * (`/admin/pattern-categories/[id]`).
 *
 * Связанная UX-точка: чип-фильтра в `/admin/patterns` теперь рисует
 * скрытую иконку Pencil поверх крупной плитки категории. Hover над
 * чипом → ссылка на эту страницу. Сам клик по чипу остаётся фильтром
 * списка лекал, чтобы не ломать привычный поток (см. требования
 * этапа «Редактируемые категории»).
 *
 * RBAC и API-контракт остаются прежними:
 *   - GET    /api/pattern-categories/:id
 *   - PATCH  /api/pattern-categories/:id
 *   - PUT    /api/pattern-categories/:id/parameters
 *   - POST   /api/pattern-categories/:id/icon
 *   - DELETE /api/pattern-categories/:id
 *
 * Никаких новых эндпоинтов и Prisma-миграций здесь не добавляется.
 */
export default async function AdminEditPatternCategoryPage({
  params,
}: {
  params: { id: string };
}) {
  let category: PatternCategoryDto;
  try {
    category = await getPatternCategory(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      notFound();
    }
    throw e;
  }

  return (
    <AdminPageShell
      icon={<FolderPen size={22} strokeWidth={1.6} aria-hidden />}
      title="Редактировать категорию"
      subtitle={category.name}
      actions={
        <Link href="/admin/patterns" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К номенклатуре
        </Link>
      }
    >
      <AdminCard>
        <EditPatternCategoryForm category={category} />
      </AdminCard>
    </AdminPageShell>
  );
}
