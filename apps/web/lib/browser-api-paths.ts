/**
 * Браузерные ссылки на API (`href` / `window.open` / `<a target="_blank">`).
 *
 * Зачем отдельный модуль:
 *   `lib/api-base.ts` (`getApiBaseUrl` / `getClientApiUrl`) при SSR честно
 *   возвращает `INTERNAL_API_URL` — обычно `http://127.0.0.1:3001/api`.
 *   Это правильно для серверного `fetch` (RSC ходит в backend по
 *   loopback-адресу, не зависит от внешнего DNS), но категорически
 *   неправильно, если та же строка попадает в HTML как `href`/QR-картинка:
 *   браузер начальника откроет `http://127.0.0.1:3001/...` у себя на
 *   машине и получит ошибку соединения.
 *
 * Поэтому все ссылки, которые нажимает человек или подгружает браузер,
 * должны быть **относительными**: nginx на том же хосте проксирует
 * `/api/...` на backend (см. `docs/deploy-stage.md`), и ссылка работает
 * с любого устройства, у которого открыт основной домен.
 *
 * НЕ использовать здесь `INTERNAL_API_URL` / `127.0.0.1` / `localhost` —
 * они валидны только внутри контейнера/хоста Next.js.
 */

export function buildPassportPrintPath(id: string): string {
  return `/api/passports/${encodeURIComponent(id)}/print`;
}

export function buildPassportQrPath(id: string): string {
  return `/api/passports/${encodeURIComponent(id)}/qr`;
}

export function buildEquipmentPrintPath(id: string): string {
  return `/api/equipment/${encodeURIComponent(id)}/print`;
}

export function buildEquipmentQrPath(id: string): string {
  return `/api/equipment/${encodeURIComponent(id)}/qr`;
}
