import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listMyRecentPassports } from '@/lib/passports-api';
import { MyPassportRow } from './my-passport-row';

export const dynamic = 'force-dynamic';

/**
 * Страница «Выпущенные паспорта» помощника раскройщика
 * (`/work/passports`).
 *
 * Источник истины — `GET /api/passports/my-recent` (последние 100
 * паспортов, выпущенных самим actor-ом). Контракт `editable` /
 * `editableBlockReason` приходит уже посчитанным с backend, фронт
 * только переводит код в подсказку и гасит кнопки.
 *
 * Разметка строки живёт в `./my-passport-row` — тот же компонент
 * рендерит список раскройщика `/cutter/passports` (у чистой учётки
 * `CUTTER` свой префикс, см. `apps/web/middleware.ts`). Дублировать
 * строку было нельзя: правила «что показываем / когда гасим кнопки»
 * должны меняться в одном месте.
 *
 * Навигация (как в ТЗ):
 *   - «← На рабочее место» — возврат на /work (тот же стиль кнопки
 *     назад, что и на /work/cut-orders);
 *   - клик по номеру паспорта или «Редактировать» → `/work/passports/[id]/edit`;
 *   - «Удалить» — корзинка через DeleteMyPassportButton, которая
 *     сама подтверждает действие и ревалидирует список.
 *
 * Эту же страницу могут открыть менеджеры — backend им endpoint не
 * закрыт (это удобно для отладки), но таблица отдаст только их
 * собственные выпуски, что обычно пусто. Менеджерам отдельно
 * прятать страницу от глаз не имеет смысла — у них всё равно
 * стоит редирект из /work на admin-overview (см. `app/work/page.tsx`).
 */
export default async function WorkMyPassportsPage() {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/work/passports');

  const items = await listMyRecentPassports();

  return (
    <div className="cut-orders">
      <header className="cut-orders__head">
        <Link href="/work" className="cut-orders__back" aria-label="Назад">
          ←
        </Link>
        <h1 className="cut-orders__title">Выпущенные паспорта</h1>
      </header>

      {items.length === 0 ? (
        <div className="cut-orders__empty" role="status">
          <div className="cut-orders__empty-title">Пока нет выпущенных паспортов</div>
          <p className="cut-orders__empty-hint">
            Когда вы выпустите первый паспорт, он появится здесь — и его
            можно будет отредактировать или удалить, пока он ещё не
            размещён в ячейке.
          </p>
          <Link href="/work" className="btn btn-block">
            Назад
          </Link>
        </div>
      ) : (
        <ul
          className="my-passports-list"
          aria-label="Список выпущенных паспортов"
        >
          {items.map((p) => (
            <MyPassportRow key={p.id} item={p} />
          ))}
        </ul>
      )}
    </div>
  );
}
