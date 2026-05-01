/**
 * Helper для опроса системных принтеров Windows.
 *
 * Используется в `runtime.mjs` после pair-а, чтобы агент мог сообщить
 * серверу список доступных Windows-принтеров (см.
 * `docs/domain.md §17b «Физический Windows-принтер»`,
 * `apps/agent/README.md`).
 *
 * На Windows получаем список через PowerShell:
 *   `Get-Printer | Select-Object -ExpandProperty Name`
 *
 * На Linux/macOS (для dev / pkg-сборки на CI) PowerShell отсутствует —
 * helper возвращает пустой массив, а не падает: агент в этом случае
 * шлёт серверу пустой список, UI рисует «агент ещё не нашёл системных
 * принтеров» (что и есть правда — на не-Windows-машине печатать
 * неоткуда).
 */

import { spawn } from 'node:child_process';

const POWERSHELL_TIMEOUT_MS = 10_000;

/**
 * Получить список системных Windows-принтеров. Никогда не бросает —
 * любая ошибка превращается в `{ printers: [], error }`, чтобы агент
 * не падал из-за отсутствия PowerShell или прав.
 *
 * @returns {Promise<{ printers: string[], error: string | null }>}
 */
export async function listWindowsPrinters() {
  if (process.platform !== 'win32') {
    return {
      printers: [],
      error: `not running on Windows (platform=${process.platform})`,
    };
  }

  try {
    const stdout = await runPowerShell(
      'Get-Printer | Select-Object -ExpandProperty Name',
    );
    const printers = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { printers: dedupe(printers), error: null };
  } catch (err) {
    return {
      printers: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `PowerShell timed out after ${POWERSHELL_TIMEOUT_MS}ms`,
        ),
      );
    }, POWERSHELL_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `PowerShell exited with code ${code}: ${stderr.trim() || '(no stderr)'}`,
          ),
        );
      }
    });
  });
}
