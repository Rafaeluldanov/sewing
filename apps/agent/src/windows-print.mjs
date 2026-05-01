/**
 * Реальная печать payload-а на конкретный системный Windows-принтер.
 *
 * Для `.pdf` и `.txt` мы используем стандартный механизм Windows
 * ShellExecute через PowerShell `Start-Process -Verb PrintTo` —
 * для каждого расширения в реестре есть запись «чем открывать на
 * печать на конкретный принтер» (Adobe Reader/Foxit/Edge для .pdf,
 * Notepad для .txt). Никаких нативных аддонов, GUI, своих spooler-ов —
 * handler-приложение само ставит документ в очередь нужного принтера
 * и завершается.
 *
 * Для `.html`/`.htm` глагол `printto` системой НЕ гарантирован —
 * Windows для .html сплошь и рядом отвечает «файлу не сопоставлено
 * приложение» (никакой браузер по умолчанию не регистрирует printto
 * под этот тип). Поэтому HTML мы печатаем напрямую через
 * Chrome/Edge в silent-режиме `--kiosk-printing`: задаём выбранный
 * принтер дефолтным через WScript.Network, оборачиваем исходный HTML
 * в авто-`window.print()` и запускаем браузер, ждём пока спулер
 * примет документ, и убиваем процесс по таймауту.
 *
 * Поддерживаемые форматы: `.html`, `.htm`, `.pdf`, `.txt`. Всё
 * остальное — `FAILED` с явным сообщением: «Unsupported print file
 * type: <ext>».
 *
 * Известные ограничения:
 *
 * - Для .pdf на машине должен быть установлен PDF-viewer с
 *   зарегистрированным глаголом `printto` (Adobe Reader, Foxit,
 *   современный Edge). Без него Windows ответит
 *   «There is no application associated with the specified file …»,
 *   и мы пробросим этот текст в `PrintJob.errorMessage`.
 * - Для .html на машине должен стоять Chrome или Edge в стандартных
 *   путях (`C:\Program Files\...`). Если ни одного нет — job уйдёт
 *   в `FAILED` с сообщением «Chrome/Edge not found on system for
 *   HTML printing».
 * - Мы НЕ ждём, пока принтер физически закончит лист бумаги — мы
 *   ждём только пока handler-приложение поставит документ в очередь
 *   и завершится (или истечёт kiosk-таймаут для браузера). Этого
 *   достаточно, чтобы безопасно пометить файл как PRINTED.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { log } from './logger.mjs';

const PRINT_TIMEOUT_MS = 60_000;
const POWERSHELL_TIMEOUT_BUFFER_MS = 5_000;

// Сколько ждём, пока chromium успеет отрендерить страницу и положить
// задание в очередь Windows-спулера, прежде чем убить процесс. Именно
// «убить»: --kiosk-printing глушит диалог print preview, но окно
// браузера само не закрывается. window.close() из инжектированного
// скрипта помогает, но не везде срабатывает (chromium запрещает
// close() для окон, открытых не через window.open).
const BROWSER_PRINT_WAIT_MS = 15_000;

const SUPPORTED_KINDS = new Set(['html', 'pdf', 'txt']);

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * Возвращает «тип печати» по расширению файла (приоритет) или по
 * Content-Type (fallback). Если ни то ни другое не распознано —
 * `null` (вызывающая сторона должна закрыть job как FAILED с
 * `Unsupported print file type: …`).
 *
 * @param {string} filePath
 * @param {string} [contentType]
 * @returns {'html' | 'pdf' | 'txt' | null}
 */
export function detectPrintableKind(filePath, contentType) {
  const ext = extname(filePath ?? '').toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.txt') return 'txt';
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('text/html')) return 'html';
  if (ct.includes('application/pdf')) return 'pdf';
  if (ct.includes('text/plain')) return 'txt';
  return null;
}

