import {
  ORDER_DIVISIONS,
  ORDER_DIVISION_LABELS,
  type OrderDivision,
} from '@sewing/shared/orders';
import { ApiRequestError } from '@/lib/api';
import { getShopfloorDisplaySummary } from '@/lib/shopfloor-api';
import { ShopfloorDisplayBoard } from './display-board';

export const dynamic = 'force-dynamic';

interface ShopfloorDisplayPageProps {
  searchParams?: { division?: string | string[] };
}

/**
 * Парсит query-параметр `division` в `OrderDivision | null`. Невалидное
 * значение тихо игнорируется — на TV-экране нет UI, чтобы показать
 * ошибку, и логично продолжить работать как «без фильтра».
 */
function parseDivision(
  raw: string | string[] | undefined,
): OrderDivision | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  return (ORDER_DIVISIONS as readonly string[]).includes(value)
    ? (value as OrderDivision)
    : null;
}

/**
 * Экран «Цех — большой монитор» (`/shopfloor/display`).
 *
 * Read-only витрина для висящего в зале экрана. Интерактив отсутствует
 * по дизайну: ни кнопок, ни форм, ни hover-меню — только цифры.
 *
 * Один backend-эндпоинт `/api/shopfloor/display` отдаёт сразу:
 *   - KPI «Выпущено сегодня / В работе / Ждёт / ОТК / ВТО / Упаковка /
 *     Готово / Брак»;
 *   - матрицу «цвет × размер × stage» (Поток производства);
 *   - статусы оборудования (включая `kind` для иконки).
 *
 * RSC делает initial fetch, чтобы первый кадр показал данные без
 * спиннера. Дальше клиент-компонент (`ShopfloorDisplayBoard`) поллит
 * каждые 7 секунд — это укладывается в требование «авто-обновление
 * каждые 5–10 секунд» и не выжигает CPU/сеть на круглосуточном экране.
 */
export default async function ShopfloorDisplayPage({
  searchParams,
}: ShopfloorDisplayPageProps) {
  // Опциональный фильтр по подразделению: `?division=MARKETPLACE`.
  // Используется для отдельных display-экранов (см. `docs/screens.md
  // §9a`). Без параметра поведение прежнее — показываем всё.
  const division = parseDivision(searchParams?.division);
  const divisionLabel = division ? ORDER_DIVISION_LABELS[division] : null;

  let initialSummary = null;
  let initialError: string | null = null;
  try {
    initialSummary = await getShopfloorDisplaySummary(division ?? undefined);
  } catch (e) {
    initialError =
      e instanceof ApiRequestError
        ? `display: ${e.message}${e.code ? ` (${e.code})` : ''}`
        : 'display: не удалось загрузить данные';
  }

  return (
    <ShopfloorDisplayBoard
      initialSummary={initialSummary}
      initialError={initialError}
      division={division}
      divisionLabel={divisionLabel}
    />
  );
}
