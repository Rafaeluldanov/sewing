'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SHOPFLOOR_DISPLAY_MATRIX_STAGES,
  SHOPFLOOR_STAGE_LABELS,
  type ShopfloorDisplayColorBlock,
  type ShopfloorDisplayDto,
  type ShopfloorDisplayMatrixSummary,
  type ShopfloorDisplaySewingColumnDto,
  type ShopfloorEquipmentKind,
  type ShopfloorEquipmentStatus,
  type ShopfloorEquipmentStatusDto,
  type ShopfloorStage,
  type ShopfloorSummaryDto,
} from '@sewing/shared/shopfloor';
import { getApiBaseUrl } from '@/lib/api-base';

interface Props {
  initialSummary: ShopfloorDisplayDto | null;
  initialError: string | null;
}

/**
 * Базовый период polling в нормальном (healthy) режиме (мс).
 *
 * 3 секунды снова допустимы ТОЛЬКО потому, что вокруг уже выстроен
 * полный набор защит, которых не было в первой инкарнации этого
 * значения:
 *   - `FETCH_TIMEOUT_MS = 6000` (≫ 3000) — честный медленный ответ
 *     успевает вернуться и не считается timeout'ом;
 *   - `MAX_NETWORK_GRACE` — первые подряд `Failed to fetch` /
 *     `NetworkError` глотаются молча, UI остаётся `online`;
 *   - degraded fallback (`POLL_INTERVAL_DEGRADED_MS = 15000`) — при
 *     первой же не-transient ошибке cadence уезжает на 15 c, мы не
 *     «долбим» уже плохо отвечающий backend трижды в секунду;
 *   - visibility recovery — при возврате вкладки в visible сначала
 *     один forced refresh, и только потом возобновление 3-секундного
 *     планировщика, без всплеска накопленных таймеров.
 * Без этих защит 3 c точно так же ложно мигали «Нет связи», как и
 * в прошлый раз — поэтому уменьшать `FETCH_TIMEOUT_MS`, ослаблять
 * `MAX_NETWORK_GRACE` или убирать degraded-ветку нельзя.
 *
 * Имя константы оставлено `POLL_INTERVAL_MS` (а не `_OK_MS`),
 * чтобы существующие smoke-тесты и docs/screens.md §9a.2 продолжали
 * ссылаться на одну и ту же сущность.
 */
const POLL_INTERVAL_MS = 3000;

/**
 * Период polling в degraded-режиме (мс) — после первой же ошибки и
 * до возврата успеха. Цель: не «долбить» уже плохо отвечающий backend
 * каждые 3 c, дать ему время восстановиться. 15 c достаточно, чтобы
 * редкие 502/timeout/смена DNS «успевали зажить» между запросами,
 * но при этом первый же успех мгновенно вернёт нас на 3 c.
 *
 * ВАЖНО: degraded cadence обязательно должен оставаться существенно
 * больше базового (15 ≫ 3) — это и есть главный «тормоз», который
 * делает базовые 3 c безопасными. См. блок-комментарий у
 * `POLL_INTERVAL_MS` ниже.
 */
const POLL_INTERVAL_DEGRADED_MS = 15000;

/**
 * Жёсткий timeout одного fetch-запроса (мс).
 *
 * 6 c намеренно с большим запасом относительно нормальной latency
 * (`getDisplaySummary` отдаёт ~150–500 мс на realistic seed'е). Старое
 * значение 2500 мс при «3000/2500» поллинге обрезало даже честные
 * 1–2-секундные ответы, как только сеть слегка тормозила.
 *
 * При recursive `setTimeout`-планировщике (см. `scheduleNext` ниже)
 * следующий tick ставится только из `finally` текущего, поэтому
 * timeout МОЖЕТ быть больше базового интервала: «наслаивание»
 * запросов исключено самим планировщиком (а не сравнением
 * `FETCH_TIMEOUT_MS` ⇔ `POLL_INTERVAL_MS`).
 */
const FETCH_TIMEOUT_MS = 6000;

/**
 * Сколько подряд soft-ошибок (timeout / network / 5xx / malformed JSON)
 * стерпеть, прежде чем переключить индикатор в режим «Нет связи».
 *
 * При 3-секундном базовом poll и 15-секундном degraded poll это
 * примерно 3 + 4 × 15 ≈ 63 c непрерывных сбоев — достаточно, чтобы
 * единичные glitch'и не мигали индикатором, и при этом оператор
 * быстро узнаёт о реальной потере связи.
 *
 * 401/403 в этот счётчик НЕ входят (см. `classifyError`): они
 * выводятся отдельным auth-статусом и не должны маскироваться под
 * «Нет связи». Любой успешный ответ мгновенно сбрасывает счётчик в 0
 * (см. `refresh`), поэтому индикатор возвращается в «онлайн» уже на
 * первом успехе.
 *
 * Сам snapshot последнего успешного ответа НИКОГДА не очищается —
 * на экране всегда остаётся последняя валидная картина.
 */
const MAX_SOFT_ERRORS = 5;

/**
 * Сколько подряд `network`-ошибок «съесть молча», не накручивая
 * `failures` и не уводя UI даже в `degraded`.
 *
 * Зачем это вообще нужно. На обычном desktop-Chrome `fetch` падает
 * как `TypeError: Failed to fetch` редко и почти всегда означает
 * реальную проблему. На реальном TV / embedded WebView (Smart-TV
 * Chromium, Android-WebView, проводной шнур, который физически
 * пошатался при уборке, Wi-Fi roaming между точками, переключение
 * HDMI-входа, сон/wake энергосбережения) такие transient
 * `Failed to fetch` / `NetworkError` / `net::ERR_NETWORK_CHANGED`
 * вылезают регулярно по 1–2 штуки подряд, после чего следующий же
 * запрос проходит штатно. Если такие glitch'и считать наравне с
 * timeout/5xx/parse, то экран ложно мигает «обновление замедлено» /
 * «Нет связи», хотя backend всё это время был жив.
 *
 * Поэтому именно для `network` (и ТОЛЬКО для него) выделена
 * маленькая «подушка»: первые `MAX_NETWORK_GRACE` подряд — silent
 * swallow (status: 'transient' в логе, snapshot жив, UI остаётся
 * `online`), дальше — обычная ветка soft-failure. Любой успешный
 * ответ сбрасывает подушку обратно в 0. На остальные ошибки
 * (timeout / server / parse / client) подушка не распространяется —
 * там терпимость уже заложена в `MAX_SOFT_ERRORS`.
 */
const MAX_NETWORK_GRACE = 2;

