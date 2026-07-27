import Link from 'next/link';
import type { MyPassportListItem } from '@sewing/shared/passports';
import { PrintButton } from '@/components/print-button';
import { buildPassportPrintPath } from '@/lib/browser-api-paths';
import { DeleteMyPassportButton } from './delete-my-passport-button';

/**
 * Строка списка «Выпущенные паспорта» — ОДНА для двух кабинетов:
 *   - помощник раскройщика: `/work/passports` (исторический дом строки,
 *     поэтому файл лежит рядом с кнопкой удаления и server actions);
 *   - раскройщик: `/cutter/passports` (чистая учётка `CUTTER` заперта
 *     middleware на префикс `/cutter`, см. `apps/web/middleware.ts`).
 *
 * Раньше разметка строки жила прямо в `work/passports/page.tsx`. Вынесена
 * в отдельный компонент ровно затем, чтобы кабинет раскройщика НЕ получил
 * свою копию: правила «что показываем» и «когда гасим кнопки» должны
 * меняться в одном месте (см. memory «Проверять взаимосвязанные места»).
 * Различие между кабинетами сводится к одному пропу `basePath` — адресу
 * списка, внутри которого лежит форма правки.
 *
 * Инварианты:
 *   - `editable` / `editableBlockReason` считает backend
 *     (`GET /api/passports/my-recent`); фронт только переводит код в
 *     человеческую подсказку и не рисует кнопки правки/удаления на
 *     заблокированных строках — чтобы пользователь не ловил глухую
 *     409 `PASSPORT_NOT_EDITABLE`;
 *   - «Печать» доступна ВСЕГДА, независимо от `editable`: перепечатать
 *     этикетку нужно и после размещения в ячейке, и после движения по
 *     операциям (правку в этих состояниях backend уже закрыл).
 */
export function MyPassportRow({
  item,
  basePath = '/work/passports',
}: {
  item: MyPassportListItem;
  /**
   * Список, которому принадлежит строка: `/work/passports` (помощник) или
   * `/cutter/passports` (раскройщик). Из него собирается адрес формы
   * правки `<basePath>/<id>/edit`. Дефолт сохраняет поведение помощника.
   */
  basePath?: string;
}) {
  const blocked = blockHint(item);
  const editHref = `${basePath}/${item.id}/edit`;
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
            заказ {item.orderNumber} · рулон {item.rollNumber} ·{' '}
            {formatDate(item.cutDate)}
          </span>
          {blocked ? (
            <span className="my-passports-row__blocked-hint">{blocked}</span>
          ) : null}
        </div>
      </div>
      <div className="my-passports-row__actions">
        <PrintButton
          sourceType="PASSPORT_PRINT"
          sourceId={item.id}
          fallbackHref={buildPassportPrintPath(item.id)}
          className="btn"
          label="Печать"
        />
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
          <span className="hint" title={blocked ?? undefined} aria-hidden>
            недоступно для правки
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * Машинный код блокировки → подсказка для цеха. `null` — строка
 * редактируемая (тогда `item.editable === true`, backend держит эту
 * инварианту).
 */
export function blockHint(item: MyPassportListItem): string | null {
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

/**
 * Дата кроя — всегда в московском поясе: `toLocaleDateString` без
 * `timeZone` на сервере отдаёт UTC-день и в ночную смену «уводит» дату на
 * сутки назад (см. memory feedback про hydration/таймзоны).
 */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}
