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

export interface BatchPrintJobsResult {
  ok: boolean;
  /** Сколько паспортов успешно ушло на принтер. */
  printed?: number;
  /** Сколько паспортов не ушло (но не из-за отсутствия принтера). */
  failed?: number;
  /** Печать на устройство недоступна (нет принтера/смены) — UI откроет браузерную форму. */
  noPrinter?: boolean;
  /** Первое сообщение об ошибке печати (для частичного успеха). */
  firstError?: string;
  error?: string;
}

/** Коды бекенда «нет принтера для рабочего места» — см. `print-button.tsx`. */
const NO_PRINTER_CODES = new Set([
  'PRINTER_NOT_CONFIGURED_FOR_EQUIPMENT',
  'SHIFT_SESSION_REQUIRED',
  'PRINTER_NOT_FOUND',
]);

/**
 * Пакетная печать выбранных паспортов одной кнопкой (экран успеха
 * помощника раскройщика). Шлёт по одному `PrintJob` на паспорт — тот же
 * `POST /api/print-jobs`, что и одиночный `<PrintButton>`.
 *
 * Если самый первый паспорт упирается в «нет принтера/смены» — не плодим
 * частичные job-ы, а сразу возвращаем `noPrinter: true`, и клиент
 * открывает браузерную форму `print-batch` со всеми выбранными. Это
 * зеркалит fallback одиночной кнопки, только для всего набора сразу.
 */
export async function sendPassportPrintJobsBatch(
  passportIds: string[],
): Promise<BatchPrintJobsResult> {
  if (passportIds.length === 0) {
    return { ok: false, error: 'Не выбрано ни одного паспорта' };
  }
  let printed = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (const id of passportIds) {
    const res = await sendPrintJob({ sourceType: 'PASSPORT_PRINT', sourceId: id });
    if (res.ok) {
      printed++;
      continue;
    }
    // Нет принтера на рабочем месте — печать на устройство невозможна в
    // принципе. Пока ничего не ушло, отдаём флаг для браузерного fallback
    // (открыть `print-batch`), не отправляя половину набора на принтер.
    if (printed === 0 && res.code && NO_PRINTER_CODES.has(res.code)) {
      return { ok: false, noPrinter: true };
    }
    failed++;
    if (!firstError) firstError = res.error;
  }
  return { ok: true, printed, failed, firstError };
}
