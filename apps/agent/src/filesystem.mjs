/**
 * Локальное файловое хранилище payload-ов.
 *
 * Структура папок (всё рядом с exe / cwd):
 *
 *   spool/    — куда сначала пишется свежий payload, до подтверждения.
 *   printed/  — успешно «обработанные» (на MVP это просто скачанные).
 *   failed/   — payload-ы, по которым PATCH вернулся ошибкой или
 *               процесс печати упал.
 *
 * Пути можно переопределить env-переменной `AGENT_OUTPUT_DIR`
 * (используется как родитель для всех трёх). На MVP «реальной» печати
 * нет — мы просто перекладываем файл из spool/ в printed/, чтобы
 * подтвердить, что весь сетевой flow живой.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const SUBDIRS = ['spool', 'printed', 'failed'];

export async function ensureSpoolDirs(rootOverride) {
  const root = rootOverride
    ? resolve(process.cwd(), rootOverride)
    : process.env.AGENT_OUTPUT_DIR
      ? resolve(process.cwd(), process.env.AGENT_OUTPUT_DIR)
      : process.cwd();
  const dirs = {};
  for (const sub of SUBDIRS) {
    const p = join(root, sub);
    if (!existsSync(p)) await mkdir(p, { recursive: true });
    dirs[sub] = p;
  }
  return { root, ...dirs };
}

/**
 * Имя файла для payload-а: `job-<id>-<timestamp>.<ext>`. Расширение
 * выводим из content-type; если он непонятный — пытаемся вытащить из
 * URL; иначе кладём как `.bin` (агент не умеет читать содержимое и
 * это ок: backend сам знает, что отдал).
 */
export function buildJobFilename(jobId, contentType, payloadUrl) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `job-${jobId}-${ts}${guessExt(contentType, payloadUrl)}`;
}

function guessExt(contentType, payloadUrl) {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('html')) return '.html';
  if (ct.includes('pdf')) return '.pdf';
  if (ct.includes('png')) return '.png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  if (ct.includes('svg')) return '.svg';
  if (ct.includes('json')) return '.json';
  if (ct.includes('text/plain')) return '.txt';
  try {
    const fromUrl = extname(new URL(payloadUrl).pathname);
    if (fromUrl) return fromUrl;
  } catch {
    /* ignore non-URL payloadUrls */
  }
  return '.bin';
}

export async function saveToSpool(spoolDir, filename, buffer) {
  const filePath = join(spoolDir, filename);
  await writeFile(filePath, buffer);
  return filePath;
}

/** Перенос файла spool → printed/failed. Возвращает новый путь. */
export async function moveToFolder(srcPath, destDir, filename) {
  const destPath = join(destDir, filename);
  await rename(srcPath, destPath);
  return destPath;
}
