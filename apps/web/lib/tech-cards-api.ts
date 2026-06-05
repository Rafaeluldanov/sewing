/**
 * Серверные обёртки над `/api/tech-cards` (см. `docs/api.md §«tech-cards»`,
 * ADR-0022).
 *
 * Используется из RSC (`/admin/tech-cards/*`, `/orders/new`,
 * `/orders/[id]/edit`) и из server actions редактирования шаблонов.
 * Контракты — те же Zod-схемы из `@sewing/shared/tech-cards`, что
 * валидирует backend.
 */
import type {
  CreateTechCardDto,
  ListTechCardsQuery,
  TechCardTemplateDetailDto,
  TechCardTemplateSummaryDto,
  UpdateTechCardDto,
} from '@sewing/shared/tech-cards';
import { apiFetch, apiFetchMultipart } from './api';

export function listTechCards(
  query: ListTechCardsQuery = {},
): Promise<TechCardTemplateSummaryDto[]> {
  const params = new URLSearchParams();
  if (query.isActive !== undefined) {
    params.set('isActive', String(query.isActive));
  }
  // Inline-создание изделия из формы заказа: фильтр по группе
  // номенклатуры (см. `TechCardTemplate.patternCategoryId`).
  if (query.patternCategoryId) {
    params.set('patternCategoryId', query.patternCategoryId);
  }
  if (query.search) params.set('search', query.search);
  const qs = params.toString();
  const path = qs.length > 0 ? `/tech-cards?${qs}` : '/tech-cards';
  return apiFetch<TechCardTemplateSummaryDto[]>(path, { cache: 'no-store' });
}

export function getTechCard(id: string): Promise<TechCardTemplateDetailDto> {
  return apiFetch<TechCardTemplateDetailDto>(
    `/tech-cards/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

export function createTechCard(
  body: CreateTechCardDto,
): Promise<TechCardTemplateDetailDto> {
  return apiFetch<TechCardTemplateDetailDto>('/tech-cards', {
    method: 'POST',
    body,
  });
}

export function updateTechCard(
  id: string,
  body: UpdateTechCardDto,
): Promise<TechCardTemplateDetailDto> {
  return apiFetch<TechCardTemplateDetailDto>(
    `/tech-cards/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

/**
 * Hard-delete архивной (неактивной) техкарты
 * (`DELETE /tech-cards/:id/permanent`). Backend блокирует удаление,
 * если карта активна или используется в заказах/snapshot-потребностях
 * (409 `TECH_CARD_DELETE_FORBIDDEN`). Ответ пустой.
 */
export function deleteTechCard(id: string): Promise<void> {
  return apiFetch<void>(
    `/tech-cards/${encodeURIComponent(id)}/permanent`,
    { method: 'DELETE' },
  );
}

/**
 * Загружает JPG/JPEG/PNG-изображение для конкретной строки материала
 * техкарты (`POST /api/tech-cards/:techCardId/material-lines/:lineId/image`,
 * multipart/form-data, поле `file`). Этап «Изображение материала»
 * (см. ТЗ §5).
 *
 * Backend сам валидирует расширение и размер файла; здесь мы просто
 * форвардим `FormData`. Доступно ТОЛЬКО для уже сохранённой строки
 * с известным `lineId` — для свежих несохранённых строк UI показывает
 * подсказку «Сохраните техкарту, чтобы загрузить изображение».
 */
export function uploadTechCardMaterialLineImage(
  techCardId: string,
  lineId: string,
  file: File | Blob,
  fileName?: string,
): Promise<TechCardTemplateDetailDto> {
  const fd = new FormData();
  if (fileName) {
    fd.append('file', file, fileName);
  } else {
    fd.append('file', file);
  }
  return apiFetchMultipart<TechCardTemplateDetailDto>(
    `/tech-cards/${encodeURIComponent(techCardId)}/material-lines/${encodeURIComponent(lineId)}/image`,
    fd,
  );
}
