/**
 * Интерактивный setup-wizard агента.
 *
 * Сценарий: оператор скачал `sewing-print-agent.exe` через
 * «Скачать агент» в `/admin/printers/<id>` и запустил его двойным
 * кликом. У exe нет конфига → раньше процесс падал с «Не найден
 * agent-config.json» и Windows-консоль мгновенно закрывалась — было
 * непонятно, что делать.
 *
 * Теперь при отсутствии конфига `index.mjs` зовёт `runSetupWizard`.
 * Wizard в той же консоли:
 *   1. Спрашивает URL сервера (с дефолтом — auto-detect из
 *      env `SERVER_URL` или подсказка `https://prod.teeon.ru`).
 *   2. Спрашивает короткий pairing-код (выдан в карточке принтера).
 *   3. Делает `pair` → сохраняет `agent-config.json` рядом с exe.
 *   4. Опрашивает локальные Windows-принтеры (`Get-Printer`),
 *      апроад-ит их на сервер (`updateWindowsPrinters`).
 *   5. Показывает нумерованный список и просит выбрать «свой»
 *      принтер. Выбор отправляется через
 *      `POST /api/printers/agent/select-windows-printer` — менеджеру
 *      руками ничего трогать не нужно.
 *   6. Возвращает управление в `index.mjs → runLoop`, который
 *      входит в обычный polling-цикл.
 *
 * Любая ошибка наружу не выходит: caught в `index.mjs`, который
 * показывает ошибку и держит окно открытым (`pauseBeforeExit`), —
 * чтобы оператор мог прочитать причину, скопировать сообщение и
 * запустить exe ещё раз.
 *
 * Никаких сторонних зависимостей: только `node:readline` (входит в
 * Node 20, попадает в `pkg`-сборку).
 */

import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { log } from './logger.mjs';
import {
  normalizeApiUrl,
  pairAgent,
  selectWindowsPrinter,
  uploadWindowsPrinters,
} from './api.mjs';
import { saveConfig } from './config.mjs';
import { listWindowsPrinters } from './windows-printers.mjs';

const DEFAULT_SERVER_URL = 'https://prod.teeon.ru';

/**
 * Запуск wizard-а. Возвращает готовый `cfg`, такой же, как раньше
 * писал `runPair` — `index.mjs` после этого вызывает `runLoop` без
 * перезапуска процесса (в отличие от старого `runPair`, который
 * требовал второй запуск exe).
 */
export async function runSetupWizard({ configPath, defaultServerUrl } = {}) {
  printWelcome();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const serverUrl = await askServerUrl(rl, defaultServerUrl);
    const code = await askPairingCode(rl);

    const apiUrl = normalizeApiUrl(serverUrl);
    log.info(`Шаг 1/3: подключение к ${apiUrl}…`);
    const pairResult = await pairAgent(apiUrl, code);
    const cfg = {
      serverUrl: stripTrailingSlash(serverUrl),
      apiUrl,
      printerId: pairResult.printerId,
      printerName: pairResult.printerName,
      agentToken: pairResult.agentToken,
      pairedAt: new Date().toISOString(),
    };
    await saveConfig(configPath, cfg);
    log.info(
      `OK. Принтер «${cfg.printerName}» (id=${cfg.printerId}) подключён.`,
    );
    log.info(`Конфиг сохранён в ${configPath}`);

    log.info('Шаг 2/3: ищу системные Windows-принтеры…');
    const host = hostname();
    const local = await listWindowsPrinters();
    if (local.error) {
      log.warn(`listWindowsPrinters: ${local.error}`);
    }
    log.info(
      `Найдено принтеров: ${local.printers.length}.${
        local.printers.length > 0
          ? ` (${local.printers.join(', ')})`
          : ' (это ок для не-Windows: выбор пропускаем)'
      }`,
    );
    await uploadWindowsPrinters(apiUrl, cfg.agentToken, host, local.printers);

    if (local.printers.length === 0) {
      // Не на Windows (или Get-Printer не отдал ничего) — выбирать
      // нечего, агент будет крутиться и ждать, пока менеджер
      // подцепит принтер позже. Это тоже валидный путь (например
      // dev-проверка с Linux-машины).
      log.warn(
        'Системных принтеров не видно — выбор пропускаем. Менеджер ' +
          'может выбрать принтер позже в /admin/printers/' +
          cfg.printerId +
          '.',
      );
    } else {
      log.info('Шаг 3/3: выберите физический принтер для печати.');
      const chosen = await askPrinterChoice(rl, local.printers);
      log.info(`Отправляю выбор «${chosen}» на сервер…`);
      await selectWindowsPrinter(apiUrl, cfg.agentToken, chosen);
      log.info(`OK. Печать пойдёт на «${chosen}».`);
    }

    log.info('Готово. Запускаю рабочий цикл — это окно можно свернуть,');
    log.info('но НЕ закрывать: пока окно открыто, агент принимает задания.');
    return cfg;
  } finally {
    rl.close();
  }
}

function printWelcome() {
  const lines = [
    '',
    '==============================================================',
    '  sewing-print-agent — первичная настройка',
    '==============================================================',
    '  1) Сервер (откуда печатаем).',
    '  2) Pairing-код из карточки принтера в админке.',
    '  3) Выбор физического Windows-принтера.',
    '',
    '  Отмена в любой момент: Ctrl+C.',
    '==============================================================',
    '',
  ];
  for (const line of lines) process.stdout.write(line + '\n');
}

async function askServerUrl(rl, defaultServerUrl) {
  const fallback =
    defaultServerUrl ?? process.env.SERVER_URL ?? DEFAULT_SERVER_URL;
  while (true) {
    const raw = await question(
      rl,
      `URL сервера (Enter = ${fallback}): `,
    );
    const value = (raw.trim() || fallback).trim();
    if (!/^https?:\/\//i.test(value)) {
      log.warn('URL должен начинаться с http:// или https://. Повторите.');
      continue;
    }
    return stripTrailingSlash(value);
  }
}

async function askPairingCode(rl) {
  while (true) {
    const raw = await question(rl, 'Pairing-код (PAIR-XXXX-XXXX): ');
    const value = raw.trim();
    if (value.length < 4) {
      log.warn('Слишком короткий код, попробуйте ещё раз.');
      continue;
    }
    return value;
  }
}

async function askPrinterChoice(rl, printers) {
  for (let i = 0; i < printers.length; i += 1) {
    process.stdout.write(`  [${i + 1}] ${printers[i]}\n`);
  }
  while (true) {
    const raw = await question(
      rl,
      `Выберите номер принтера (1-${printers.length}): `,
    );
    const idx = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(idx) && idx >= 1 && idx <= printers.length) {
      return printers[idx - 1];
    }
    // Допустим также ввод имени напрямую — оператору так может быть
    // удобнее, если принтер только один или его имя короче цифры.
    const direct = printers.find((p) => p === raw.trim());
    if (direct) return direct;
    log.warn(`Не понял ответ «${raw.trim()}». Введите число от 1 до ${printers.length}.`);
  }
}

function question(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer ?? ''));
  });
}

function stripTrailingSlash(s) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
