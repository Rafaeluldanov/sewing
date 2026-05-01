/**
 * QR-помощники для модуля паспортов (Шаг 5).
 *
 * Согласовано с ADR-0008: значение QR — `passport:{id}`. Печатная форма
 * дополнительно показывает человекочитаемый URL на UI-домене из
 * `APP_URL` / `NEXT_PUBLIC_APP_URL` (см. ADR-0010 и `docs/index.md`).
 */

import { API_PREFIX, DOMAIN_PROD_API, DOMAIN_PROD_WEB } from '@sewing/shared/config';

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/** Базовый URL UI (web) — для абсолютных ссылок и человекочитаемых URL в печатной форме. */
export function getAppUrl(): string {
  const fromEnv = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (fromEnv && fromEnv.length > 0) return trimTrailingSlash(fromEnv);
  return DOMAIN_PROD_WEB;
}

/** Базовый URL API — для абсолютных ссылок на печатную форму, если она вынесена на API. */
export function getApiUrl(): string {
  const fromEnv = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (fromEnv && fromEnv.length > 0) return trimTrailingSlash(fromEnv);
  return `${DOMAIN_PROD_API}${API_PREFIX}`;
}

/** Значение QR-кода паспорта в формате ADR-0008. */
export function buildPassportQrPayload(id: string): string {
  return `passport:${id}`;
}

/** Человекочитаемый URL карточки паспорта на UI. */
export function buildPassportWebUrl(id: string): string {
  return `${getAppUrl()}/passports/${id}`;
}

/** URL печатной формы паспорта (HTML). */
export function buildPassportPrintUrl(id: string): string {
  return `${getApiUrl()}/passports/${id}/print`;
}

/** Значение QR-кода ячейки в формате ADR-0008. */
export function buildCellQrPayload(id: string): string {
  return `cell:${id}`;
}

/**
 * URL печатной формы QR-этикетки ячейки (HTML, A6). Тот же подход,
 * что у `/api/passports/:id/print` и `/api/equipment/:id/print` — см.
 * ADR-0010. QR-payload `cell:{id}` (ADR-0008) не меняется.
 */
export function buildCellPrintUrl(id: string): string {
  return `${getApiUrl()}/cells/${id}/print`;
}
