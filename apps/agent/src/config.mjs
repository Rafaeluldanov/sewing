/**
 * Хранилище локального конфига агента.
 *
 * Конфиг — это маленький JSON рядом с exe (по умолчанию
 * `agent-config.json` в текущей рабочей папке). Хранит постоянный
 * `agentToken`, выданный сервером после pair-а: его достаточно, чтобы
 * авторизовать heartbeat / poll / patch.
 *
 * Путь можно переопределить:
 *   - флагом CLI `--config <path>`
 *   - env-переменной `AGENT_CONFIG_PATH`
 *
 * Эти поля читаются из принятого CLI-результата, см. `index.mjs`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_CONFIG_FILENAME = 'agent-config.json';

export function resolveConfigPath(cliPath) {
  const fromEnv = process.env.AGENT_CONFIG_PATH;
  const raw = cliPath ?? fromEnv ?? DEFAULT_CONFIG_FILENAME;
  return resolve(process.cwd(), raw);
}

export async function loadConfig(configPath) {
  if (!existsSync(configPath)) {
    throw new Error(
      `Не найден файл конфига ${configPath}. ` +
        `Сначала запустите агент с флагом --pair (см. README.md).`,
    );
  }
  const raw = await readFile(configPath, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Конфиг ${configPath} не разбирается как JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!cfg.serverUrl || !cfg.agentToken || !cfg.printerId) {
    throw new Error(
      `Конфиг ${configPath} неполный: нужны serverUrl, printerId и agentToken. ` +
        `Перезапустите --pair.`,
    );
  }
  return cfg;
}

export async function saveConfig(configPath, cfg) {
  await writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
