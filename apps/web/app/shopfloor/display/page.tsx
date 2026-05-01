import { ApiRequestError } from '@/lib/api';
import { getShopfloorDisplaySummary } from '@/lib/shopfloor-api';
import { ShopfloorDisplayBoard } from './display-board';

export const dynamic = 'force-dynamic';

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
export default async function ShopfloorDisplayPage() {
  let initialSummary = null;
  let initialError: string | null = null;
  try {
    initialSummary = await getShopfloorDisplaySummary();
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
    />
  );
}