/** Список поддерживаемых форматов — для логов и README. */
export function listSupportedPrintKinds() {
  return Array.from(SUPPORTED_KINDS);
}

/**
 * Реально напечатать файл на выбранный Windows-принтер через
 * системный handler PrintTo (`.pdf`, `.txt`).
 *
 * Для HTML использовать `printHtmlWithBrowser` — у Windows нет
 * гарантированной ассоциации `printto` для .html.
 *
 * Бросает `Error` с понятным сообщением (это сообщение уйдёт в
 * `PrintJob.errorMessage`):
 *
 * - не Windows                         → "Windows printing is supported only on Windows agents"
 * - пустое имя принтера                → "Selected Windows printer was not provided"
 * - неподдерживаемое расширение        → "Unsupported print file type: <ext>"
 * - принтер не найден в системе        → "Selected Windows printer not found: <name>"
 * - PowerShell/Start-Process упал      → "PowerShell print command failed: <stderr>"
 * - handler-приложение не завершилось  → "Print helper did not exit within <ms>ms"
 *
 * @param {string} filePath  Абсолютный путь к payload-у на диске.
 * @param {string} printerName Имя системного Windows-принтера
 *   (как `selectedWindowsPrinter`, как в `Get-Printer`).
 * @param {{ timeoutMs?: number }} [options]
 */
export async function printFileOnWindows(filePath, printerName, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : PRINT_TIMEOUT_MS;

  assertWindowsPrintInputs(filePath, printerName);

  const kind = detectPrintableKind(filePath);
  if (!SUPPORTED_KINDS.has(kind)) {
    const ext = extname(filePath) || '(no ext)';
    throw new Error(`Unsupported print file type: ${ext}`);
  }

  const absFile = isAbsolute(filePath) ? filePath : resolve(filePath);

  // Скрипт делает три вещи строго в этом порядке:
  //   1) проверяет, что принтер существует — иначе понятная ошибка;
  //   2) запускает зарегистрированный для расширения handler через
  //      ShellExecute(verb=printto) с именем принтера;
  //   3) ждёт, пока handler завершится (= документ ушёл в очередь).
  // Если handler не завершился за timeoutMs — убиваем и кидаем ошибку.
  const psScript = [
    `$ErrorActionPreference = 'Stop'`,
    `$file = ${psQuote(absFile)}`,
    `$printer = ${psQuote(printerName)}`,
    `$existing = Get-Printer -Name $printer -ErrorAction SilentlyContinue`,
    `if (-not $existing) { throw "Selected Windows printer not found: $printer" }`,
    // -ArgumentList требует строку с собственными кавычками — иначе
    // принтер с пробелами в имени (Microsoft Print to PDF) рвётся.
    `$arg = '"' + $printer + '"'`,
    `$proc = Start-Process -FilePath $file -Verb PrintTo -ArgumentList $arg -PassThru`,
    `if ($proc) {`,
    `  [void]$proc.WaitForExit(${timeoutMs})`,
    `  if (-not $proc.HasExited) {`,
    `    try { $proc.Kill() } catch {}`,
    `    throw "Print helper did not exit within ${timeoutMs}ms"`,
    `  }`,
    `}`,
  ].join('\n');

  await runPowerShell(psScript, timeoutMs + POWERSHELL_TIMEOUT_BUFFER_MS);
}

