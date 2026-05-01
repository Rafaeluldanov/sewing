/**
 * Client-safe URL-хелперы для ячеек склада.
 *
 * Вынесены из `lib/warehouses-api.ts`, чтобы их можно было использовать
 * из клиентских компонентов (например, превью этикеток в окне массовой
 * печати). Сам `warehouses-api.ts` тянет `lib/api.ts` → `next/headers`
 * и поэтому в client bundle попадать не должен.
 *
 * Здесь — только чистые builder-ы поверх `getClientApiUrl()`, который
 * корректно работает и на сервере, и в браузере.
 */
import { getClientApiUrl } from './config';

/**
 * Абсолютный URL печатной формы QR ячейки. `@Public()`-эндпоинт API,
 * та же модель, что у `/api/equipment/:id/print` и
 * `/api/passports/:id/print` — открывается в новой вкладке для печати.
 */
export function buildCellPrintUrl(id: string): string {
  return `${getClientApiUrl()}/cells/${encodeURIComponent(id)}/print`;
}

/**
 * URL PNG-картинки QR-кода ячейки. Используется в preview плиток
 * этикеток в окне «Печать всех ячеек» — мы не рендерим QR на клиенте,
 * а используем готовый `@Public()` endpoint backend-а, тот же, что
 * embed-ится в HTML-этикетку (см. `cell-print.ts` / ADR-0008).
 */
export function buildCellQrImageUrl(id: string): string {
  return `${getClientApiUrl()}/cells/${encodeURIComponent(id)}/qr`;
}
