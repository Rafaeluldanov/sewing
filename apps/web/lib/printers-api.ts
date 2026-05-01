/**
 * Клиент для модуля «Принтеры и печать через агент» (см.
 * `docs/api.md §16`). Используется RSC-страницами `/admin/printers`,
 * server actions карточки принтера, и кнопками «Печать» на других
 * экранах.
 */
import type {
  CreatePrinterDto,
  CreatePrintJobDto,
  PrintJobDto,
  PrinterDetailDto,
  PrinterSummaryDto,
  UpdatePrinterDto,
} from '@sewing/shared/printers';
import { apiFetch } from './api';

export function listPrinters(): Promise<PrinterSummaryDto[]> {
  return apiFetch<PrinterSummaryDto[]>('/printers', { cache: 'no-store' });
}

export function getPrinter(id: string): Promise<PrinterDetailDto> {
  return apiFetch<PrinterDetailDto>(`/printers/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
}

export function createPrinter(
  body: CreatePrinterDto,
): Promise<PrinterDetailDto> {
  return apiFetch<PrinterDetailDto>('/printers', { method: 'POST', body });
}

export function updatePrinter(
  id: string,
  body: UpdatePrinterDto,
): Promise<PrinterDetailDto> {
  return apiFetch<PrinterDetailDto>(`/printers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
  });
}

export function deletePrinter(id: string): Promise<void> {
  return apiFetch<void>(`/printers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function generatePairingCode(id: string): Promise<PrinterDetailDto> {
  return apiFetch<PrinterDetailDto>(
    `/printers/${encodeURIComponent(id)}/pairing-code`,
    { method: 'POST' },
  );
}

export function listPrintJobsForPrinter(
  printerId: string,
  limit = 20,
): Promise<PrintJobDto[]> {
  return apiFetch<PrintJobDto[]>('/print-jobs', {
    cache: 'no-store',
    searchParams: { printerId, limit },
  });
}

export function createPrintJob(body: CreatePrintJobDto): Promise<PrintJobDto> {
  return apiFetch<PrintJobDto>('/print-jobs', { method: 'POST', body });
}

/**
 * URL для скачивания агента (готовый Windows-exe, см.
 * `apps/agent/README.md`). Открывается обычной ссылкой; файл
 * сохраняется как `sewing-print-agent.exe`.
 *
 * Возвращаем относительный путь намеренно: эта ссылка попадает
 * в HTML страницы `/admin/printers/[id]` (Server Component), и
 * раньше резолвилась через `getClientApiUrl()` → на сервере это
 * `INTERNAL_API_URL` (`http://127.0.0.1:3001/api`), который
 * сериализовывался в `<a href>` и был недоступен из браузера.
 *
 * Относительный `/api/...` всегда уходит на текущий хост, где
 * nginx уже проксирует `/api/` на backend (см. `docs/deploy-stage.md`).
 */
export function buildAgentDownloadUrl(): string {
  return '/api/printers/agent-download/sewing-print-agent.exe';
}