/**
 * Напечатать HTML-файл на выбранный Windows-принтер через silent
 * Chrome/Edge (`--kiosk-printing`).
 *
 * Шаги:
 *   1. Найти chrome.exe / msedge.exe в стандартных путях. Если ни
 *      одного нет — `Chrome/Edge not found on system for HTML
 *      printing`.
 *   2. Через PowerShell проверить, что выбранный принтер существует,
 *      и временно сделать его дефолтным (WScript.Network → SetDefaultPrinter).
 *      Текущее значение default printer-а мы сознательно НЕ откатываем
 *      обратно: на Windows-станции рядом с принтером это и есть
 *      рабочий принтер, никакой пользователь там за дефолтом не следит.
 *   3. Записать рядом с исходным payload-ом (в той же папке spool/,
 *      где уже лежит скачанный `job-<id>.html`) HTML-копию с
 *      инжектированным `window.print()` — `--kiosk-printing` глушит
 *      диалог print preview, но не вызывает печать сам по себе,
 *      нужен реальный `window.print()` со страницы. Сознательно НЕ
 *      пишем в `%TEMP%`: чем дальше путь от исходного файла, тем
 *      больше шансов словить «file not found» от Edge на машинах,
 *      где у профиля браузера ограниченный доступ к Temp (запуск
 *      под другим пользователем, AV-карантин и т.п.).
 *   4. Запустить браузер с изолированным `--user-data-dir`, без
 *      first-run-страницы и расширений, файл подсунуть как `file:///…`.
 *   5. Подождать `BROWSER_PRINT_WAIT_MS` (15s) — этого хватает,
 *      чтобы страница загрузилась и задание ушло в очередь спулера.
 *      Затем убить процесс браузера и удалить временные каталоги.
 *
 * Бросает `Error` с понятным сообщением (попадает в
 * `PrintJob.errorMessage`):
 *
 * - не Windows                         → "Windows printing is supported only on Windows agents"
 * - пустое имя принтера                → "Selected Windows printer was not provided"
 * - принтер не найден в системе        → "Selected Windows printer not found: <name>"
 * - не нашли Chrome/Edge               → "Chrome/Edge not found on system for HTML printing"
 * - не смогли выставить default        → "PowerShell print command failed: <stderr>"
 * - browser process spawn error        → "Browser print command failed: <reason>"
 *
 * @param {string} filePath  Абсолютный путь к .html / .htm файлу.
 * @param {string} printerName Имя системного Windows-принтера.
 * @param {{ timeoutMs?: number, browserWaitMs?: number }} [options]
 */
export async function printHtmlWithBrowser(filePath, printerName, options = {}) {
  const psTimeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : PRINT_TIMEOUT_MS;
  const browserWaitMs = Number.isFinite(options.browserWaitMs)
    ? options.browserWaitMs
    : BROWSER_PRINT_WAIT_MS;

  assertWindowsPrintInputs(filePath, printerName);

  const browser = findChromeOrEdge();
  if (!browser) {
    throw new Error('Chrome/Edge not found on system for HTML printing');
  }
  log.info(`Using ${browser.name} for HTML printing: ${browser.path}`);

  const absFile = isAbsolute(filePath) ? filePath : resolve(filePath);

  log.info(`Setting default printer: ${printerName}`);
  await setDefaultPrinter(printerName, psTimeoutMs);

  const wrapper = await writeAutoPrintWrapper(absFile);
  log.info(`Auto-print wrapper written next to job: ${wrapper.path}`);
  let userDataDir = null;
  try {
    userDataDir = await mkdtemp(join(tmpdir(), 'sewing-chrome-'));
    const args = [
      '--kiosk-printing',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-features=Translate,DefaultBrowserSettingEnforcement',
      `--user-data-dir=${userDataDir}`,
      toFileUrl(wrapper.path),
    ];
    log.info(
      `Launching browser print (waitMs=${browserWaitMs}, args="${browser.name} ${args.length} args")`,
    );
    await runBrowserPrint(browser.path, args, browserWaitMs);
    log.info('Print completed');
  } finally {
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
    // ВРЕМЕННО: не удаляем .autoprint.html сразу после печати,
    // чтобы исключить ранний cleanup как причину Edge "file not found"
    // и иметь возможность глазами посмотреть, что именно подсунули
    // браузеру. Файл остаётся в spool/ (а после mark-as-printed
    // переедет рядом с оригиналом в printed/).
    log.info(`Auto-print wrapper retained for diagnostics: ${wrapper.path}`);
  }
}

