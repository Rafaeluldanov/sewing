/**
 * Серверные обёртки над `/api/admin/production-documents/*`
 * (модуль `apps/api/src/modules/production-documents/*`).
 *
 * ⛔ Ручек записи здесь нет и не будет: документ выпуска собирается сам из фактов
 * производства — его не заводят, не проводят и не подтверждают. Всё, что умеет фронт, —
 * прочитать то, что цех уже сделал.
 *
 * ⛔ Не путать с `order-production-document-api.ts` — там read-модель «план → факт» отчёта
 * себестоимости (`/admin/production-cost/order/[orderId]`), совсем другая сущность.
 */
import type {
  ProductionDocumentDto,
  ProductionDocumentListDto,
} from '@sewing/shared/production-documents';

import { apiFetch } from './api';

export function listProductionDocuments(query: {
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<ProductionDocumentListDto> {
  return apiFetch<ProductionDocumentListDto>('/admin/production-documents', {
    cache: 'no-store',
    searchParams: {
      status: query.status,
      search: query.search,
      page: query.page == null ? undefined : String(query.page),
      pageSize: query.pageSize == null ? undefined : String(query.pageSize),
    },
  });
}

export function getProductionDocument(id: string): Promise<ProductionDocumentDto> {
  return apiFetch<ProductionDocumentDto>(
    `/admin/production-documents/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

/**
 * СФОРМИРОВАТЬ / ОБНОВИТЬ документ по заказу (кнопка в карточке заказа).
 *
 * ⛔ Единственная пишущая ручка раздела. Работает на любой стадии заказа (14.09.2026): по
 * открытому заказу документ заводится заранее и наполняется по ходу производства, по закрытому
 * до появления раздела — достраивается задним числом, по существующему — пересобирается по
 * фактам. Новый выпуск ею не создать: окончательным документ станет только с закрытием заказа;
 * отказы (409) — заказ отменён и заказ закрыт без упаковки.
 */
export function backfillProductionDocumentForOrder(
  orderId: string,
): Promise<ProductionDocumentDto> {
  return apiFetch<ProductionDocumentDto>(
    `/admin/orders/${encodeURIComponent(orderId)}/production-document`,
    { method: 'POST', cache: 'no-store' },
  );
}

/**
 * Документ выпуска по заказу — для блока в карточке заказа.
 *
 * `null` — документа ещё нет: заказ не закрыт и заранее его не формировали.
 */
export function getProductionDocumentForOrder(
  orderId: string,
): Promise<ProductionDocumentDto | null> {
  return apiFetch<ProductionDocumentDto | null>(
    `/admin/orders/${encodeURIComponent(orderId)}/production-document`,
    { cache: 'no-store' },
  );
}
