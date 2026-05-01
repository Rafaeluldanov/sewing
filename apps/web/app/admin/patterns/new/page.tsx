import Link from 'next/link';
import { ArrowLeft, Scissors } from 'lucide-react';
import type { PatternCategoryListItemDto } from '@sewing/shared/pattern-categories';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
} from '@/components/admin';
import { listPatternCategories } from '@/lib/pattern-categories-api';
import { CreatePatternForm } from '../create-form';

export const dynamic = 'force-dynamic';

/**
 * Создание лекала (`/admin/patterns/new`).
 *
 * Backend / DTO простой: имя и артикул обязательны, остальное
 * опционально. После успеха server action редиректит на
 * `/admin/patterns/[id]`, чтобы менеджер сразу подгрузил превью /
 * DXF-файлы / площади материалов.
 *
 * Этап «Категории номенклатуры»: подгружаем активные категории, чтобы
 * форма могла отрисовать select. Если категории не загружены /
 * не созданы, форма всё равно работает — `categoryId` опционален.
 */
export default async function AdminPatternNewPage() {
  let categories: PatternCategoryListItemDto[] = [];
  try {
    categories = await listPatternCategories({ status: 'ACTIVE' });
  } catch {
    categories = [];
  }
  return (
    <AdminPageShell
      icon={<Scissors size={22} strokeWidth={1.6} aria-hidden />}
      title="Новое лекало"
      subtitle="Минимум: название и артикул. Превью и DXF загрузите в карточке."
      actions={
        <Link href="/admin/patterns" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader title="Параметры" />
        <CreatePatternForm categories={categories} />
      </AdminCard>
    </AdminPageShell>
  );
}
