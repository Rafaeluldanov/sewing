/**
 * Клиент массовых операций архива (`POST /api/<раздел>/archive|restore|purge`).
 *
 * Все девять справочников (техкарты, маршруты, операции, заявки
 * конструктору, цеховой монитор, оборудование, принтеры, сотрудники,
 * поставщики) отдают один и тот же шейп — см. `@sewing/shared/archive`,
 * поэтому обёртка одна и параметризуется базовым путём раздела.
 */
import type {
  BulkArchiveRequestDto,
  BulkArchiveResultDto,
} from '@sewing/shared/archive';
import { apiFetch } from './api';

export type BulkArchiveOp = 'archive' | 'restore' | 'purge';

export function bulkArchiveRequest(
  basePath: string,
  op: BulkArchiveOp,
  ids: string[],
): Promise<BulkArchiveResultDto> {
  return apiFetch<BulkArchiveResultDto>(`${basePath}/${op}`, {
    method: 'POST',
    body: { ids } satisfies BulkArchiveRequestDto,
  });
}
