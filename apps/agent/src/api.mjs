/**
 * HTTP-клиент для backend API из `apps/api`.
 *
 * Один источник истины по эндпоинтам — `docs/api.md §16`:
 *   POST  /api/printers/agent/pair        — обмен pairingCode на agentToken
 *   POST  /api/printers/agent/heartbeat   — «я жив», обновляет lastSeenAt
 *   GET   /api/print-jobs/agent           — берёт PENDING-задание из очереди
 *   PATCH /api/print-jobs/:id             — отчёт PRINTED/FAILED
 *
 * Все методы — тонкие обёртки над глобальным `fetch` (Node 18+),
 * никаких axios/got. Это сознательно: один файл, никаких зависимостей,
 * легко собирается в один exe.
 */

const AGENT_TOKEN_HEADER = 'x-printer-agent-token';

/**
 * Превращает `https://stage.teeon.ru` → `https://stage.teeon.ru/api`,
 * не дублируя префикс если он уже есть. Trailing slash снимаем.
 */
export function normalizeApiUrl(serverUrl) {
  const stripped = stripTrailingSlash(serverUrl);
  if (/\/api$/.test(stripped)) return stripped;
  return `${stripped}/api`;
}

function stripTrailingSlash(s) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function authHeaders(token) {
  return { [AGENT_TOKEN_HEADER]: token };
}

export async function pairAgent(apiUrl, pairingCode) {
  const res = await fetch(`${apiUrl}/printers/agent/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode }),
  });
  if (!res.ok) {
    throw new Error(
      `Pair failed: HTTP ${res.status} ${await safeText(res)}`,
    );
  }
  return res.json();
}

/**
 * Возвращает текущий выбор менеджера: имя физического Windows-принтера
 * (`selectedWindowsPrinter`) или `null`, если ещё не выбран. Сервер
 * параллельно обновляет `Printer.lastSeenAt`/`isOnline`.
 */
export async function heartbeat(apiUrl, token) {
  const res = await fetch(`${apiUrl}/printers/agent/heartbeat`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    throw new Error(`Heartbeat failed: HTTP ${res.status}`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Старый сервер мог не возвращать тело — это ок.
    body = null;
  }
  return {
    selectedWindowsPrinter:
      body && typeof body.selectedWindowsPrinter === 'string'
        ? body.selectedWindowsPrinter
        : null,
  };
}

/**
 * Сообщает серверу `hostName` Windows-станции и список её системных
 * принтеров. См. `POST /api/printers/agent/windows-printers` в
 * `docs/api.md §16`. Возвращает текущий `selectedWindowsPrinter`,
 * чтобы агент сразу знал, на какой принтер печатать.
 */
export async function uploadWindowsPrinters(apiUrl, token, hostName, printers) {
  const res = await fetch(`${apiUrl}/printers/agent/windows-printers`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ hostName, printers }),
  });
  if (!res.ok) {
    throw new Error(
      `Upload windows-printers failed: HTTP ${res.status} ${await safeText(res)}`,
    );
  }
  return res.json();
}

export async function pollJobs(apiUrl, token) {
  const res = await fetch(`${apiUrl}/print-jobs/agent`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(
      `Poll failed: HTTP ${res.status} ${await safeText(res)}`,
    );
  }
  return res.json();
}

export async function downloadPayload(payloadUrl) {
  const res = await fetch(payloadUrl);
  if (!res.ok) {
    throw new Error(
      `Download failed: HTTP ${res.status} (${payloadUrl})`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType =
    res.headers.get('content-type') ?? 'application/octet-stream';
  return { buffer, contentType };
}

/**
 * Сообщает результат печати. Если `status === 'FAILED'` — обязателен
 * `errorMessage` (валидируется на сервере, см.
 * `UpdatePrintJobStatusSchema` в `packages/shared`).
 */
export async function reportResult(apiUrl, token, jobId, status, errorMessage) {
  const body =
    status === 'FAILED'
      ? { status, errorMessage: errorMessage ?? 'unknown error' }
      : { status };
  const res = await fetch(
    `${apiUrl}/print-jobs/${encodeURIComponent(jobId)}`,
    {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Report failed: HTTP ${res.status} ${await safeText(res)}`,
    );
  }
  return res.json();
}