/**
 * Классификация ошибок fetch'а полл-цикла. Сделана плоским enum'ом
 * (а не вложенными catch'ами по тексту message), чтобы UI и счётчики
 * могли по-разному реагировать без разбора строковых сообщений.
 *
 * - `timeout`  — наш `AbortController` сработал по `FETCH_TIMEOUT_MS`;
 * - `network`  — `fetch` упал до получения HTTP-ответа (DNS/сеть);
 * - `auth`     — HTTP 401/403 (сессия истекла или нет прав);
 * - `server`   — HTTP 5xx (backend ответил, но не справился);
 * - `client`   — прочие 4xx (теоретически не должно быть на read-only
 *                эндпоинте, но классифицируем явно);
 * - `parse`    — HTTP 200, но тело не валидный JSON.
 *
 * Auth трактуется отдельным статусом: на read-only мониторе нет
 * смысла редиректить пользователя (его на этой машине физически нет),
 * но и маскировать «истёк session-cookie» под «Нет связи» нельзя —
 * админу важно увидеть отдельный сигнал.
 */
type FetchErrorKind =
  | 'timeout'
  | 'network'
  | 'auth'
  | 'server'
  | 'client'
  | 'parse';

class FetchClassifiedError extends Error {
  readonly kind: FetchErrorKind;
  readonly status?: number;
  constructor(kind: FetchErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

interface Snapshot {
  /** Последний УСПЕШНО полученный срез. Никогда не очищается ошибкой. */
  summary: ShopfloorDisplayDto | null;
  /** Время последнего УСПЕШНОГО ответа (для «обновлено N с назад»). */
  lastSuccessAt: number;
}

/**
 * Лёгкий debug-канал для DISPLAY board.
 *
 * Зачем нужен: на реальном TV/embedded WebView мы не можем подключить
 * DevTools, а jсо страницы /shopfloor/display нужно понимать, в каком
 * именно состоянии экран — `offline` (5xx/timeout/network), `auth`
 * (401/403, истекла сессия) или `online`. Сами полл-tick'и идут раз
 * в 3–15 секунд, поэтому лог не спамит консоль (явно не «каждую
 * миллисекунду»).
 *
 * Формат фиксирован: `[DISPLAY]` + payload-объект с полями
 * `status / errorKind / failures / authError`. По этому префиксу можно
 * отфильтровать лог в консоли удалённого WebView (Chromium remote
 * debugging) или просто прочитать на месте через chrome://inspect.
 */
function dlog(payload: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  // eslint-disable-next-line no-console
  console.log('[DISPLAY]', payload);
}

function clientApiBase(): string {
  return getApiBaseUrl();
}

/**
 * Безопасно строит абсолютный/относительный URL до API из base + path.
 *
 * Раньше URL собирался через `new URL(path, base)`, что на клиенте
 * работало нормально пока `NEXT_PUBLIC_API_URL` инлайнился во время
 * build'а как абсолютный URL (`https://stage.teeon.ru/api`). Но тот
 * же `getApiBaseUrl()` имеет fallback `'/api'` (относительный
 * путь — для случая, когда nginx проксирует на тот же origin); в
 * этом режиме `new URL('shopfloor/display', '/api/')` бросает
 * `TypeError: Invalid URL`, и мы попадали в catch с classification
 * `network`. На реальном TV такая ошибка визуально неотличима от
 * настоящего «Failed to fetch» и одинаково раздувала `failures`.
 *
 * Здесь мы не дёргаем `URL`-конструктор, а собираем строку напрямую,
 * аккуратно нормализуя слеши на стыке. Никаких внешних зависимостей,
 * никакого SSR/client-разделения (этот хелпер вызывается только из
 * клиентского `refresh`), никакой смены архитектуры — просто
 * детерминированный конкатенатор, поведение которого не зависит от
 * того, абсолютный base или относительный.
 */
function buildRequestUrl(path: string): string {
  const base = clientApiBase().replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    // `fetch()` бросает только при abort (наш timeout) или сетевой
    // ошибке (DNS/CORS/обрыв) — обе ветки даже не попадают в HTTP.
    if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new FetchClassifiedError('timeout', `timeout on ${url}`);
    }
    throw new FetchClassifiedError(
      'network',
      err instanceof Error ? err.message : `network error on ${url}`,
    );
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new FetchClassifiedError(
        'auth',
        `HTTP ${res.status} on ${url}`,
        res.status,
      );
    }
    if (res.status >= 500) {
      throw new FetchClassifiedError(
        'server',
        `HTTP ${res.status} on ${url}`,
        res.status,
      );
    }
    throw new FetchClassifiedError(
      'client',
      `HTTP ${res.status} on ${url}`,
      res.status,
    );
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new FetchClassifiedError('parse', `invalid JSON on ${url}`);
  }
}

