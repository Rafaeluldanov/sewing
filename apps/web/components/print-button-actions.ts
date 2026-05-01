'use server';

import { ApiRequestError } from '@/lib/api';
import { createPrintJob } from '@/lib/printers-api';
import type { PrintJobSource } from '@sewing/shared/printers';

export interface SendPrintJobResult {
  ok: boolean;
  jobId?: string;
  printerId?: string;
  /** Машинный код ошибки бекенда — используется UI для fallback. */
  code?: string;
  error?: string;
  requestId?: string;
}

/**
 * Тонкая обёртка над `POST /api/print-jobs` для клиентских кнопок
 * «Печать». Возвращает структурированный результат, чтобы кнопка
 * могла выбрать стратегию (показать ошибку / открыть fallback URL).
 */
export async function sendPrintJob(input: {
  sourceType: PrintJobSource;
  sourceId?: string;
}): Promise<SendPrintJobResult> {
  try {
    const job = await createPrintJob({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
    return { ok: true, jobId: job.id, printerId: job.printerId };
  } catch (e) {
    if (e instanceof ApiRequestError) {
      return {
        ok: false,
        code: e.code,
        error: e.message,
        requestId: e.requestId,
      };
    }
    return { ok: false, error: 'Не удалось создать задание на печать' };
  }
}
