import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listMyRecentPassports } from '@/lib/passports-api';
import type { MyPassportListItem } from '@sewing/shared/passports';
import { DeleteMyPassportButton } from './delete-my-passport-button';

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

function blockHint(item: MyPassportListItem): string | null {
  switch (item.editableBlockReason) {
    case null:
      return null;
    case 'STATUS_NOT_CREATED':
      return 'Паспорт уже двинулся по операциям — править его нельзя.';
    case 'PLACED_IN_CELL':
      return `Паспорт размещён в ячейке ${item.currentCell?.code ?? '—'} — править нельзя.`;
    case 'HAS_EVENTS_BEYOND_CREATED':
      return 'По паспорту уже есть скан/выдача — править нельзя.';
    default:
      return 'Паспорт нельзя редактировать.';
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function MyPassportRow({ item }: { item: MyPassportListItem }) {
  const blocked = blockHint(item);
  const editHref = `/work/passports/${item.id}/edit`;
  return (
    <li className={'my-passports-row' + (blocked ? ' is-blocked' : '')}>
      <div className="my-passports-row__main">
        {item.editable ? (
          <Link
            className="my-passports-row__number"
            href={editHref}
            prefetch={false}
          >
            {item.number}
          </Link>
        ) : (
          <span className="my-passports-row__number">{item.number}</span>
        )}
        <div className="my-passports-row__meta">
          <span>
            <strong>{item.productName ?? '—'}</strong>
            {' · '}
            размер <strong>{item.sizeCode}</strong>
            {' · '}
            <strong>{item.qtyCut}</strong> шт
          </span>
          <span className="my-passports-row__sub">
            заказ {item.orderNumber} · рулон {item.rollNumber} · {formatDate(item.cutDate)}
          </span>
          {blocked ? (
            <span className="my-passports-row__blocked-hint">{blocked}</span>
          ) : null}
        </div>
      </div>
      <div className="my-passports-row__actions">
        {item.editable ? (
          <>
            <Link
              className="btn"
              href={editHref}
              prefetch={false}
              aria-label={`Редактировать паспорт ${item.number}`}
            >
              Редактировать
            </Link>
            <DeleteMyPassportButton
              passportId={item.id}
              orderId={item.orderId}
              passportNumber={item.number}
            />
          </>
        ) : (
          <span
            className="hint"
            title={blocked ?? undefined}
            aria-hidden
          >
            недоступно
          </span>
        )}
      </div>
    </li>
  );
}