export function ShopfloorDisplayBoard({
  initialSummary,
  initialError,
}: Props) {
  // ВАЖНО: `lastSuccessAt` намеренно инициализируется нулём, даже если
  // `initialSummary` уже есть. Если бы мы поставили сюда `Date.now()`,
  // SSR-снимок и первый клиентский render получили бы разные числа
  // (разные процессы, разные моменты времени) → React hydration
  // mismatch (#418/#423/#425). Реальное время первого «success»
  // проставляется уже после mount — в `useEffect` ниже.
  const [snap, setSnap] = useState<Snapshot>({
    summary: initialSummary,
    lastSuccessAt: 0,
  });
  const [failures, setFailures] = useState<number>(initialError ? 1 : 0);
  // Auth-проблема (401/403) — отдельный статус, чтобы не маскировать
  // «истёк session-cookie» под «Нет связи». См. `classifyError` и
  // `display-status` ниже. Сбрасывается на первом же успешном ответе.
  const [authError, setAuthError] = useState<boolean>(false);
  const [, forceTick] = useState(0);
  // Гейт против hydration mismatch: всё, что зависит от текущего
  // времени (часы в шапке, «обновлено N сек назад»), рендерится
  // только ПОСЛЕ маунта. До этого момента SSR и клиент видят
  // одинаковую разметку с stable placeholder'ом.
  const [mounted, setMounted] = useState(false);
  // Recursive `setTimeout` (а не `setInterval`) даёт «честный» backoff:
  // следующий tick ставится только из `finally` текущего, поэтому
  // ни запросы не наслаиваются, ни планировщик не тикает быстрее,
  // чем backend успевает отвечать. Imperative-ref'ы держат текущий
  // таймер и in-flight контроллер, чтобы безопасно убрать их на
  // unmount (и не словить setState после размонтирования).
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Предыдущий УСПЕШНЫЙ snapshot — нужен только для diff'а ячеек
  // матрицы (см. блок «flash на изменение значения» ниже). Намеренно
  // живёт в ref'е, а не в state: ни одно его обновление не должно
  // дёргать ререндер board'а — ререндер мы и так получаем от
  // `setSnap` в `refresh`. Инициализируем тем же значением, что и
  // `snap.summary`, чтобы первый клиентский render не подсветил «всё
  // подряд» как изменения (SSR-снимок == текущий snapshot → diff пуст).
  const previousSummaryRef = useRef<ShopfloorDisplayDto | null>(initialSummary);
  const inFlightCtrlRef = useRef<AbortController | null>(null);
  const failuresRef = useRef<number>(initialError ? 1 : 0);
  const isMountedRef = useRef<boolean>(true);
  // Подушка для transient `network`-glitch'ей. См. подробный блок-
  // комментарий у `MAX_NETWORK_GRACE`. Хранится в ref'е, потому что
  // её значение влияет ТОЛЬКО на ветвление в `refresh` и не должно
  // дёргать ререндер board'а (UI на time остаётся `online`, поэтому
  // переменная состояния React'у не нужна).
  const networkGraceUsedRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    // На случай гонки «refresh() запланирован → unmount» — выходим
    // молча; planner ниже всё равно ничего больше не запустит.
    if (!isMountedRef.current) return;
    // Предыдущий запрос мог ещё не завершиться (например, очень
    // медленный backend). При recursive scheduling это маловероятно,
    // но защита оставлена ради immediate refresh на mount, который
    // запускается параллельно первому scheduled tick'у в редких race'ах.
    if (inFlightCtrlRef.current) return;
    const ctrl = new AbortController();
    inFlightCtrlRef.current = ctrl;
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    // URL считаем один раз и заранее — чтобы и success-, и error-лог
    // печатали ровно тот URL, который реально дёрнулся (без догадок
    // по path'у). На реальном TV это единственный способ увидеть в
    // консоли удалённого WebView, что resolveнулся именно тот origin
    // (`https://stage.teeon.ru/api/...`), а не относительный fallback
    // или, чего доброго, чужой prod-домен.
    const requestUrl = buildRequestUrl('/shopfloor/display');
    try {
      const next = await fetchJson<ShopfloorDisplayDto>(requestUrl, ctrl.signal);
      if (!isMountedRef.current) return;
      setSnap({ summary: next, lastSuccessAt: Date.now() });
      setFailures(0);
      failuresRef.current = 0;
      setAuthError(false);
      // Любой успех «прощает» накопленные transient-glitch'и: следующий
      // одиночный network-сбой снова попадёт в подушку, а не сразу в
      // failures. См. блок-комментарий у `MAX_NETWORK_GRACE`.
      networkGraceUsedRef.current = 0;
      // Debug-канал: каждый успешный refresh печатает компактный
      // payload — это и пинг «экран жив», и явная подсветка возврата
      // в `online` после degraded/offline/auth (failures сбросился в 0,
      // authError снят). См. dlog() выше про политику не-спама.
      dlog({
        status: 'online',
        errorKind: null,
        failures: 0,
        authError: false,
        requestUrl,
        // `updatedAt` приходит ISO-строкой из backend'а — по нему
        // удобно проверить, что на TV реально приходят свежие данные,
        // а не закешированный nginx'ом ответ.
        updatedAt: next.updatedAt ?? null,
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
        visibility:
          typeof document !== 'undefined' ? document.visibilityState : null,
      });
    } catch (err) {
      if (!isMountedRef.current) return;
      // Намеренно НЕ трогаем snap: последний валидный снимок должен
      // оставаться на экране до тех пор, пока связь не восстановится.
      const kind: FetchErrorKind =
        err instanceof FetchClassifiedError ? err.kind : 'network';
      // Извлекаем диагностику в локальные const'ы один раз — чтобы
      // одинаковый набор полей попадал во все три ветки лога ниже.
      const errName = err instanceof Error ? err.name : 'unknown';
      const errMsg = err instanceof Error ? err.message : String(err);
      const failuresBefore = failuresRef.current;
      const onlineState =
        typeof navigator !== 'undefined' ? navigator.onLine : null;
      const visState =
        typeof document !== 'undefined' ? document.visibilityState : null;
      if (kind === 'auth') {
        // Auth — отдельный статус, не «накручивает» soft-failures и
        // не уводит экран в «Нет связи». Сетевая часть здесь точно
        // в порядке (мы получили HTTP-ответ), и попытки опроса
        // имеет смысл продолжать на degraded-cadence — операторам
        // удобно увидеть восстановление сразу после починки сессии.
        setAuthError(true);
        dlog({
          status: 'auth',
          errorKind: kind,
          failures: failuresBefore,
          failuresAfter: failuresBefore,
          authError: true,
          requestUrl,
          errorName: errName,
          errorMessage: errMsg,
          online: onlineState,
          visibility: visState,
        });
      } else if (
        kind === 'network' &&
        networkGraceUsedRef.current < MAX_NETWORK_GRACE
      ) {
        // Transient `network`-glitch на TV/embedded WebView: первые
        // `MAX_NETWORK_GRACE` подряд `Failed to fetch`/`NetworkError`/
        // `net::ERR_NETWORK_CHANGED` глотаем без накручивания
        // `failures` — UI остаётся в `online`, snapshot жив. Подушка
        // сбросится либо на первом же успехе (см. success-ветку), либо
        // на любой не-network ошибке (timeout/server/parse — там идём
        // обычной soft-failure-веткой и подушка теряет смысл).
        networkGraceUsedRef.current += 1;
        dlog({
          status: 'transient',
          errorKind: kind,
          failures: failuresBefore,
          failuresAfter: failuresBefore,
          networkGraceUsed: networkGraceUsedRef.current,
          authError: false,
          requestUrl,
          errorName: errName,
          errorMessage: errMsg,
          online: onlineState,
          visibility: visState,
        });
      } else {
        setFailures((n) => {
          const next = n >= MAX_SOFT_ERRORS ? n : n + 1;
          failuresRef.current = next;
          return next;
        });
        // Лог печатается ПОСЛЕ setFailures, поэтому failuresRef уже
        // обновлён (см. функциональный апдейт выше). `status` рассчитан
        // по тем же правилам, что и UI-чип: ≥ MAX_SOFT_ERRORS = offline,
        // иначе degraded.
        const failuresAfter = failuresRef.current;
        dlog({
          status: failuresAfter >= MAX_SOFT_ERRORS ? 'offline' : 'degraded',
          errorKind: kind,
          failures: failuresBefore,
          failuresAfter,
          authError: false,
          requestUrl,
          errorName: errName,
          errorMessage: errMsg,
          online: onlineState,
          visibility: visState,
        });
      }
    } finally {
      clearTimeout(timer);
      if (inFlightCtrlRef.current === ctrl) {
        inFlightCtrlRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    // Снимаем SSR-гейт: с этого момента можно рендерить живое время
    // и относительные «N сек назад». До маунта оба пути (SSR + первый
    // клиентский render) видели одинаковый stable placeholder.
    setMounted(true);
    // Один лог на mount про геометрию viewport — нужен, чтобы по
    // удалённому DevTools-логу с реального TV сразу увидеть, не
    // попал ли экран в mobile-брейкпоинт (`max-width: 1199px` в
    // globals.css схлопывает board в одну колонку). На 1080p TV
    // это не должно срабатывать, но разные WebView-надстройки
    // (наложенный chrome, custom DPR) иногда занижают innerWidth.
    dlog({
      kind: 'viewport',
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    });
    // Если SSR уже принёс валидный снимок — фиксируем «время первого
    // успеха» здесь, на клиенте, чтобы оно было детерминированным
    // относительно клиентского tick'а часов.
    if (initialSummary) {
      setSnap((prev) =>
        prev.lastSuccessAt === 0
          ? { summary: prev.summary, lastSuccessAt: Date.now() }
          : prev,
      );
    }

    // Recursive scheduler. Интервал зависит от текущего числа
    // подряд идущих ошибок: пока всё хорошо — `POLL_INTERVAL_MS`,
    // как только начались сбои — `POLL_INTERVAL_DEGRADED_MS`.
    // Auth-ошибки тоже имеет смысл опрашивать реже, поэтому при
    // активном `authError` тоже идём по degraded-cadence (сценарий:
    // session истекла, чинить её на этом мониторе всё равно нужно
    // вручную — нет смысла дёргать backend каждые 3 c).
    const scheduleNext = (): void => {
      if (!isMountedRef.current) return;
      const interval =
        failuresRef.current > 0 ? POLL_INTERVAL_DEGRADED_MS : POLL_INTERVAL_MS;
      timerRef.current = setTimeout(() => {
        void refresh().finally(scheduleNext);
      }, interval);
    };

    // ----- Page Visibility recovery ---------------------------------------
    //
    // Реальная runtime-причина «через время экран уходит в offline» на
    // TV/embedded WebView: при уходе вкладки/окна в background (TV
    // dims/screensaver, переключение HDMI-входа, агрессивный
    // power-management) браузер throttle'ит `setTimeout` (часто до
    // ≥ 60 c) и/или притормаживает сам fetch. Когда страница снова
    // становится visible:
    //   1. Накопившиеся таймеры выстреливают пачкой;
    //   2. AbortController любого запроса, который ещё не успел
    //      вернуться, успевает зафейлиться по `FETCH_TIMEOUT_MS`;
    //   3. `failures` накручивается до `MAX_SOFT_ERRORS` за один
    //      «всплеск» — экран ложно показывает «Нет связи», хотя
    //      backend всё это время был жив.
    //
    // Минимальный фикс: на переход visible → forced refresh.
    // Текущий запланированный tick отменяем (чтобы не было гонки
    // двух одновременных запросов), запускаем один свежий refresh
    // и продолжаем планировщик из его finally — ровно так же, как
    // на mount. Никаких новых состояний и никакого редиректа.
    const onVisibilityChange = (): void => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState !== 'visible') return;
      if (!isMountedRef.current) return;
      dlog({ kind: 'visibility', state: 'visible' });
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void refresh().finally(scheduleNext);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    // Один немедленный refresh на mount — чтобы не ждать первый tick
    // `POLL_INTERVAL_MS` (особенно важно, если SSR-снимок прилетел
    // с ошибкой: иначе экран бы 3 секунды стоял с пустыми данными).
    // Планировщик стартует ПОСЛЕ завершения первого refresh — так
    // мы не теряем backoff: если первый запрос упал, scheduleNext
    // увидит уже инкрементированный `failuresRef`.
    void refresh().finally(scheduleNext);

    return () => {
      isMountedRef.current = false;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Аборт in-flight запроса — иначе fetch промис продолжит жить
      // и попытается setState на размонтированном компоненте при
      // быстром перенаправлении (`/login` → `/shopfloor/display` →
      // `/login`). `try/catch` в `refresh` уже глушит AbortError.
      if (inFlightCtrlRef.current) {
        inFlightCtrlRef.current.abort();
        inFlightCtrlRef.current = null;
      }
    };
  }, [refresh, initialSummary]);

  // Обновляем «секундную стрелку» (часы и «обновлено N сек назад») раз
  // в секунду — это намного дешевле, чем включить её в polling.
  // Запускаем только после маунта, чтобы случайно не сдвинуть рендер
  // до hydration.
  useEffect(() => {
    if (!mounted) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [mounted]);

  // До маунта — детерминированный «нулевой» момент времени; это
  // значение в JSX не используется (см. `mounted` ниже), но держим
  // переменную, чтобы дальше не плодить условные ветки.
  const now = mounted ? new Date() : null;
  const offlineMode = failures >= MAX_SOFT_ERRORS;
  // «Degraded» = есть ошибки, но мы ещё не ушли в полный offline.
  // Шапка получит жёлтый чип «обновление замедлено» — оператор
  // понимает, что данные могут быть чуть устаревшими, но снимок жив.
  const degradedMode = !offlineMode && failures > 0;
  const summary = snap.summary;
  const hasEverSucceeded = snap.lastSuccessAt > 0;

  // Diff текущего и предыдущего успешного snapshot'а. Возвращает
  // плоский Set ключей вида `${colorKey}|${sizeId|__totals__}|${col}`,
  // которые на этом ререндере получат класс flash-анимации. Считается
  // в render-фазе — это нормально, мы только ЧИТАЕМ ref. Запись (на
  // «следующий previous») происходит ниже, в useEffect, после commit.
  // Зависимость только от `summary`: при обычных «секундных»
  // ререндерах часов useMemo вернёт закэшированный Set без обхода
  // матрицы, поэтому diff не платит за каждый clock tick.
  const changedCellKeys = useMemo(
    () => computeChangedCellKeys(previousSummaryRef.current, summary),
    [summary],
  );

  // Сдвигаем «previous» на текущий snapshot ПОСЛЕ commit'а — чтобы
  // на следующем `setSnap` useMemo выше корректно увидел старое
  // значение в ref'е и сравнил с новым. Любые ререндеры, не меняющие
  // `summary` (clock tick, indicator-чип), сюда не попадают и diff
  // не сбрасывают.
  useEffect(() => {
    previousSummaryRef.current = summary;
  }, [summary]);

  const kpi = summary?.kpi ?? {
    producedToday: 0,
    inWork: 0,
    waiting: 0,
    qc: 0,
    wto: 0,
    packing: 0,
    finished: 0,
    defect: 0,
  };
  const colors = summary?.colors ?? [];
  const totals: ShopfloorDisplayMatrixSummary =
    summary?.totals ?? emptyMatrixSummary();
  const sewingColumns = summary?.sewingColumns ?? [];
  const equipment = summary?.equipment ?? [];

  return (
    <div className="display-screen display-screen--light">
      <header className="display-screen__header">
        <div className="display-screen__brand">
          <span className="display-screen__brand-mark" aria-hidden="true">
            ●
          </span>
          ЦЕХ · LIVE
        </div>
        {/*
          Часы и «обновлено N с назад» — единственные места в шапке,
          где значение зависит от текущего момента времени. До маунта
          рендерим стабильный placeholder с тем же DOM-каркасом
          (фиксированная ширина/высота за счёт неразрывных пробелов),
          а реальное время подставляем уже после hydration. Это и
          лечит #418/#423/#425.
        */}
        <div
          className="display-screen__clock"
          suppressHydrationWarning
          aria-live="off"
        >
          {mounted && now ? formatTime(now) : '\u00A0'}
        </div>
        <div className="display-screen__meta">
          {/*
            Чип статуса разнесён по 4 состояниям, чтобы оператор
            (и админ, проходящий мимо) различал, что именно сломалось:
              - online     — всё ок;
              - degraded   — соединение «моргает», snapshot жив, polling
                             замедлен до `POLL_INTERVAL_DEGRADED_MS`;
              - offline    — `MAX_SOFT_ERRORS` подряд, snapshot всё ещё
                             на экране, но «обновлено N сек назад»
                             уезжает дальше;
              - auth       — backend ответил 401/403 (истёк session-cookie
                             либо роль потеряла доступ); сетевая часть
                             в порядке, snapshot жив. Это намеренно
                             отдельный сигнал, а не ложный «Нет связи».
            Auth берёт визуальный приоритет над degraded/offline:
            пока сессия сломана, любые retry всё равно бесполезны.
          */}
          {(() => {
            const statusKind = authError
              ? 'auth'
              : offlineMode
                ? 'offline'
                : degradedMode
                  ? 'degraded'
                  : 'online';
            const label =
              statusKind === 'auth'
                ? 'Сессия истекла'
                : statusKind === 'offline'
                  ? 'Нет связи'
                  : statusKind === 'degraded'
                    ? 'обновление замедлено'
                    : 'онлайн';
            const title =
              statusKind === 'auth'
                ? 'Сессия истекла или нет прав — показан последний успешный снимок. Обновите страницу или войдите заново.'
                : statusKind === 'offline'
                  ? 'Данные временно не обновляются — показан последний успешный снимок'
                  : statusKind === 'degraded'
                    ? 'Соединение нестабильно — обновление переведено в замедленный режим, показан последний успешный снимок'
                    : undefined;
            return (
              <span
                className={`display-status display-status--${statusKind}`}
                data-status={statusKind}
                title={title}
              >
                <span className="display-status__dot" />
                {label}
              </span>
            );
          })()}
          <span className="display-screen__updated" suppressHydrationWarning>
            {mounted && now && hasEverSucceeded
              ? `обновлено ${formatAgo(now.getTime() - snap.lastSuccessAt)}`
              : 'нет данных'}
          </span>
        </div>
      </header>

      <KpiRow kpi={kpi} />

      <div className="display-board">
        <section
          className="display-board__production"
          data-testid="display-production-flow"
        >
          <ProductionFlowMatrix
            colors={colors}
            totals={totals}
            sewingColumns={sewingColumns}
            changedCellKeys={changedCellKeys}
          />
        </section>
        <aside
          className="display-board__equipment"
          data-testid="display-equipment-panel"
        >
          <EquipmentPanel items={equipment} />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI row — компактные карточки в одну строку
// ---------------------------------------------------------------------------

interface KpiCardProps {
  label: string;
  value: number;
  tone?: 'ok' | 'warn' | 'crit' | 'neutral' | 'accent';
}

function KpiCard({ label, value, tone = 'neutral' }: KpiCardProps) {
  return (
    <div className={`display-kpi__card display-kpi__card--${tone}`}>
      <div className="display-kpi__value">{value}</div>
      <div className="display-kpi__label">{label}</div>
    </div>
  );
}

function KpiRow({
  kpi,
}: {
  kpi: {
    producedToday: number;
    inWork: number;
    waiting: number;
    qc: number;
    wto: number;
    packing: number;
    finished: number;
    defect: number;
  };
}) {
  return (
    <section className="display-kpi" data-testid="display-kpi-row">
      <KpiCard label="Выпущено сегодня" value={kpi.producedToday} tone="ok" />
      <KpiCard label="В работе" value={kpi.inWork} tone="accent" />
      <KpiCard label="Ждёт" value={kpi.waiting} tone="neutral" />
      <KpiCard label="ОТК" value={kpi.qc} tone="neutral" />
      <KpiCard label="ВТО" value={kpi.wto} tone="neutral" />
      <KpiCard label="Упаковка" value={kpi.packing} tone="neutral" />
      <KpiCard label="Готово" value={kpi.finished} tone="ok" />
      <KpiCard label="Брак" value={kpi.defect} tone="crit" />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Production flow matrix — главный блок
// ---------------------------------------------------------------------------

const STAGE_TONE: Record<ShopfloorStage, string> = {
  CUT: 'neutral',
  SEWING: 'accent',
  QC: 'neutral',
  QC_DONE: 'ok-soft',
  WTO: 'neutral',
  WTO_DONE: 'ok-soft',
  PACKING: 'neutral',
  FINISHED: 'ok',
};

/**
 * Где в `SHOPFLOOR_DISPLAY_MATRIX_STAGES` вставлять динамические
 * sewing-колонки. Sewing исторически шёл сразу после `CUT`, и так же
 * читается оператором: сначала «сколько в крое ждёт», потом «по каким
 * sewing-операциям сейчас находится продукция», дальше — ОТК/ВТО/…
 *
 * Список `SHOPFLOOR_DISPLAY_MATRIX_STAGES` уже не содержит `'SEWING'`
 * (он раскладывается на динамические колонки), поэтому достаточно
 * найти позицию `CUT` и вставить sewing-колонки ровно за ней.
 */
function splitStagesAroundSewing(
  stages: readonly ShopfloorStage[],
): { before: readonly ShopfloorStage[]; after: readonly ShopfloorStage[] } {
  const cutIdx = stages.indexOf('CUT');
  // Защита от случайного удаления `CUT` из списка: тогда sewing идёт
  // первой колонкой матрицы. На текущей реализации этот код не
  // срабатывает, но обещание «UI не падает, если backend вернёт чуть
  // другой набор стадий» дешёвое и снимает класс багов сразу.
  if (cutIdx < 0) return { before: [], after: stages };
  return {
    before: stages.slice(0, cutIdx + 1),
    after: stages.slice(cutIdx + 1),
  };
}

function ProductionFlowMatrix({
  colors,
  totals,
  sewingColumns,
  changedCellKeys,
}: {
  colors: ShopfloorDisplayColorBlock[];
  totals: ShopfloorDisplayMatrixSummary;
  sewingColumns: ShopfloorDisplaySewingColumnDto[];
  changedCellKeys: ReadonlySet<string>;
}) {
  const stages = SHOPFLOOR_DISPLAY_MATRIX_STAGES;
  const { before, after } = splitStagesAroundSewing(stages);
  // Общее число колонок-данных (без «Размер») = static-стадии + sewing
  // + Брак. Нужно для colSpan заголовка цветовой группы.
  const dataColumnsCount = stages.length + sewingColumns.length + 1;
  return (
    <div className="display-block display-block--matrix">
      <h2 className="display-block__title">
        Поток производства
        <span className="display-block__title-sub">
          размеры · цвета · стадии
        </span>
      </h2>
      {colors.length === 0 ? (
        <div className="display-empty">нет активных партий</div>
      ) : (
        <div className="display-matrix__scroll">
          <table className="display-matrix">
            <thead>
              <tr>
                <th
                  className="display-matrix__th display-matrix__th--first"
                  scope="col"
                >
                  Размер
                </th>
                {before.map((s) => (
                  <th
                    key={s}
                    className={`display-matrix__th display-matrix__th--${STAGE_TONE[s]}`}
                    scope="col"
                  >
                    <span className="display-matrix__th-icon" aria-hidden="true">
                      <StageIcon stage={s} />
                    </span>
                    {SHOPFLOOR_STAGE_LABELS[s]}
                  </th>
                ))}
                {sewingColumns.map((col) => (
                  <th
                    key={`sew-${col.key}`}
                    className={`display-matrix__th display-matrix__th--${STAGE_TONE.SEWING} display-matrix__th--sewing`}
                    scope="col"
                    title={col.label}
                  >
                    <span className="display-matrix__th-icon" aria-hidden="true">
                      <StageIcon stage="SEWING" />
                    </span>
                    {col.label}
                  </th>
                ))}
                {after.map((s) => (
                  <th
                    key={s}
                    className={`display-matrix__th display-matrix__th--${STAGE_TONE[s]}`}
                    scope="col"
                  >
                    <span className="display-matrix__th-icon" aria-hidden="true">
                      <StageIcon stage={s} />
                    </span>
                    {SHOPFLOOR_STAGE_LABELS[s]}
                  </th>
                ))}
                <th
                  className="display-matrix__th display-matrix__th--defect"
                  scope="col"
                >
                  <span className="display-matrix__th-icon" aria-hidden="true">
                    <DefectIcon />
                  </span>
                  Брак
                </th>
              </tr>
            </thead>
            <tbody>
              {colors.map((block) => (
                <ColorBlockRows
                  key={block.colorKey}
                  block={block}
                  before={before}
                  after={after}
                  sewingColumns={sewingColumns}
                  dataColumnsCount={dataColumnsCount}
                  changedCellKeys={changedCellKeys}
                />
              ))}
              <tr className="display-matrix__total-row display-matrix__total-row--grand">
                <th scope="row" className="display-matrix__row-label">
                  Итого
                </th>
                {before.map((s) => {
                  const v = summaryQty(totals, s);
                  const k = grandCellKey(s);
                  return (
                    <FlashCell
                      key={`${s}|v=${v}`}
                      cellKey={k}
                      changedCellKeys={changedCellKeys}
                      className={`display-matrix__cell display-matrix__cell--${STAGE_TONE[s]}`}
                      value={v}
                    />
                  );
                })}
                {sewingColumns.map((col) => {
                  const v = sewingQty(totals, col.key);
                  const k = grandCellKey(`sew:${col.key}`);
                  return (
                    <FlashCell
                      key={`sew-${col.key}|v=${v}`}
                      cellKey={k}
                      changedCellKeys={changedCellKeys}
                      className={`display-matrix__cell display-matrix__cell--${STAGE_TONE.SEWING}`}
                      value={v}
                    />
                  );
                })}
                {after.map((s) => {
                  const v = summaryQty(totals, s);
                  const k = grandCellKey(s);
                  return (
                    <FlashCell
                      key={`${s}|v=${v}`}
                      cellKey={k}
                      changedCellKeys={changedCellKeys}
                      className={`display-matrix__cell display-matrix__cell--${STAGE_TONE[s]}`}
                      value={v}
                    />
                  );
                })}
                <FlashCell
                  key={`defect|v=${totals.qtyDefect}`}
                  cellKey={grandCellKey('defect')}
                  changedCellKeys={changedCellKeys}
                  className="display-matrix__cell display-matrix__cell--defect"
                  value={totals.qtyDefect}
                />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ColorBlockRows({
  block,
  before,
  after,
  sewingColumns,
  dataColumnsCount,
  changedCellKeys,
}: {
  block: ShopfloorDisplayColorBlock;
  before: readonly ShopfloorStage[];
  after: readonly ShopfloorStage[];
  sewingColumns: ShopfloorDisplaySewingColumnDto[];
  dataColumnsCount: number;
  changedCellKeys: ReadonlySet<string>;
}) {
  return (
    <>
      <tr className="display-matrix__color-row">
        <th
          colSpan={dataColumnsCount + 1}
          scope="colgroup"
          className={`display-matrix__color-label display-matrix__color-label--${block.colorKey}`}
        >
          <span
            className={`display-matrix__color-swatch display-matrix__color-swatch--${block.colorKey}`}
            aria-hidden="true"
          />
          {block.colorLabel}
        </th>
      </tr>
      {block.rows.map((row) => (
        <tr key={`${block.colorKey}-${row.sizeId}`} className="display-matrix__row">
          <th scope="row" className="display-matrix__row-label">
            {row.sizeCode}
          </th>
          {before.map((s) => {
            const v = summaryQty(row, s);
            const k = rowCellKey(block.colorKey, row.sizeId, s);
            return (
              <FlashCell
                key={`${s}|v=${v}`}
                cellKey={k}
                changedCellKeys={changedCellKeys}
                className={`display-matrix__cell display-matrix__cell--${STAGE_TONE[s]}`}
                value={v}
              />
            );
          })}
          {sewingColumns.map((col) => {
            const v = sewingQty(row, col.key);
            const k = rowCellKey(block.colorKey, row.sizeId, `sew:${col.key}`);
            return (
              <FlashCell
                key={`sew-${col.key}|v=${v}`}
                cellKey={k}
                changedCellKeys={changedCellKeys}
                className={`display-matrix__cell display-matrix__cell--${STAGE_TONE.SEWING}`}
                value={v}
              />
            );
          })}
          {after.map((s) => {
            const v = summaryQty(row, s);
            const k = rowCellKey(block.colorKey, row.sizeId, s);
            return (
              <FlashCell
                key={`${s}|v=${v}`}
                cellKey={k}
                changedCellKeys={changedCellKeys}
                className={`display-matrix__cell display-matrix__cell--${STAGE_TONE[s]}`}
                value={v}
              />
            );
          })}
          <FlashCell
            key={`defect|v=${row.qtyDefect}`}
            cellKey={rowCellKey(block.colorKey, row.sizeId, 'defect')}
            changedCellKeys={changedCellKeys}
            className="display-matrix__cell display-matrix__cell--defect"
            value={row.qtyDefect}
          />
        </tr>
      ))}
      <tr className="display-matrix__total-row">
        <th scope="row" className="display-matrix__row-label">
          итог · {block.colorLabel}
        </th>
        {before.map((s) => {
          const v = summaryQty(block.totals, s);
          const k = colorTotalsCellKey(block.colorKey, s);
          return (
            <FlashCell
              key={`${s}|v=${v}`}
              cellKey={k}
              changedCellKeys={changedCellKeys}
              className={`display-matrix__cell display-matrix__cell--${STAGE_TONE[s]}`}
              value={v}
            />
          );
        })}
        {sewingColumns.map((col) => {
          const v = sewingQty(block.totals, col.key);
          const k = colorTotalsCellKey(block.colorKey, `sew:${col.key}`);
          return (
            <FlashCell
              key={`sew-${col.key}|v=${v}`}
              cellKey={k}
              changedCellKeys={changedCellKeys}
              className={`display-matrix__cell display-matrix__cell--${STAGE_TONE.SEWING}`}
              value={v}
            />
          );
        })}
        {after.map((s) => {
          const v = summaryQty(block.totals, s);
          const k = colorTotalsCellKey(block.colorKey, s);
          return (
            <FlashCell
              key={`${s}|v=${v}`}
              cellKey={k}
              changedCellKeys={changedCellKeys}
              className={`display-matrix__cell display-matrix__cell--${STAGE_TONE[s]}`}
              value={v}
            />
          );
        })}
        <FlashCell
          key={`defect|v=${block.totals.qtyDefect}`}
          cellKey={colorTotalsCellKey(block.colorKey, 'defect')}
          changedCellKeys={changedCellKeys}
          className="display-matrix__cell display-matrix__cell--defect"
          value={block.totals.qtyDefect}
        />
      </tr>
    </>
  );
}

/**
 * Одна ячейка матрицы с поддержкой flash-эффекта на изменение значения.
 *
 * Контракт детектирования:
 *   - `cellKey` — стабильный идентификатор ячейки в snapshot'е (не
 *     зависит от номера ререндера). Если он входит в `changedCellKeys`
 *     (значит, ОТЛИЧАЕТСЯ от предыдущего успешного snapshot'а — см.
 *     `computeChangedCellKeys`), на td добавляется класс
 *     `display-cell--changed` с CSS-анимацией `flash-red` (см. globals).
 *   - Сам по себе toggle `display-cell--changed` уже перезапустит
 *     CSS-анимацию (браузер видит «класс с animation добавлен с нуля»),
 *     но в редком сценарии «два poll'а подряд меняют одну и ту же
 *     ячейку» класс не пропадает между renders'ами и анимация не
 *     перезапустилась бы. Поэтому в `key` td'а намеренно вшито
 *     `v=${value}`: при смене значения React пересоздаёт DOM-узел td,
 *     и анимация гарантированно играет заново. На «спокойных»
 *     ячейках значение не меняется → key стабилен → никаких лишних
 *     remount'ов.
 *
 * Никакого setState/setTimeout внутри ячейки: класс вычисляется на
 * лету из props. Соответственно, эффект масштабируется на сотни ячеек
 * без накладных расходов. См. также комментарии у `previousSummaryRef`
 * и `computeChangedCellKeys`.
 */
function FlashCell({
  cellKey,
  changedCellKeys,
  className,
  value,
}: {
  cellKey: string;
  changedCellKeys: ReadonlySet<string>;
  className: string;
  value: number;
}) {
  const flash = changedCellKeys.has(cellKey);
  const cls = flash ? `${className} display-cell--changed` : className;
  return <td className={cls}>{value}</td>;
}

/**
 * Достаёт значение конкретной sewing-колонки из row/totals; backend
 * не кладёт нули в `sewingByOp` — UI должен сам подставить 0 для
 * отсутствующих ключей (например, цвет/размер, у которого по этой
 * операции сейчас нет паспортов).
 */
function sewingQty(s: ShopfloorDisplayMatrixSummary, key: string): number {
  return s.sewingByOp[key] ?? 0;
}

function summaryQty(s: ShopfloorSummaryDto, stage: ShopfloorStage): number {
  switch (stage) {
    case 'CUT':
      return s.qtyCut;
    case 'SEWING':
      return s.qtySewing;
    case 'QC':
      return s.qtyQc;
    case 'QC_DONE':
      return s.qtyQcDone;
    case 'WTO':
      return s.qtyWto;
    case 'WTO_DONE':
      return s.qtyWtoDone;
    case 'PACKING':
      return s.qtyPacking;
    case 'FINISHED':
      return s.qtyFinished;
  }
}

// ---------------------------------------------------------------------------
// Equipment panel — компактные плитки с иконкой и номером
// ---------------------------------------------------------------------------

function EquipmentPanel({ items }: { items: ShopfloorEquipmentStatusDto[] }) {
  const counts = useMemo(() => countByStatus(items), [items]);
  const sorted = useMemo(() => {
    // Стабильный порядок: ONLINE → WARNING → OFFLINE; внутри статуса —
    // по `displayNumber` (числово), затем по `code`. Это удерживает
    // плитки на тех же местах между polling'ами.
    const order: Record<ShopfloorEquipmentStatus, number> = {
      ONLINE: 0,
      WARNING: 1,
      OFFLINE: 2,
    };
    return items
      .slice()
      .sort((a, b) => {
        const s = order[a.status] - order[b.status];
        if (s !== 0) return s;
        const an = parseDisplayNumber(a.displayNumber);
        const bn = parseDisplayNumber(b.displayNumber);
        if (an !== bn) return an - bn;
        return a.code.localeCompare(b.code);
      });
  }, [items]);

  return (
    <div className="display-block display-block--equipment">
      <h2 className="display-block__title">
        Оборудование
        <span className="display-block__title-badge">{items.length}</span>
      </h2>
      <div className="display-equipment__legend">
        <span className="display-equipment__legend-chip display-equipment__legend-chip--online">
          <span className="display-status__dot" />
          Онлайн
        </span>
        <span className="display-equipment__legend-chip display-equipment__legend-chip--warning">
          <span className="display-status__dot" />
          Простой
        </span>
        <span className="display-equipment__legend-chip display-equipment__legend-chip--offline">
          <span className="display-status__dot" />
          Оффлайн
        </span>
      </div>
      {items.length === 0 ? (
        <div className="display-empty">нет оборудования</div>
      ) : (
        <ul
          className="display-equipment-grid"
          data-testid="display-equipment-grid"
        >
          {sorted.map((eq) => (
            <li
              key={eq.id}
              className={`display-equipment-tile display-equipment-tile--${eq.status.toLowerCase()}`}
              title={`${eq.name}${eq.displayNumber ? ` №${eq.displayNumber}` : ''}${
                eq.employeeName ? ` · ${eq.employeeName}` : ''
              }`}
            >
              <span className="display-equipment-tile__icon" aria-hidden="true">
                <EquipmentIcon kind={eq.kind} />
              </span>
              <span className="display-equipment-tile__num">
                {eq.displayNumber ?? '·'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="display-equipment__totals">
        <span className="display-equipment__total display-equipment__total--online">
          <strong>{counts.ONLINE}</strong> онлайн
        </span>
        <span className="display-equipment__total display-equipment__total--warning">
          <strong>{counts.WARNING}</strong> простой
        </span>
        <span className="display-equipment__total display-equipment__total--offline">
          <strong>{counts.OFFLINE}</strong> оффлайн
        </span>
      </div>
    </div>
  );
}

function parseDisplayNumber(n: string | null): number {
  if (!n) return Number.MAX_SAFE_INTEGER;
  const v = parseInt(n.replace(/\D+/g, ''), 10);
  return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
}

function countByStatus(
  items: ShopfloorEquipmentStatusDto[],
): Record<ShopfloorEquipmentStatus, number> {
  const acc: Record<ShopfloorEquipmentStatus, number> = {
    ONLINE: 0,
    WARNING: 0,
    OFFLINE: 0,
  };
  for (const it of items) acc[it.status] += 1;
  return acc;
}

// ---------------------------------------------------------------------------
// Icons — компактные SVG, единообразные по стилю
// (24×24 viewBox, currentColor, stroke-only). Намеренно встроены здесь,
// а не в общий icon-set: иконки нужны только display-board'у, и
// отдельный модуль/sprite привнёс бы overhead без выгоды.
// ---------------------------------------------------------------------------

function EquipmentIcon({ kind }: { kind: ShopfloorEquipmentKind }) {
  switch (kind) {
    case 'SEWING':
      return <IconSewingMachine />;
    case 'CUTTING':
      return <IconCuttingTable />;
    case 'IRONING':
      return <IconIron />;
    case 'QC':
      return <IconQcMagnifier />;
    case 'PACKING':
      return <IconBox />;
    default:
      return <IconGear />;
  }
}

function StageIcon({ stage }: { stage: ShopfloorStage }) {
  switch (stage) {
    case 'CUT':
      return <IconCuttingTable />;
    case 'SEWING':
      return <IconSewingMachine />;
    case 'QC':
    case 'QC_DONE':
      return <IconQcMagnifier />;
    case 'WTO':
    case 'WTO_DONE':
      return <IconIron />;
    case 'PACKING':
      return <IconBox />;
    case 'FINISHED':
      return <IconCheck />;
  }
}

function IconSewingMachine() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 18h18" />
      <path d="M5 18V8h11v10" />
      <path d="M16 8h3l1 3v7" />
      <circle cx="9" cy="13" r="1.6" />
      <path d="M9 14.6V18" />
    </svg>
  );
}

function IconCuttingTable() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 14h18" />
      <path d="M5 14v6" />
      <path d="M19 14v6" />
      <circle cx="9" cy="8" r="1.6" />
      <circle cx="15" cy="8" r="1.6" />
      <path d="M10.4 8.8l5 4.2" />
      <path d="M13.6 8.8l-5 4.2" />
    </svg>
  );
}

function IconIron() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 17h18" />
      <path d="M4 17l2-5a4 4 0 0 1 3.6-2.4H18l1 7.4" />
      <path d="M9 5v2" />
      <path d="M11 5v2" />
      <path d="M13 5v2" />
    </svg>
  );
}

function IconQcMagnifier() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5L20 20" />
      <path d="M9 11l1.6 1.6L13.5 9.7" />
    </svg>
  );
}

function IconBox() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7l9-4 9 4-9 4-9-4z" />
      <path d="M3 7v10l9 4 9-4V7" />
      <path d="M12 11v10" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function DefectIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Cell-flash diff: какие ячейки матрицы изменились между двумя
// успешными snapshot'ами. Возвращаем плоский Set ключей, чтобы render
// каждой td мог в O(1) проверить «надо ли мигать». Никакого state,
// никаких таймеров — только сравнение двух чисел на ячейку.
//
// Сценарий: snapshot N-1 (previousSummaryRef.current) и snapshot N
// (текущий `summary`). Для каждой ячейки строим стабильный cellKey
// (см. `rowCellKey` / `colorTotalsCellKey` / `grandCellKey`), сравниваем
// значения. Ключ попадает в Set только если:
//   - в обоих snapshot'ах значение определено (т.е. это НЕ первое
//     появление новой size/color/sewing-колонки — иначе мы бы мигали
//     при первой загрузке экрана), И
//   - старое значение != новое значение.
//
// Спец-случай: для sewing-колонок backend кладёт в `sewingByOp`
// только ненулевые ключи. На уровне рендера sewing-ячейка показывает
// 0 для отсутствующих ключей (см. `sewingQty`). Чтобы 0 → 5 и 5 → 0
// корректно ловились как «движение», во flat-map дополняем все
// текущие sewing-колонки нулями (на основе `sewingColumns` дто).
// «Первое появление» новой sewing-колонки (была NULL — прилетела
// с ненулевым значением) тоже не подсвечивается, потому что в
// previous-snapshot её ключа в `sewingColumns` ещё не было → в map
// её нет → старое значение `undefined` → diff пропускается.
// ---------------------------------------------------------------------------

const GRAND_PREFIX = '__grand__';
const TOTALS_SUFFIX = '__totals__';

function rowCellKey(colorKey: string, sizeId: string, col: string): string {
  return `${colorKey}|${sizeId}|${col}`;
}

function colorTotalsCellKey(colorKey: string, col: string): string {
  return `${colorKey}|${TOTALS_SUFFIX}|${col}`;
}

function grandCellKey(col: string): string {
  return `${GRAND_PREFIX}|${TOTALS_SUFFIX}|${col}`;
}

function flattenMatrixSummary(
  s: ShopfloorDisplayMatrixSummary,
  prefix: string,
  sewKeys: readonly string[],
  out: Map<string, number>,
): void {
  out.set(`${prefix}|CUT`, s.qtyCut);
  out.set(`${prefix}|QC`, s.qtyQc);
  out.set(`${prefix}|QC_DONE`, s.qtyQcDone);
  out.set(`${prefix}|WTO`, s.qtyWto);
  out.set(`${prefix}|WTO_DONE`, s.qtyWtoDone);
  out.set(`${prefix}|PACKING`, s.qtyPacking);
  out.set(`${prefix}|FINISHED`, s.qtyFinished);
  out.set(`${prefix}|defect`, s.qtyDefect);
  for (const k of sewKeys) {
    out.set(`${prefix}|sew:${k}`, s.sewingByOp?.[k] ?? 0);
  }
}

function flattenSnapshot(s: ShopfloorDisplayDto): Map<string, number> {
  const map = new Map<string, number>();
  const sewKeys = s.sewingColumns.map((c) => c.key);
  for (const block of s.colors) {
    for (const row of block.rows) {
      flattenMatrixSummary(row, `${block.colorKey}|${row.sizeId}`, sewKeys, map);
    }
    flattenMatrixSummary(
      block.totals,
      `${block.colorKey}|${TOTALS_SUFFIX}`,
      sewKeys,
      map,
    );
  }
  flattenMatrixSummary(
    s.totals,
    `${GRAND_PREFIX}|${TOTALS_SUFFIX}`,
    sewKeys,
    map,
  );
  return map;
}

function computeChangedCellKeys(
  prev: ShopfloorDisplayDto | null,
  next: ShopfloorDisplayDto | null,
): ReadonlySet<string> {
  if (!prev || !next) return EMPTY_SET;
  const prevMap = flattenSnapshot(prev);
  const nextMap = flattenSnapshot(next);
  const changed = new Set<string>();
  nextMap.forEach((nv, key) => {
    const pv = prevMap.get(key);
    if (pv === undefined) return;
    if (pv !== nv) changed.add(key);
  });
  return changed;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySummary(): ShopfloorSummaryDto {
  return {
    qtyCut: 0,
    qtySewing: 0,
    qtyQc: 0,
    qtyQcDone: 0,
    qtyWto: 0,
    qtyWtoDone: 0,
    qtyPacking: 0,
    qtyFinished: 0,
    qtyDefect: 0,
  };
}

function emptyMatrixSummary(): ShopfloorDisplayMatrixSummary {
  return { ...emptySummary(), sewingByOp: {} };
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('ru-RU', { hour12: false });
}

function formatAgo(ms: number): string {
  if (ms < 1000) return 'только что';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} с назад`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  return `${h} ч назад`;
}
