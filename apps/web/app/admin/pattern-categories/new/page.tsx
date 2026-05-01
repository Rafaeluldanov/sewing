import Link from 'next/link';
import { ArrowLeft, FolderPlus } from 'lucide-react';
import {
  AdminCard,
  AdminPageShell,
} from '@/components/admin';
import { CreatePatternCategoryForm } from './create-pattern-category-form';

export const dynamic = 'force-dynamic';

/**
 * Страница «Создать категорию номенклатуры»
 * (`/admin/pattern-categories/new`).
 *
 * Эта страница пришла на смену удалённой модалке «Добавить категорию»
 * на `/admin/patterns` (этап «Загружаемая JPEG-иконка категории» —
 * ТЗ §«Убрать модальное окно»). Доступ к странице — через кнопку
 * «Добавить категорию» в каталоге номенклатуры; отдельного пункта в
 * sidebar НЕ заводим (см. ТЗ §«Не делать»).
 *
 * UI разделён на три блока (Основное / Иконка / Параметры) — все
 * рендерятся одним form-а в client-component
 * `create-pattern-category-form.tsx`. Страница лишь рисует layout и
 * подключает форму. Нагрузка категорий / лекал не нужна — backend
 * сам генерирует slug и сам валидирует параметры.
 */
export default async function AdminCreatePatternCategoryPage() {
  return (
    <AdminPageShell
      icon={<FolderPlus size={22} strokeWidth={1.6} aria-hidden />}
      title="Добавить категорию"
      subtitle="Категория определяет параметры, которые заполняются в номенклатуре."
      actions={
        <Link href="/admin/patterns" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
          К номенклатуре
        </Link>
      }
    >
      <AdminCard>
        <CreatePatternCategoryForm />
      </AdminCard>
    </AdminPageShell>
  );
}
