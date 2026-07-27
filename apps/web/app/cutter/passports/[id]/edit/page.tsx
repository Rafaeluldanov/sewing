import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { loadPassportEditData } from '@/lib/passport-edit-data';
import { EditPassportForm } from '@/app/work/passports/[id]/edit/edit-passport-form';
import { requireActiveCutterShift } from '../../../require-shift';

export const dynamic = 'force-dynamic';

/**
 * Правка только что выпущенного паспорта в кабинете раскройщика
 * (`/cutter/passports/[id]/edit`). Серверный компонент.
 *
 * Зачем отдельный роут под `/cutter`, а не переход на `/work/passports/...`:
 * чистая учётка `CUTTER` заперта middleware на префикс `/cutter`
 * (см. `apps/web/middleware.ts`). Сама форма при этом НЕ дублируется —
 * переиспользуем клиентский `EditPassportForm` помощника, передав
 * `backHref="/cutter/passports"` и `homeHref="/cutter"`: правила правки
 * (размер, дата кроя, количество в пределах остатка, номер рулона) у
 * раскройщика и помощника одни и те же, различается навигация вокруг.
 * PATCH делает общий server action `updateMyPassportAction`, который
 * ревалидирует оба списка.
 *
 * Данные готовит общий `loadPassportEditData` — включая главное правило:
 * остаток по размеру считается БЕЗ самого правимого паспорта, иначе
 * сохранение того же количества упиралось бы в собственное прежнее
 * значение. Ответы загрузчика переводим в свою навигацию:
 *   - `not-found` → 404 (паспорт удалён/чужая ссылка);
 *   - `not-editable` → назад в список: паспорт уже в ячейке или двинулся
 *     по операциям, backend такой PATCH всё равно закроет 409
 *     `PASSPORT_NOT_EDITABLE`, и раскройщику полезнее увидеть свежий
 *     список, чем форму, которая не сохранится.
 *
 * `creatorIsCutter` приходит из роли смотрящего: у раскройщика select
 * «Раскройщик» скрыт — начисление за раскрой и так его.
 *
 * RBAC раздела держит `apps/web/app/cutter/layout.tsx` (`canSeeCutter`);
 * «свой ли это паспорт» проверяет backend по `creatorId`.
 */
export default async function CutterPassportEditPage({
  params,
}: {
  params: { id: string };
}) {
  await requireActiveCutterShift();

  const me = await getCurrentUserOrNull();
  if (!me) redirect(`/login?next=/cutter/passports/${params.id}/edit`);

  const loaded = await loadPassportEditData(params.id, me.user.role);
  if (loaded.kind === 'not-found') notFound();
  if (loaded.kind === 'not-editable') redirect('/cutter/passports');

  return (
    <div className="constructor-detail">
      <Link href="/cutter/passports" className="constructor-back">
        ← К выпущенным паспортам
      </Link>

      <header className="constructor-detail__head">
        <div>
          <h1 className="constructor-detail__title">
            Правка паспорта {loaded.data.passportNumber}
          </h1>
          <div className="constructor-detail__article">
            {loaded.data.productName} · {loaded.data.color} · заказ{' '}
            {loaded.data.orderNumber}
          </div>
        </div>
      </header>

      <EditPassportForm
        {...loaded.data}
        backHref="/cutter/passports"
        homeHref="/cutter"
      />
    </div>
  );
}
