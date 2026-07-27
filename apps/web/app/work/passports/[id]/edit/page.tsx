import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { loadPassportEditData } from '@/lib/passport-edit-data';
import { EditPassportForm } from './edit-passport-form';

export const dynamic = 'force-dynamic';

/**
 * Страница редактирования паспорта помощника раскройщика
 * (`/work/passports/[id]/edit`).
 *
 * Поведение:
 *   - данные (паспорт + размерная матрица с остатками без самого
 *     паспорта + активные раскройщики) грузит общий
 *     `loadPassportEditData` — тот же, что у кабинета раскройщика
 *     `/cutter/passports/[id]/edit`. Логика остатков одна на два экрана;
 *   - `not-found` → 404, `not-editable` → возврат в список: backend всё
 *     равно отдаст 409 на PATCH, но без «битой» формы пользователь сразу
 *     видит свежий список;
 *   - для CUTTER_ASSISTANT/CUTTER select раскройщика скрыт, если смотрит
 *     сам CUTTER (та же логика, что на форме выпуска);
 *   - возврат — «← К списку выпущенных паспортов» (как и просили в ТЗ);
 *     из самого списка кнопка «← На рабочее место».
 */
export default async function WorkPassportEditPage({
  params,
}: {
  params: { id: string };
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect(`/login?next=/work/passports/${params.id}/edit`);

  const loaded = await loadPassportEditData(params.id, me.user.role);
  if (loaded.kind === 'not-found') notFound();
  if (loaded.kind === 'not-editable') redirect('/work/passports');

  return (
    <div>
      <div className="page-header">
        <h1>Редактирование паспорта {loaded.data.passportNumber}</h1>
        <Link className="btn" href="/work/passports">
          ← К списку выпущенных паспортов
        </Link>
      </div>
      <EditPassportForm {...loaded.data} />
    </div>
  );
}
