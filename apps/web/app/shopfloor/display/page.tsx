import { ApiRequestError } from '@/lib/api';
import { getShopfloorDisplaySummary } from '@/lib/shopfloor-api';
import { ShopfloorDisplayBoard } from './display-board';

export const dynamic = 'force-dynamic';

interface ShopfloorDisplayPageProps {
  searchParams?: {
    /** Новый параметр: `CompanyDivision.code` (см. `docs/display-board.md`). */
    divisionCode?: string | string[];
    /**
     * Deprecated alias на `divisionCode` для старых TV-закладок. Только
     * web-уровень: на API `?division=…` больше не принимается; здесь
     * мы тихо пробрасываем значение в `divisionCode`. Параметр будет
     * убран после переезда всех закладок.
     *
     * @deprecated Используйте `?divisionCode=<CompanyDivision.code>`.
     */
    division?: string | string[];
  };
}

function pickQueryString(
  raw: string | string[] | undefined,
): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
 *
 * Опциональный фильтр по подразделению — `?divisionCode=<code>` (см.
 * `docs/display-board.md`). Web-уровень также принимает старый
 * `?division=…` как deprecated alias и тихо мапит его на
 * `divisionCode`, чтобы старые TV-закладки не упали в 404.
 */
export default async function ShopfloorDisplayPage({
  searchParams,
}: ShopfloorDisplayPageProps) {
  const divisionCode =
    pickQueryString(searchParams?.divisionCode) ??
    pickQueryString(searchParams?.division);

  let initialSummary = null;
  let initialError: string | null = null;
  try {
    initialSummary = await getShopfloorDisplaySummary(
      divisionCode ?? undefined,
    );
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
      divisionCode={divisionCode}
    />
  );
}
