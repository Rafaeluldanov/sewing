#!/usr/bin/env node
/**
 * sewing-print-agent — CLI entrypoint.
 *
 * Три сценария запуска:
 *
 *   1) Двойной клик exe (типичный путь для оператора):
 *      - конфига нет → запускается интерактивный wizard
 *        (`runSetupWizard`, см. `wizard.mjs`): URL сервера, pairing-код,
 *        выбор Windows-принтера. По завершении — сразу `runLoop` в той же
 *        консоли, окно остаётся открытым.
 *      - конфиг уже есть → сразу `runLoop`.
 *
 *   2) CLI-pair (для скриптов / повторной привязки):
 *        sewing-print-agent --pair --server <URL> --code <PAIRING_CODE>
 *      Меняет короткий pairingCode на постоянный agentToken и
 *      сохраняет локальный agent-config.json. Полезно, если оператор
 *      хочет перепривязать тот же exe к другому принтеру без wizard-а.
 *
 *   3) CLI-loop:
 *        sewing-print-agent
 *      То же, что (1) с готовым конфигом.
 *
 * Дополнительно:
 *   --config <path>       путь к JSON-конфигу (по умолчанию ./agent-config.json).
 *   --no-wizard           отключить wizard, требовать готовый конфиг
 *                         (для CI / unattended запусков).
 *   --pause-on-exit/--no-pause-on-exit
 *                         форсированно держать окно открытым после
 *                         выхода (по умолчанию — авто: держим, если
 *                         запущены через TTY на Windows, чтобы не
 *                         схлопывалась консоль при двойном клике).
 *
 * Зависимостей в рантайме нет: только Node.js >= 18 (нужен глобальный
 * fetch). Сборка в Windows .exe — `npm run build:win` (esbuild + pkg).
 */

import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { log } from './logger.mjs';
import { resolveConfigPath } from './config.mjs';
import { runLoop, runPair } from './runtime.mjs';
import { runSetupWizard } from './wizard.mjs';

const argv = process.argv.slice(2);
const wantPause = shouldPauseOnExit(argv);

main().catch(async (err) => {
  log.error(`Fatal: ${err instanceof Error ? err.stack : String(err)}`);
  await pauseBeforeExit('Произошла ошибка. Нажмите Enter, чтобы закрыть окно…');
  process.exit(1);
});

async function main() {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    printUsage();
    return;
  }

  const configPath = resolveConfigPath(argAfter(argv, '--config'));

  if (hasFlag(argv, '--pair')) {
    const serverUrl = argAfter(argv, '--server') ?? process.env.SERVER_URL;
    const code = argAfter(argv, '--code');
    await runPair({ serverUrl, code, configPath });
    return;
  }

  // Если конфига нет — запускаем wizard. Это спасает оператора от
  // молчаливого падения при двойном клике exe, см. README §«Первый
  // запуск». `--no-wizard` оставлен для CI / служебных запусков, где
  // мы хотим явный фейл без интерактива.
  if (!existsSync(configPath) && !hasFlag(argv, '--no-wizard')) {
    const cfg = await runSetupWizard({
      configPath,
      defaultServerUrl: argAfter(argv, '--server') ?? process.env.SERVER_URL,
    });
    log.info(`Конфигурация готова, переходим в рабочий цикл (printer=${cfg.printerName}).`);
  }

  await runLoop({ configPath });
}

function hasFlag(av, name) {
  return av.includes(name);
}

function argAfter(av, name) {
  const i = av.indexOf(name);
  if (i === -1) return undefined;
  const next = av[i + 1];
  if (!next || next.startsWith('--')) return undefined;
  return next;
}

/**
 * Когда удерживать консоль открытой после выхода:
 *   - явный `--pause-on-exit` всегда включает;
 *   - `--no-pause-on-exit` всегда выключает (CI/служебные запуски);
 *   - иначе — авто-режим: держим, если оператор запустил двойным
 *     кликом на Windows (родитель — explorer.exe, stdin=TTY).
 *     На Linux/macOS pause не нужен — там обычно запускают из
 *     терминала, который сам по себе не закрывается.
 */
function shouldPauseOnExit(av) {
  if (hasFlag(av, '--no-pause-on-exit')) return false;
  if (hasFlag(av, '--pause-on-exit')) return true;
  return process.platform === 'win32' && Boolean(process.stdin.isTTY);
}

async function pauseBeforeExit(message) {
  if (!wantPause) return;
  try {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => rl.question(message + '\n', () => resolve()));
    rl.close();
  } catch {
    // На совсем сломанном TTY readline может бросить — это не повод
    // упасть второй раз. Молча выходим.
  }
}

function printUsage() {
  const lines = [
    'sewing-print-agent — print-агент рабочего места.',
    '',
    'Команды:',
    '  pair:    sewing-print-agent --pair --server <URL> --code <PAIRING_CODE>',
    '  normal:  sewing-print-agent           (если конфига нет — запустится wizard)',
    '',
    'Опции:',
    '  --config <path>       Путь к JSON-конфигу (по умолчанию ./agent-config.json).',
    '  --no-wizard           Не запускать интерактивный setup при отсутствии конфига',
    '                        (полезно для CI / unattended запусков — упадёт сразу).',
    '  --pause-on-exit       Всегда держать окно открытым после выхода/ошибки.',
    '  --no-pause-on-exit    Никогда не держать (по умолчанию держим только на',
    '                        Windows-TTY — чтобы консоль не закрылась при дбл-клике).',
    '  --help, -h            Показать эту справку.',
    '',
    'Переменные окружения:',
    '  AGENT_CONFIG_PATH  Путь к agent-config.json (если не указан --config).',
    '  AGENT_OUTPUT_DIR   Родитель для spool/printed/failed (по умолчанию cwd).',
    '  POLL_INTERVAL_MS   Интервал опроса (по умолчанию 3000).',
    '  SERVER_URL         Дефолтный URL для wizard / fallback для --server.',
    '',
    'Артефакты:',
    '  agent-config.json  Локальный конфиг с printerId+agentToken.',
    '  spool/             Свежие скачанные payload-ы (до подтверждения).',
    '  printed/           Успешные (отмечены PRINTED).',
    '  failed/            Упавшие (отмечены FAILED).',
  ];
  log.info(lines.join('\n'));
}