/**
 * Найти chrome.exe или msedge.exe в стандартных путях Windows.
 * Сначала Chrome (он чаще встречается в киосках), потом Edge.
 *
 * @returns {{ path: string, name: 'chrome' | 'edge' } | null}
 */
function findChromeOrEdge() {
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return { path: p, name: 'chrome' };
  }
  for (const p of EDGE_PATHS) {
    if (existsSync(p)) return { path: p, name: 'edge' };
  }
  return null;
}

/**
 * Сделать выбранный Windows-принтер дефолтным. Заодно проверяет,
 * что принтер вообще виден системе — иначе кидает понятную ошибку
 * `Selected Windows printer not found: <name>` (тот же текст, что
 * и в PrintTo-ветке).
 *
 * Используем COM-объект `WScript.Network`: он работает без админских
 * прав в отличие от `Set-Printer -IsDefault` или WMI.
 */
async function setDefaultPrinter(printerName, timeoutMs) {
  const psScript = [
    `$ErrorActionPreference = 'Stop'`,
    `$printer = ${psQuote(printerName)}`,
    `$existing = Get-Printer -Name $printer -ErrorAction SilentlyContinue`,
    `if (-not $existing) { throw "Selected Windows printer not found: $printer" }`,
    `$net = New-Object -ComObject WScript.Network`,
    `$net.SetDefaultPrinter($printer)`,
  ].join('\n');
  await runPowerShell(psScript, timeoutMs + POWERSHELL_TIMEOUT_BUFFER_MS);
}

/**
 * Положить рядом с исходным HTML-файлом (в ту же папку spool/) копию
 * с инжектированным `window.print()`. С `--kiosk-printing` chromium
 * тут же молча шлёт документ на default-принтер и пытается закрыть
 * окно. Возвращает путь к копии.
 *
 * ВРЕМЕННО: cleanup отключён — файл `.autoprint.html` остаётся на
 * диске после печати для диагностики (см. вызов в
 * `printHtmlWithBrowser`). Хотим исключить ранний unlink как
 * причину «file not found» в Edge.
 *
 * Мы НЕ пишем в `%TEMP%` сознательно: на Windows-станциях, где
 * агент запускается под service-account / альтернативным
 * пользователем, путь вида `C:\Users\X\AppData\Local\Temp\sewing-print-…\print.html`
 * системный Edge мог открывать как «file not found». Папка spool/
 * уже доказана как читаемая (туда только что успешно записан
 * исходный payload), так что класть auto-print copy туда же —
 * самый безопасный вариант.
 *
 * Мы НЕ модифицируем сам исходный файл: после печати он переезжает
 * в `printed/` как архив, и инжект в архиве нам не нужен.
 *
 * Имя копии — `<basename>.autoprint.html`, чтобы не пересечься с
 * шаблоном `job-<id>-<ts>.<ext>` и чтобы при ручном осмотре spool/
 * было понятно, откуда файл.
 */
async function writeAutoPrintWrapper(htmlPath) {
  const original = await readFile(htmlPath, 'utf8');
  const injection = `
<script>
(function() {
  function go() {
    try { window.print(); } catch (e) {}
    setTimeout(function() { try { window.close(); } catch (e) {} }, 2000);
  }
  if (document.readyState === 'complete') {
    setTimeout(go, 200);
  } else {
    window.addEventListener('load', function() { setTimeout(go, 200); });
  }
})();
</script>
`;
  let content;
  if (/<\/body>/i.test(original)) {
    content = original.replace(/<\/body>/i, `${injection}</body>`);
  } else if (/<\/html>/i.test(original)) {
    content = original.replace(/<\/html>/i, `${injection}</html>`);
  } else {
    content = original + injection;
  }
  const ext = extname(htmlPath);
  const stem = basename(htmlPath, ext);
  const wrapperPath = join(dirname(htmlPath), `${stem}.autoprint.html`);
  await writeFile(wrapperPath, content, 'utf8');
  return {
    path: wrapperPath,
  };
}

