#!/usr/bin/env node
/**
 * sewing-print-agent — CLI entrypoint.
 *
 * Два режима работы (см. apps/agent/README.md):
 *
 *   1) Pairing:
 *        node src/index.mjs --pair --server <URL> --code <PAIRING_CODE>
 *      Меняет короткий pairingCode на постоянный agentToken и
 *      сохраняет локальный agent-config.json.
 *
 *   2) Normal:
 *        node src/index.mjs
 *      Опрос /api/print-jobs/agent каждые 2-3 сек, скачивание payload,
 *      сохранение в spool/printed/failed, отчёт PATCH PRINTED|FAILED.
 *
 * Дополнительно:
 *   --config <path>   путь к JSON-конфигу (по умолчанию ./agent-config.json).
 *
 * Зависимостей в рантайме нет: только Node.js >= 18 (нужен глобальный
 * fetch). Сборка в Windows .exe — `npm run build:win` (esbuild + pkg).
 */

import { log } from './logger.mjs';
import { resolveConfigPath } from './config.mjs';
import { runLoop, runPair } from './runtime.mjs';

main().catch((err) => {
  log.error(`Fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

async function main() {
  const argv = process.argv.slice(2);

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

  await runLoop({ configPath });
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function argAfter(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) return undefined;
  return next;
}

function printUsage() {
  const lines = [
    'sewing-print-agent — print-агент рабочего места.',
    '',
    'Команды:',
    '  pair:    sewing-print-agent --pair --server <URL> --code <PAIRING_CODE>',
    '  normal:  sewing-print-agent',
    '',
    'Опции:',
    '  --config <path>   Путь к JSON-конфигу (по умолчанию ./agent-config.json).',
    '  --help, -h        Показать эту справку.',
    '',
    'Переменные окружения:',
    '  AGENT_CONFIG_PATH  Путь к agent-config.json (если не указан --config).',
    '  AGENT_OUTPUT_DIR   Родитель для spool/printed/failed (по умолчанию cwd).',
    '  POLL_INTERVAL_MS   Интервал опроса (по умолчанию 3000).',
    '  SERVER_URL         Fallback для --server при pairing.',
    '',
    'Артефакты:',
    '  agent-config.json  Локальный конфиг с printerId+agentToken.',
    '  spool/             Свежие скачанные payload-ы (до подтверждения).',
    '  printed/           Успешные (отмечены PRINTED).',
    '  failed/            Упавшие (отмечены FAILED).',
  ];
  log.info(lines.join('\n'));
}
