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
 * ДОСТРОИТЬ документ по уже закрытому заказу (кнопка в карточке заказа).
 *
 * ⛔ Единственная пишущая ручка раздела — ради заказов, закрытых ДО его появления: документ
 * рождается закрытием, а их закрывали, когда рождаться было нечему. Новый выпуск ею не создать:
 * заказ обязан быть закрыт, а упакованные паспорта — существовать.
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
 * `null` — заказ ещё не закрыт: документ рождается закрытием, и до него показывать нечего.
 */
export function getProductionDocumentForOrder(
  orderId: string,
): Promise<ProductionDocumentDto | null> {
  return apiFetch<ProductionDocumentDto | null>(
    `/admin/orders/${encodeURIComponent(orderId)}/production-document`,
    { cache: 'no-store' },
  );
}
