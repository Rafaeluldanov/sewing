import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { MyPassportListItem } from '@sewing/shared/passports';
import { ApiRequestError, errorText } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listMyRecentPassports } from '@/lib/passports-api';
import { MyPassportRow } from '@/app/work/passports/my-passport-row';
import { requireActiveCutterShift } from '../require-shift';

export const dynamic = 'force-dynamic';

/**
 * «Выпущенные паспорта» кабинета раскройщика (`/cutter/passports`).
 * Серверный компонент.
 *
 * Зачем экран: раскройщик теперь ВЫПУСКАЕТ паспорта сам (вкладка «Выпуск»
 * → `/cutter/release/[orderId]`), а значит он же должен уметь исправить
 * опечатку или удалить лишний паспорт — пока тот ещё «свежий»
 * (`status=CREATED`, без ячейки, без событий кроме CREATED). Раньше это
 * умел только помощник на `/work/passports`, куда чистой учётке `CUTTER`
 * хода нет: middleware запирает её на префикс `/cutter`
 * (см. `apps/web/middleware.ts`).
 *
 * Данные — `GET /api/passports/my-recent` (`listMyRecentPassports`):
 * последние паспорта, выпущенные САМИМ actor-ом. Роль `CUTTER` у ручки уже
 * в `@Roles`. Флаги `editable` / `editableBlockReason` считает backend —
 * фронт только гасит кнопки, чтобы раскройщик не ловил глухую 409
 * `PASSPORT_NOT_EDITABLE`.
 *
 * Дублирования нет: строку списка рендерит общий
 * `@/app/work/passports/my-passport-row` (ему передан `basePath`, чтобы
 * «Редактировать» вело в `/cutter/passports/[id]/edit`), удаление и правку
 * делают те же server actions `app/work/passports/actions.ts`.
 *
 * Это НЕ вкладка верхнего уровня (вкладок три: Раскрой · Выпуск ·
 * Стеллаж) — экран-ребёнок «Выпуска», поэтому у него своя ссылка назад
 * «← К очереди выпуска», как у формы выпуска `/cutter/release/[orderId]`.
 *
 * Аутентификацию и RBAC держит `apps/web/app/cutter/layout.tsx`
 * (`canSeeCutter` + redirect); проверка `me` здесь нужна только чтобы не
 * дёргать API без сессии. Загрузка fail-soft на `ApiRequestError`: сбой
 * ручки показываем баннером, экран не падает — раскройщику важнее видеть
 * навигацию, чем страницу ошибки.
 */
export default async function CutterMyPassportsPage() {
  // Экран-ребёнок «Выпуска» — тот же гейт смены, что у вкладок.
  await requireActiveCutterShift();

  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/cutter/passports');

  let items: MyPassportListItem[] = [];
  let error: string | null = null;
  try {
    items = await listMyRecentPassports();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить список выпущенных паспортов';
  }

  return (
    <div className="constructor-detail">
      <Link href="/cutter/release" className="constructor-back">
        ← К очереди выпуска
      </Link>

      <header className="constructor-detail__head">
        <div>
          <h1 className="constructor-detail__title">Выпущенные паспорта</h1>
          <div className="constructor-detail__article">
            Ваши последние выпуски — можно поправить или удалить, пока паспорт
            не размещён в ячейке и не пошёл по операциям.
          </div>
        </div>
      </header>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {!error && items.length === 0 && (
        <div className="cut-orders__empty" role="status">
          <div className="cut-orders__empty-title">
            Пока нет выпущенных паспортов
          </div>
          <p className="cut-orders__empty-hint">
            Паспорта появятся здесь сразу после выпуска на вкладке «Выпуск» —
            и пока они не размещены в ячейке, их можно отредактировать или
            удалить.
          </p>
          <Link href="/cutter/release" className="btn btn-block">
            ← К очереди выпуска
          </Link>
        </div>
      )}

      {!error && items.length > 0 && (
        <ul
          className="my-passports-list cutter-passports"
          aria-label="Список выпущенных паспортов"
        >
          {items.map((p) => (
            <MyPassportRow key={p.id} item={p} basePath="/cutter/passports" />
          ))}
        </ul>
      )}
    </div>
  );
}