/**
 * `C:\foo\bar baz.html` → `file:///C:/foo/bar%20baz.html`.
 * chromium принимает file-URL только с прямыми слэшами и
 * URL-экранированными пробелами; иначе путь обрезается на первом
 * пробеле и страница не открывается.
 */
function toFileUrl(absPath) {
  const forward = absPath.replace(/\\/g, '/');
  // encodeURI оставляет `/` и `:` — ровно то, что нам нужно.
  const encoded = encodeURI(forward);
  return `file:///${encoded.replace(/^\/+/, '')}`;
}

/**
 * Запустить браузер и подождать `waitMs` (либо exit / spawn error).
 * По истечении ждём — убиваем процесс. Это нормальный happy-path:
 * `--kiosk-printing` не закрывает окно само, а инжектированный
 * `window.close()` chromium блокирует, так что нам и нужно убить
 * процесс снаружи.
 *
 * Любая ошибка спавна (нет exe, нет прав) превращается в Error.
 * Ненулевой exit-code до таймаута тоже считаем ошибкой — это уже
 * аномалия (chromium не запустился, padlocked profile и т.п.).
 */
function runBrowserPrint(browserExe, args, waitMs) {
  return new Promise((resolveP, rejectP) => {
    let child;
    try {
      child = spawn(browserExe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      rejectP(
        new Error(
          `Browser print command failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    let settled = false;
    const settle = (handler) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handler();
    };
    const timer = setTimeout(() => {
      settle(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolveP();
      });
    }, waitMs);
    child.on('error', (err) => {
      settle(() => {
        rejectP(new Error(`Browser print command failed: ${err.message}`));
      });
    });
    child.on('exit', (code) => {
      settle(() => {
        if (code === 0 || code === null) {
          resolveP();
          return;
        }
        const detail = stderr.trim() || `exit code ${code}`;
        rejectP(new Error(`Browser print command failed: ${detail}`));
      });
    });
  });
}

/**
 * Общие проверки на входе в любую windows-print функцию:
 * платформа, имя принтера, путь к файлу. Кидает с теми же
 * сообщениями, что и раньше — чтобы текст в `PrintJob.errorMessage`
 * остался стабильным для UI / тестов.
 */
function assertWindowsPrintInputs(filePath, printerName) {
  if (process.platform !== 'win32') {
    throw new Error('Windows printing is supported only on Windows agents');
  }
  if (!printerName || typeof printerName !== 'string') {
    throw new Error('Selected Windows printer was not provided');
  }
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Print file path was not provided');
  }
}

/**
 * Безопасное цитирование произвольной строки в single-quoted
 * PowerShell-литерал. Внутри одинарных кавычек PS трактует всё
 * буквально, кроме самой одинарной кавычки — её удваиваем.
 */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Запуск PowerShell с переданным скриптом. Возвращает stdout при
 * exit code 0, иначе — Error с stderr. Любой timeout убивает
 * дочерний процесс и тоже превращается в Error.
 *
 * Формат сообщения ошибки специально начинается с
 * "PowerShell print command failed:" — он попадёт в
 * `PrintJob.errorMessage` и поможет менеджеру отличить «не та
 * команда» от «не тот принтер» от «handler упал».
 */
function runPowerShell(command, timeoutMs) {
  return new Promise((resolveP, rejectP) => {
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
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      rejectP(
        new Error(`PowerShell print command timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT — на машине нет powershell.exe (не Windows / урезанный образ).
      rejectP(new Error(`PowerShell print command failed: ${err.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveP(stdout);
        return;
      }
      const detail =
        stderr.trim() || stdout.trim() || `exit code ${code}`;
      rejectP(new Error(`PowerShell print command failed: ${detail}`));
    });
  });
}
