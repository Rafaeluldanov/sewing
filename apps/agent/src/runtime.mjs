/**
 * Бизнес-логика агента: pairing, polling-цикл, обработка одного job-а.
 *
 * Внешние границы (HTTP, диск, конфиг) изолированы в отдельных
 * модулях — здесь только склейка и обработка ошибок. Это позволяет
 * заменить `processJob` на реальную нативную печать без правок цикла.
 */

import { basename, extname } from 'node:path';
import { hostname } from 'node:os';
import { log } from './logger.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import {
  downloadPayload,
  heartbeat,
  normalizeApiUrl,
  pairAgent,
  pollJobs,
  reportResult,
  uploadWindowsPrinters,
} from './api.mjs';
import {
  buildJobFilename,
  ensureSpoolDirs,
  moveToFolder,
  saveToSpool,
} from './filesystem.mjs';
import { listWindowsPrinters } from './windows-printers.mjs';
import {
  detectPrintableKind,
  printFileOnWindows,
  printHtmlWithBrowser,
} from './windows-print.mjs';

const DEFAULT_POLL_MS = 3000;

function pollIntervalMs() {
  const raw = process.env.POLL_INTERVAL_MS;
  if (!raw) return DEFAULT_POLL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 500 ? n : DEFAULT_POLL_MS;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// PAIR
// ---------------------------------------------------------------------------

export async function runPair({ serverUrl, code, configPath }) {
  if (!serverUrl) {
    throw new Error(
      'Не передан --server <URL>. Пример: --server https://stage.teeon.ru',
    );
  }
  if (!code) {
    throw new Error(
      'Не передан --code <PAIRING_CODE>. Сгенерировать его можно в /admin/printers/<id>.',
    );
  }
  const apiUrl = normalizeApiUrl(serverUrl);
  log.info(`Pairing: ${apiUrl} с кодом ${code}`);
  const result = await pairAgent(apiUrl, code);
  const cfg = {
    serverUrl: stripTrailingSlash(serverUrl),
    apiUrl,
    printerId: result.printerId,
    printerName: result.printerName,
    agentToken: result.agentToken,
    pairedAt: new Date().toISOString(),
  };
  await saveConfig(configPath, cfg);
  log.info(`Pairing successful.`);
  log.info(`Printer connected: «${cfg.printerName}» (id=${cfg.printerId}).`);
  log.info(`Config saved to ${configPath}.`);
  log.info('Запустите агент без --pair для рабочего цикла.');
}

function stripTrailingSlash(s) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// ---------------------------------------------------------------------------
// LOOP
// ---------------------------------------------------------------------------

export async function runLoop({ configPath }) {
  const cfg = await loadConfig(configPath);
  const apiUrl = cfg.apiUrl ?? normalizeApiUrl(cfg.serverUrl);
  const dirs = await ensureSpoolDirs();
  const intervalMs = pollIntervalMs();
  const host = hostname();

  log.info(
    `Старт. server=${cfg.serverUrl} printer="${cfg.printerName}" host="${host}" interval=${intervalMs}ms`,
  );
  log.info(`Папки: spool=${dirs.spool}  printed=${dirs.printed}  failed=${dirs.failed}`);

  // Состояние агента: текущий выбор менеджера (selectedWindowsPrinter)
  // и последний известный список Windows-принтеров. Обновляются в `tick`.
  // `availableWindowsPrinters` нужен `processJob`-у, чтобы быстро
  // отбраковать job со «своим» неизвестным принтером, не дёргая
  // PowerShell зря (Get-Printer внутри windows-print.mjs всё равно
  // продублирует проверку — это вторая линия защиты).
  const state = {
    selectedWindowsPrinter: null,
    availableWindowsPrinters: [],
    lastWindowsPrintersUploadAt: 0,
  };

  // Сразу при старте: сообщаем серверу свой hostName и список системных
  // Windows-принтеров. Это даёт менеджеру что показать в UI ещё до
  // первой печати. Любая ошибка не блокирует основной цикл — мы
  // повторим попытку внутри tick (см. `WINDOWS_PRINTERS_REFRESH_MS`).
  try {
    const refreshed = await syncWindowsPrinters(apiUrl, cfg.agentToken, host);
    if (refreshed) {
      state.selectedWindowsPrinter = refreshed.selectedWindowsPrinter;
      state.availableWindowsPrinters = refreshed.availableWindowsPrinters;
      state.lastWindowsPrintersUploadAt = Date.now();
    }
  } catch (err) {
    log.warn(
      `Initial windows-printers upload failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (!stopping) {
        stopping = true;
        log.info(`Получен ${sig}, завершаемся…`);
      }
    });
  }

  while (!stopping) {
    await tick(apiUrl, cfg.agentToken, dirs, state, host);
    if (stopping) break;
    await sleep(intervalMs);
  }
}

// Как часто переопрашиваем системные принтеры и шлём их на сервер.
// На MVP минута — компромисс между «оператор вытащил USB-принтер и
// мы быстро это увидим» и «не спамить PowerShell-вызовами каждые 3
// секунды». Отдельно от heartbeat-а, чтобы не плодить нагрузку.
const WINDOWS_PRINTERS_REFRESH_MS = 60_000;

/**
 * Один проход цикла: heartbeat + (опц.) refresh windows printers +
 * poll + (если есть) обработка job-а. Любая ошибка ловится и не
 * прерывает loop — логируется и идём дальше.
 */
async function tick(apiUrl, token, dirs, state, host) {
  try {
    const hb = await heartbeat(apiUrl, token);
    state.selectedWindowsPrinter = hb.selectedWindowsPrinter;
    log.info(
      `Heartbeat ok. selectedWindowsPrinter=${
        state.selectedWindowsPrinter ?? '(не выбран)'
      }`,
    );
  } catch (err) {
    log.warn(
      `Heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (
    Date.now() - state.lastWindowsPrintersUploadAt >=
    WINDOWS_PRINTERS_REFRESH_MS
  ) {
    try {
      const refreshed = await syncWindowsPrinters(apiUrl, token, host);
      if (refreshed) {
        state.selectedWindowsPrinter = refreshed.selectedWindowsPrinter;
        state.availableWindowsPrinters = refreshed.availableWindowsPrinters;
        state.lastWindowsPrintersUploadAt = Date.now();
      }
    } catch (err) {
      log.warn(
        `Refresh windows-printers failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  let jobs = [];
  try {
    jobs = await pollJobs(apiUrl, token);
  } catch (err) {
    log.warn(
      `Poll failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (!Array.isArray(jobs) || jobs.length === 0) {
    log.info('No pending jobs.');
    return;
  }

  for (const job of jobs) {
    try {
      await processJob(apiUrl, token, job, dirs, state);
    } catch (err) {
      // Аварийный fallback — на одном job-е цикл не падает.
      log.error(
        `Job ${job?.id ?? '?'} unhandled error: ${
          err instanceof Error ? err.stack : String(err)
        }`,
      );
    }
  }
}

/**
 * Опросить системные Windows-принтеры и отправить их на сервер. На
 * не-Windows платформах (Linux/macOS, dev) `listWindowsPrinters`
 * возвращает пустой массив — сервер всё равно зафиксирует hostName,
 * UI покажет «системных принтеров не найдено».
 */
async function syncWindowsPrinters(apiUrl, token, host) {
  const { printers, error } = await listWindowsPrinters();
  if (error) log.warn(`listWindowsPrinters: ${error}`);
  log.info(
    `Windows-принтеры: hostName=${host}, найдено ${printers.length}.${
      printers.length > 0 ? ` (${printers.join(', ')})` : ''
    }`,
  );
  const result = await uploadWindowsPrinters(apiUrl, token, host, printers);
  log.info(
    `Сервер подтвердил: selectedWindowsPrinter=${
      result.selectedWindowsPrinter ?? '(не выбран)'
    }`,
  );
  return {
    ...result,
    availableWindowsPrinters: printers,
  };
}

/**
 * Обработка одного job-а.
 *
 * Поток: скачать payload → положить в spool → реально напечатать на
 * `targetPrinter` (см. `windows-print.mjs`) → перенести в printed →
 * PATCH PRINTED. На любой ошибке — перенос в failed/ и PATCH FAILED
 * с понятным `errorMessage`.
 *
 * Куда печатать решает менеджер через `Printer.selectedWindowsPrinter`
 * (см. `docs/domain.md §17b «Физический Windows-принтер»`). Сервер
 * присылает текущий выбор в каждом job-е (`job.selectedWindowsPrinter`)
 * и в heartbeat-е. Если выбор не сделан — мы НЕ печатаем и сразу
 * помечаем job как FAILED с понятным `errorMessage`. PRINTED ставится
 * ТОЛЬКО после того, как PowerShell-handler реально завершился, то
 * есть документ ушёл в очередь выбранного Windows-принтера.
 */
export async function processJob(apiUrl, token, job, dirs, state) {
  // На MVP сервер уже отдаёт `selectedWindowsPrinter` в job-е, но мы
  // на всякий случай предпочитаем свежее значение из heartbeat-а
  // (state) — на случай, если сервер старый и поле в job-е отсутствует.
  const targetPrinter =
    job.selectedWindowsPrinter ?? state?.selectedWindowsPrinter ?? null;

  log.info(
    `Job ${job.id} (${job.sourceType}) → ${job.payloadUrl} ` +
      `targetPrinter=${targetPrinter ?? '(не выбран)'}`,
  );

  if (!targetPrinter) {
    const errorMessage =
      'Не выбран Windows-принтер для логического принтера. ' +
      'Откройте /admin/printers/<id> и выберите физический принтер.';
    log.warn(`Job ${job.id} skipped: ${errorMessage}`);
    await safePatch(apiUrl, token, job.id, 'FAILED', errorMessage);
    return;
  }

  // Дешёвая проверка по последнему известному списку системных
  // принтеров: если выбранного имени нет — нет смысла качать payload
  // и звать PowerShell, сразу честно фейлим. windows-print.mjs всё
  // равно сделает Get-Printer как вторую линию защиты.
  const known = state?.availableWindowsPrinters;
  if (Array.isArray(known) && known.length > 0 && !known.includes(targetPrinter)) {
    const errorMessage = `Selected Windows printer not found: ${targetPrinter}`;
    log.warn(`Job ${job.id} skipped: ${errorMessage}`);
    await safePatch(apiUrl, token, job.id, 'FAILED', errorMessage);
    return;
  }

  let spoolPath;
  let filename;
  try {
    const { buffer, contentType } = await downloadPayload(job.payloadUrl);
    filename = buildJobFilename(job.id, contentType, job.payloadUrl);
    spoolPath = await saveToSpool(dirs.spool, filename, buffer);
    log.info(
      `Job downloaded: ${basename(spoolPath)} (${buffer.length} bytes, ${contentType}).`,
    );

    const kind = detectPrintableKind(spoolPath, contentType);
    log.info(`Detected print kind: ${kind ?? 'unsupported'}`);
    if (!kind) {
      const ext = extname(spoolPath) || '(no ext)';
      throw new Error(`Unsupported print file type: ${ext}`);
    }

    log.info(`Printing job ${job.id} to ${targetPrinter} (kind=${kind})`);
    if (kind === 'html') {
      // У Windows нет надёжной ассоциации `printto` для .html
      // (часто валится «файлу не сопоставлено приложение»). Поэтому
      // HTML печатаем напрямую через Chrome/Edge `--kiosk-printing`,
      // см. `windows-print.mjs §printHtmlWithBrowser`.
      await printHtmlWithBrowser(spoolPath, targetPrinter);
    } else {
      await printFileOnWindows(spoolPath, targetPrinter);
    }
    log.info(`Print command completed successfully`);

    const printedPath = await moveToFolder(spoolPath, dirs.printed, filename);
    log.info(`Saved to printed: ${printedPath}`);
    await safePatch(apiUrl, token, job.id, 'PRINTED');
    log.info(`Job ${job.id} marked as PRINTED on ${targetPrinter}.`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn(`Print command failed: ${errorMessage}`);
    log.warn(`Job ${job.id} failed on ${targetPrinter}: ${errorMessage}`);
    if (spoolPath && filename) {
      try {
        const failedPath = await moveToFolder(spoolPath, dirs.failed, filename);
        log.warn(`Saved to failed: ${failedPath}`);
      } catch (moveErr) {
        log.warn(
          `Не смогли перенести в failed: ${
            moveErr instanceof Error ? moveErr.message : String(moveErr)
          }`,
        );
      }
    }
    await safePatch(apiUrl, token, job.id, 'FAILED', errorMessage);
  }
}

/**
 * PATCH результата с проглатыванием ошибки: если сервер недоступен —
 * мы не должны убить процесс, просто залогируем. Job при этом остаётся
 * на сервере в статусе SENT (мы его уже захватили на поллинге), поэтому
 * повторный поллинг его НЕ подберёт и НЕ перепечатает. Если PATCH так и
 * не дойдёт, сервер сам переведёт «зависший» SENT в FAILED по таймауту
 * (см. `PrintJobsService.pollForAgent` / `STALE_SENT_MS`) — вслепую
 * документ не перепечатывается.
 */
async function safePatch(apiUrl, token, jobId, status, errorMessage) {
  try {
    await reportResult(apiUrl, token, jobId, status, errorMessage);
  } catch (err) {
    log.warn(
      `PATCH ${jobId} ${status} не удался: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
