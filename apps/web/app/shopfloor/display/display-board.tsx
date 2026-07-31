'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import Link from 'next/link';
import { LogOut, Package, Scissors, Search, type LucideIcon } from 'lucide-react';
import {
  SHOPFLOOR_DISPLAY_MATRIX_STAGES,
  SHOPFLOOR_STAGE_LABELS,
  type ShopfloorDisplayColorBlock,
  type ShopfloorDisplayDto,
  type ShopfloorDisplayMatrixSummary,
  type ShopfloorDisplayRouteOperationDto,
  type ShopfloorDisplayRow,
  type ShopfloorEquipmentStatus,
  type ShopfloorEquipmentStatusDto,
  type ShopfloorOrphanMasterCallDto,
  type ShopfloorStage,
  type ShopfloorSummaryDto,
} from '@sewing/shared/shopfloor';
import { getApiBaseUrl } from '@/lib/api-base';
import { logoutAction } from '@/app/(auth)/logout-action';

interface Props {
  initialSummary: ShopfloorDisplayDto | null;
  initialError: string | null;
  /**
   * Опциональный фильтр по подразделению заказа
   * (`CompanyDivision.code`). `null` — фильтра нет, экран показывает
   * все активные заказы. Если задан, передаётся в
   * `/api/shopfloor/display?divisionCode=…` на каждом polling-tick'е,
   * чтобы выборка считалась на backend, а не на клиенте.
   */
  divisionCode?: string | null;
  /**
   * Разрешён ли drill-in (проваливание) с монитора в админку.
   *
   * Экран висит в зале под учёткой `DISPLAY` и по дизайну остаётся
   * read-only витриной — для неё `false`: у роли `DISPLAY` нет доступа
   * к `/admin/*`, ссылка вела бы в редирект. Менеджер (`ADMIN` /
   * `SHOP_MANAGER`), открывший тот же экран со своего устройства,
   * получает `true` — и может провалиться из шапки sewing-операции
   * в карточку операции, а из плитки станка в карточку оборудования.
   *
   * Считается на сервере (`page.tsx` → `canSeeAdmin`), а не на
   * клиенте: роль в клиентский бандл не тащим.
   */
  drillIn?: boolean;
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

/**
 * Зеркало адаптивных слоёв `globals.css` (секция «Адаптив монитора») —
 * ТОЛЬКО для диагностического лога `kind: 'viewport'`. Раскладку
 * определяет CSS, здесь мы лишь называем режим словом, чтобы по логу с
 * реального TV/планшета сразу было видно, в какой слой попал экран,
 * а не гадать по `width × height`.
 *
 * Если правишь брейкпоинты в CSS — поправь и здесь (иначе лог начнёт
 * врать; на саму отрисовку это не влияет).
 *
 * `tv-4k` пережил отдельный css-слой ≥2400px (тот больше не нужен:
 * шкала `--display-u` там упирается в потолок `clamp`'а) — в логе
 * метка остаётся полезной, чтобы отличить 4K-панель от 1080p.
 */
function viewportTier(width: number, height: number): string {
  if (height >= 1400 && height > width) return 'portrait-kiosk';
  if (width >= 2400) return 'tv-4k';
  if (width >= 1600) return 'tv';
  if (width <= 767) return 'phone';
  if (width <= 1199) return 'compact';
  return 'desktop';
}

/**
 * Нижняя граница авто-подгонки матрицы (см. `useMatrixFit`). Ниже 0.55
 * от шкалы экрана цифры на TV перестают читаться с 5 м, и «влезло
 * целиком» уже не стоит потери смысла — в этом случае матрица честно
 * оставляет себе внутренний скролл, как было раньше.
 */
const MATRIX_FIT_MIN = 0.55;
/**
 * Потолок числа замеров на одну «порцию» изменений. Замер → новый
 * `fit` → ре-рендер → снова замер: шаг сходится за 2-3 итерации, но
 * счётчик страхует от патологических случаев (например, таблица, у
 * которой высота не убывает при уменьшении шрифта из-за min-width
 * колонок). Сбрасывается при ресайзе зоны и при смене данных.
 */
const MATRIX_FIT_MAX_PASSES = 8;

/**
 * Авто-подгонка матрицы «вся целиком, без скролла».
 *
 * CSS-шкала (`--display-u`, см. globals.css → `.display-screen`) делает
 * размеры пропорциональными вьюпорту, но она НЕ знает, сколько строк и
 * колонок в конкретном заказе: 3 цвета × 5 размеров с маршрутом из
 * четырёх операций влезают на любой экран, а 8 цветов × 7 размеров с
 * десятью операциями — уже нет. Поэтому дополнительный множитель
 * считаем по факту: сравниваем `scrollHeight/Width` таблицы с
 * `clientHeight/Width` её scroll-зоны и ужимаем шкалу ровно во столько
 * раз, во сколько не влезает.
 *
 * Возвращаемый `fit` уходит инлайновой переменной `--display-fit` на
 * саму `<table>` — там его подхватывает правило `.display-matrix`.
 * Заголовок блока остаётся на шкале экрана намеренно: высота scroll-
 * зоны тогда не зависит от подгонки, и итерации сходятся, а не гуляют.
 *
 * Замер идёт в `useEffect` (не в layout-фазе) сознательно: витрина
 * рендерится и на сервере, лишний кадр на TV незаметен, а
 * `useLayoutEffect` в SSR даёт предупреждение React.
 */
function useMatrixFit(
  scrollRef: RefObject<HTMLDivElement | null>,
  tableRef: RefObject<HTMLTableElement | null>,
  /** Меняется при смене данных матрицы — повод пересчитать с нуля. */
  contentKey: string,
): number {
  const [fit, setFit] = useState(1);
  const passesRef = useRef(0);
  const [resizeTick, setResizeTick] = useState(0);

  // Ресайз окна/зоны — единственный внешний триггер: сама подгонка
  // размеров scroll-зоны не меняет (её высоту задаёт grid витрины),
  // поэтому обратной связи «fit → resize → fit» здесь нет.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      passesRef.current = 0;
      setResizeTick((t) => t + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef]);

  useEffect(() => {
    passesRef.current = 0;
  }, [contentKey]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const table = tableRef.current;
    if (!scroll || !table) return;
    // Подгонка нужна только в КИОСК-режиме (десктоп / TV / портретный
    // киоск), где витрина не скроллится и «не влезло» = «не видно».
    // В ручных слоях (телефон, планшет, низкий экран) страница
    // скроллится намеренно, а размеры там уже подобраны под руку —
    // ужимать их до нечитаемости нельзя.
    //
    // Признак режима читаем из САМОГО CSS (`overflow-y` витрины:
    // hidden = киоск, auto = ручной), а не повторяем брейкпоинты в JS:
    // иначе при следующей правке globals.css эти два списка разъедутся
    // молча (та же грабля, что с `viewportTier`, — но там расхождение
    // портит лишь лог, а здесь испортило бы экран).
    const screenEl = scroll.closest('.display-screen');
    const manualScroll =
      !!screenEl &&
      getComputedStyle(screenEl).overflowY !== 'hidden';
    if (manualScroll) {
      if (fit !== 1) setFit(1);
      return;
    }
    if (passesRef.current >= MATRIX_FIT_MAX_PASSES) return;
    const availH = scroll.clientHeight;
    const availW = scroll.clientWidth;
    const needH = table.scrollHeight;
    const needW = table.scrollWidth;
    if (!availH || !availW || !needH || !needW) return;
    const ratio = Math.min(availH / needH, availW / needW);
    let next: number;
    if (ratio >= 1) {
      // Есть запас. Растём обратно только при заметном зазоре (>5%) и
      // с недобором (0.97), иначе на границе «ровно влезает» экран
      // начинает дышать шрифтом туда-сюда на каждом polling-тике.
      if (fit >= 1 || ratio < 1.05) return;
      next = Math.min(1, fit * ratio * 0.97);
    } else {
      next = Math.max(MATRIX_FIT_MIN, fit * ratio * 0.99);
    }
    next = Math.round(next * 1000) / 1000;
    if (Math.abs(next - fit) < 0.01) return;
    passesRef.current += 1;
    setFit(next);
  }, [fit, resizeTick, contentKey, scrollRef, tableRef]);

  return fit;
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
  divisionCode = null,
  drillIn = false,
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
    // Фильтр по подразделению, если задан в URL страницы. Backend
    // валидирует значение через Zod-схему и возвращает только заказы
    // выбранного `CompanyDivision.code`; без параметра — поведение
    // прежнее (показываем все активные заказы).
    const requestUrl = buildRequestUrl(
      divisionCode
        ? `/shopfloor/display?divisionCode=${encodeURIComponent(divisionCode)}`
        : '/shopfloor/display',
    );
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
  }, [divisionCode]);

  useEffect(() => {
    isMountedRef.current = true;
    // Снимаем SSR-гейт: с этого момента можно рендерить живое время
    // и относительные «N сек назад». До маунта оба пути (SSR + первый
    // клиентский render) видели одинаковый stable placeholder.
    setMounted(true);
    // Один лог на mount про геометрию viewport — нужен, чтобы по
    // удалённому DevTools-логу с реального TV сразу увидеть, в какой
    // адаптивный слой попал экран (`tier`, см. `viewportTier` и
    // секцию «Адаптив монитора» в globals.css). На 1080p TV ждём
    // `tv`, а не `compact`: разные WebView-надстройки (наложенный
    // chrome, custom DPR) иногда занижают innerWidth и роняют экран
    // в компактный режим — по этому полю видно сразу.
    dlog({
      kind: 'viewport',
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      tier: viewportTier(window.innerWidth, window.innerHeight),
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
  const equipment = summary?.equipment ?? [];
  const sewingRoute = summary?.sewingRoute ?? [];
  const orphanMasterCalls = summary?.orphanMasterCalls ?? [];

  return (
    <div className="display-screen display-screen--light">
      <header className="display-screen__header">
        <div className="display-screen__brand">
          <span className="display-screen__brand-mark" aria-hidden="true">
            ●
          </span>
          ЦЕХ · LIVE
          {divisionCode ? (
            <span
              className="display-screen__brand-sub"
              data-testid="display-division-label"
            >
              · {divisionCode}
            </span>
          ) : null}
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
          {/*
            Выход с монитора. Кнопка-форма с server action `logoutAction`
            (httpOnly session-cookie чистится на сервере) — работает даже
            без JS, что важно для зального терминала. Глобальный AppHeader
            на этом экране скрыт, поэтому единственный logout живёт здесь.
          */}
          <form action={logoutAction} className="display-screen__logout-form">
            <button
              type="submit"
              className="display-screen__logout"
              title="Выйти из учётной записи монитора"
            >
              <LogOut size={14} aria-hidden="true" />
              <span>Выйти</span>
            </button>
          </form>
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
            sewingRoute={sewingRoute}
            changedCellKeys={changedCellKeys}
            drillIn={drillIn}
          />
        </section>
        <aside
          className="display-board__equipment"
          data-testid="display-equipment-panel"
        >
          <EquipmentPanel items={equipment} drillIn={drillIn} />
          <OrphanMasterCalls items={orphanMasterCalls} now={now} />
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
 * split-колонки (sewing-операции + ОТК + ВТО).
 *
 * Sewing-операции идут сразу после `CUT`, потом ОТК и ВТО (тоже как
 * split-блоки `▶/✔`), потом «после-производственные» стадии
 * (`PACKING`, `FINISHED`). Это даёт визуальный поток
 *
 *   КРОЙ │ SEWING │ ОТК │ ВТО │ УПАКОВКА │ ГОТОВО
 *
 * который читается оператором слева направо без скачков.
 *
 * `SHOPFLOOR_DISPLAY_MATRIX_STAGES` намеренно не содержит ни `SEWING`,
 * ни `QC`/`QC_DONE`/`WTO`/`WTO_DONE` (см. блок-комментарий у этой
 * константы) — поэтому достаточно отрезать всё после `CUT` в `after`,
 * между ними UI отдельным циклом рендерит split-блоки.
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

// ---------------------------------------------------------------------------
// Process splits (▶/✔ блоки): sewing-операции + ОТК + ВТО.
// ---------------------------------------------------------------------------
//
// Унифицированная модель split-колонок. Sewing-операция, ОТК и ВТО
// рисуются ОДНОЙ И ТОЙ ЖЕ парой колонок `▶/✔`:
//   ▶ inProgress = «паспорт сейчас на этом этапе» (в работе или
//                  ожидает обработки на этой операции);
//   ✔ done       = «этап завершён, паспорт ждёт перехода к
//                  следующему этапу маршрута».
//
// Источник значений:
//   - sewing-операции — `summary.sewingRoute` (агрегат `qtyCut` по
//     `OrderRouteStep + Passport.currentRouteStepIndex`, с тем же
//     resolver'ом, что использует матрица; см. `buildSewingRoute`);
//   - ОТК / ВТО — те же поля `row.qtyQc / qtyQcDone / qtyWto /
//     qtyWtoDone` из матричной проекции, что и раньше. Семантика
//     уже соответствует «текущему накоплению» (без исторического
//     done): когда следующий этап делает `OPERATION_SCAN`,
//     `currentOperation.category` меняется и оба бакета (▶ и ✔)
//     обнуляются автоматически. См. `bucketOf` в shopfloor-projection.
//
// Это и есть «единая логика WIP по всему потоку», требуемая ТЗ:
// одна и та же визуальная пара `▶/✔` под общим заголовком,
// одна и та же семантика «работается / готово, ждёт следующего».
type ProcessSplitKind = 'sew' | 'qc' | 'wto';

interface ProcessSplit {
  /**
   * Стабильный ключ блока в шапке/diff'е. Используется и для key prop'ов,
   * и для `cellKey` (через `cellSubKey` ниже). Гарантирует, что шапки
   * sewing-операций и ОТК/ВТО не сталкиваются в неймспейсе.
   */
  key: string;
  /**
   * Подпись в шапке row-1 (`Operation.name` для sewing, «ОТК» / «ВТО»
   * для процессных шагов).
   */
  label: string;
  /** Тип блока — нужен для тонов и testid'ов. */
  kind: ProcessSplitKind;
  /**
   * `Operation.id` для sewing-блока — по нему шапка умеет провалиться
   * в карточку операции (`/admin/operations/[id]`, только при
   * `drillIn`, см. `Props.drillIn`). У процессных блоков ОТК/ВТО
   * отдельной `Operation` нет — поле остаётся `undefined`, и шапка
   * рисуется обычным текстом.
   */
  operationId?: string;
  /**
   * Префикс для `cellKey` колонок ▶/✔ этого блока в diff-flatten:
   * `sewroute:<opId>` для sewing (исторический формат, не ломаем
   * существующие diff-тесты), `proc:qc` / `proc:wto` для процессных.
   */
  cellPrefix: string;
  /**
   * `true`, если этот блок начинает новую «зону потока» —
   * визуально отделяется вертикальной линией слева. На дисплее
   * sewing → QC → WTO как раз и являются такими переходами.
   * Sewing-операции внутри пошива линии не получают (они уже
   * разделены `op-divider`'ом).
   */
  isFlowStart: boolean;
  /**
   * Значение ▶ для одной row матрицы (per-(color, size)). `colorKey`
   * берётся из родительского `ShopfloorDisplayColorBlock` — без него
   * sewing-route не различает цвета и одно и то же per-size число
   * расплывалось бы по всем цветам того же размера (см. инцидент
   * «138 чёрного S в строке белого S»).
   */
  inProgressForRow: (row: ShopfloorDisplayRow, colorKey: string) => number;
  /** Значение ✔ для одной row матрицы. См. JSDoc у `inProgressForRow`. */
  doneForRow: (row: ShopfloorDisplayRow, colorKey: string) => number;
  /**
   * Значение ▶ для color totals блока. Sewing считает Σ per-size
   * через rows блока с учётом `block.colorKey` — sewing-route теперь
   * содержит цветовое измерение, и итог цвета совпадает с физикой.
   * QC/ВТО берут готовые `block.totals.qtyQc` etc.
   */
  inProgressForBlockTotals: (block: ShopfloorDisplayColorBlock) => number;
  doneForBlockTotals: (block: ShopfloorDisplayColorBlock) => number;
  /** Значение ▶ / ✔ для grand totals (нижняя строка «Итого»). */
  inProgressForGrand: (totals: ShopfloorDisplayMatrixSummary) => number;
  doneForGrand: (totals: ShopfloorDisplayMatrixSummary) => number;
}

/**
 * Собирает упорядоченный список process-splits под текущий polling-
 * snapshot:
 *
 *   [ ...sewingRoute (по `Operation.sortOrder`), QC, WTO ]
 *
 * QC и WTO добавляются всегда (даже если по ним сейчас Σ = 0),
 * чтобы layout не «прыгал» между tick'ами polling — оператор привык
 * к фиксированным ОТК/ВТО колонкам как к постоянным «вёрстам»
 * маршрута. Sewing-блоки, наоборот, динамические: появляются только
 * для тех операций, по которым в текущем срезе есть продукция (по
 * контракту `sewingRoute`).
 */
function buildProcessSplits(
  sewingRoute: readonly ShopfloorDisplayRouteOperationDto[],
  routeLookup: ReadonlyMap<string, RouteLookup>,
): ProcessSplit[] {
  const splits: ProcessSplit[] = sewingRoute.map((op) => {
    const lookup = routeLookup.get(op.operationId);
    return {
      key: `sew:${op.operationId}`,
      label: op.operationName,
      kind: 'sew',
      operationId: op.operationId,
      cellPrefix: `sewroute:${op.operationId}`,
      isFlowStart: false,
      inProgressForRow: (row, colorKey) => routeQty(lookup, colorKey, row.sizeCode, 'in'),
      doneForRow: (row, colorKey) => routeQty(lookup, colorKey, row.sizeCode, 'done'),
      inProgressForBlockTotals: (block) => {
        let s = 0;
        for (const r of block.rows) {
          s += routeQty(lookup, block.colorKey, r.sizeCode, 'in');
        }
        return s;
      },
      doneForBlockTotals: (block) => {
        let s = 0;
        for (const r of block.rows) {
          s += routeQty(lookup, block.colorKey, r.sizeCode, 'done');
        }
        return s;
      },
      inProgressForGrand: () => lookup?.totalIn ?? 0,
      doneForGrand: () => lookup?.totalDone ?? 0,
    };
  });
  splits.push({
    key: 'proc:qc',
    label: SHOPFLOOR_STAGE_LABELS.QC,
    kind: 'qc',
    cellPrefix: 'proc:qc',
    // ОТК открывает «после-sewing» зону маршрута — слева линия.
    isFlowStart: true,
    inProgressForRow: (row) => row.qtyQc,
    doneForRow: (row) => row.qtyQcDone,
    inProgressForBlockTotals: (block) => block.totals.qtyQc,
    doneForBlockTotals: (block) => block.totals.qtyQcDone,
    inProgressForGrand: (totals) => totals.qtyQc,
    doneForGrand: (totals) => totals.qtyQcDone,
  });
  splits.push({
    key: 'proc:wto',
    label: SHOPFLOOR_STAGE_LABELS.WTO,
    kind: 'wto',
    cellPrefix: 'proc:wto',
    // Между ОТК и ВТО тоже стоит вертикальная линия —
    // визуальный разрез между «отдел контроля» и «утюжка».
    isFlowStart: true,
    inProgressForRow: (row) => row.qtyWto,
    doneForRow: (row) => row.qtyWtoDone,
    inProgressForBlockTotals: (block) => block.totals.qtyWto,
    doneForBlockTotals: (block) => block.totals.qtyWtoDone,
    inProgressForGrand: (totals) => totals.qtyWto,
    doneForGrand: (totals) => totals.qtyWtoDone,
  });
  return splits;
}

/**
 * Минимальное Σ-✔ операции, начиная с которого UI вообще считает
 * перепад между этапами «узким местом». Защита от двух типичных
 * ложных срабатываний на старте смены:
 *
 *   1) первая операция маршрута всегда уезжает вперёд по ✔ просто
 *      потому, что остальные ещё не получили ни одного паспорта —
 *      пульсировать на этом нечего;
 *   2) ранние пробные сканы (1–2 паспорта) — не статистический
 *      перекос, а нормальная разогревочная активность.
 *
 * 10 шт. — это эмпирический порог: к моменту, когда хотя бы у одной
 * операции накопился такой ✔-буфер, разница между этапами уже
 * действительно отражает узкое место, а не «начало рабочего дня».
 */
const BOTTLENECK_MIN_QTY = 10;

interface BottleneckInfo {
  /** Ключ операции-источника (та, у которой ✔ = max). */
  sourceKey: string;
  /** Размер буфера ✔, по которому сработала подсветка. */
  qty: number;
}

/**
 * Чисто визуальная эвристика «где сейчас сужается поток».
 *
 * Идея: если у какой-то операции ✔-буфер (паспорта, ждущие
 * перехода на следующий этап) самый большой по всему потоку —
 * значит, тормозит именно СЛЕДУЮЩАЯ операция, она не успевает
 * разбирать накопленный буфер. Подсвечивать имеет смысл именно
 * её столбец, а не «победителя по ✔» (тот как раз работает).
 *
 * Контракт:
 *   - порядок splits фиксирован (sewing → QC → WTO), `i + 1`
 *     это «следующий этап маршрута» в реальном смысле потока;
 *   - если max ✔ < `BOTTLENECK_MIN_QTY` — карта пустая,
 *     ничего не подсвечиваем (см. блок-комментарий у константы);
 *   - если максимум достигают сразу несколько операций —
 *     подсвечиваются ВСЕ их `next`-операции (важный edge-case
 *     при равных нагрузках на параллельных машинах);
 *   - если максимум на самой ПОСЛЕДНЕЙ операции — подсвечивать
 *     нечего (нет «следующей»), entry просто не создаётся.
 *
 * Backend сюда не вовлечён вообще — это агрегация уже посчитанных
 * на клиенте `ProcessSplit`-структур.
 */
function detectBottlenecks(
  processSplits: ProcessSplit[],
  totals: ShopfloorDisplayMatrixSummary,
): Map<string, BottleneckInfo> {
  const result = new Map<string, BottleneckInfo>();
  if (processSplits.length === 0) return result;
  const dones = processSplits.map((s) => s.doneForGrand(totals) || 0);
  const maxDone = Math.max(...dones);
  if (maxDone < BOTTLENECK_MIN_QTY) return result;
  processSplits.forEach((s, i) => {
    if (dones[i] !== maxDone) return;
    const next = processSplits[i + 1];
    if (!next) return;
    result.set(next.key, { sourceKey: s.key, qty: maxDone });
  });
  return result;
}

/**
 * Тон ячеек ▶ split-блока (фон/цвет цифры). У sewing — `accent`
 * (синий), как и было; у QC/ВТО — `neutral`, чтобы не перетягивать
 * внимание с активного пошива. ✔-колонки во всех блоках одинаковые
 * (`ok-soft`) — это и есть «буфер готового перед следующим этапом».
 */
function splitInTone(kind: ProcessSplitKind): string {
  switch (kind) {
    case 'sew':
      return STAGE_TONE.SEWING;
    case 'qc':
      return STAGE_TONE.QC;
    case 'wto':
      return STAGE_TONE.WTO;
  }
}

/**
 * Иконка в шапке row-1 split-блока. Для sewing-операций — швейная
 * машина; для ОТК — лупа; для ВТО — утюг. Иконки те же, что у
 * `StageIcon`, чтобы оператор на TV сходу узнавал стадию.
 */
function SplitHeadIcon({ kind }: { kind: ProcessSplitKind }) {
  switch (kind) {
    case 'sew':
      return <StageIcon stage="SEWING" />;
    case 'qc':
      return <StageIcon stage="QC" />;
    case 'wto':
      return <StageIcon stage="WTO" />;
  }
}

/**
 * Маршрут пошива встроен в матрицу: каждая sewing-операция из
 * `summary.sewingRoute` разворачивается в ДВЕ колонки — `▶`
 * (inProgress, паспорта прямо сейчас на этом шаге) и `✔` (done,
 * паспорта, прошедшие этот шаг). Источник истины — снимок
 * `OrderRouteStep` + `Passport.currentRouteStepIndex`, агрегация
 * на backend (см. `buildSewingRoute`). UI ничего не считает сам.
 *
 * Backend агрегирует sewing-route только по операции и размеру
 * (без цветового измерения — снимок маршрута общий на заказ),
 * поэтому per-`(color, size)` ячейка показывает per-size аггрегат
 * (одинаковый для всех цветов одного размера), а color- и
 * grand-totals честно суммируются по rows.
 */
type SewingDir = 'in' | 'done';

/**
 * Ключ `colorKey|sizeCode`. Раньше lookup был только по `sizeCode`,
 * из-за чего на матрице `(color × size)` одно per-size значение
 * клонировалось во все цветовые строки одного размера (инцидент
 * «138 чёрного S отображалось в строке белого S»). Теперь backend
 * отдаёт строки sewing-route с собственным `colorKey`, и UI ищет
 * ячейку ровно по паре `(colorKey, size)`.
 */
function routeCellKey(colorKey: string, sizeCode: string): string {
  return `${colorKey}|${sizeCode}`;
}

interface RouteLookup {
  /** `colorKey|sizeCode` → { inProgress, done } для одной операции. */
  byColorSize: ReadonlyMap<string, { inProgress: number; done: number }>;
  /** Σ по всем строкам — для grand-totals (= честный итог из backend). */
  totalIn: number;
  totalDone: number;
}

function buildRouteLookup(
  route: readonly ShopfloorDisplayRouteOperationDto[],
): Map<string, RouteLookup> {
  const out = new Map<string, RouteLookup>();
  for (const op of route) {
    const byColorSize = new Map<string, { inProgress: number; done: number }>();
    let totalIn = 0;
    let totalDone = 0;
    for (const r of op.rows) {
      byColorSize.set(routeCellKey(r.colorKey, r.size), {
        inProgress: r.inProgress,
        done: r.done,
      });
      totalIn += r.inProgress;
      totalDone += r.done;
    }
    out.set(op.operationId, { byColorSize, totalIn, totalDone });
  }
  return out;
}

function routeQty(
  lookup: RouteLookup | undefined,
  colorKey: string,
  sizeCode: string,
  dir: SewingDir,
): number {
  if (!lookup) return 0;
  const v = lookup.byColorSize.get(routeCellKey(colorKey, sizeCode));
  if (!v) return 0;
  return dir === 'in' ? v.inProgress : v.done;
}

/**
 * Дополнительные класс-маркеры для «постоянных» колонок (CUT и QC),
 * которые задают ВЕРТИКАЛЬНЫЕ РАЗДЕЛИТЕЛЬНЫЕ ЛИНИИ потоков:
 *
 *   КРОЙ │ SEWING │ ОТК+
 *
 * Линия после КРОЯ живёт через `border-right` на самой CUT-колонке
 * (`display-matrix__cut-divider`), линия перед ОТК — через
 * `border-left` на первой колонке `after` (`display-matrix__qc-divider`).
 * Sewing-блок в середине уже имеет собственные `display-matrix__op-divider`
 * между операциями (см. ниже), поэтому конфликта классов нет.
 *
 * Edge-case «нет ни одной sewing-операции в маршруте»: `before=['CUT']`
 * и `after` начинается с `QC` примыкают вплотную. Если бы мы оставили
 * cut-divider включённым, рядом стоящие `border-right: 2px` и
 * `border-left: 2px` (table в режиме `border-collapse: separate`)
 * образовали бы видимую двойную линию шириной 4 px — а это прямо
 * запрещено («не должно быть двойных линий»). Поэтому cut-divider
 * подавляем, когда sewing-зона пустая: единый разделитель в этом
 * случае рисует qc-divider, и визуально между КРОЙ и ОТК остаётся
 * ровно одна полупрозрачная полоска.
 */
function flowDividerClass(
  s: ShopfloorStage,
  hasSewing: boolean,
): string {
  if (s === 'CUT' && hasSewing) {
    return ' display-matrix__cut display-matrix__cut-divider';
  }
  if (s === 'QC') {
    return ' display-matrix__qc display-matrix__qc-divider';
  }
  return '';
}

function ProductionFlowMatrix({
  colors,
  totals,
  sewingRoute,
  changedCellKeys,
  drillIn = false,
}: {
  colors: ShopfloorDisplayColorBlock[];
  totals: ShopfloorDisplayMatrixSummary;
  sewingRoute: ShopfloorDisplayRouteOperationDto[];
  changedCellKeys: ReadonlySet<string>;
  /** См. `Props.drillIn` — шапка sewing-операции становится ссылкой. */
  drillIn?: boolean;
}) {
  const stages = SHOPFLOOR_DISPLAY_MATRIX_STAGES;
  const { before, after } = splitStagesAroundSewing(stages);
  const hasSewing = sewingRoute.length > 0;
  const routeLookup = useMemo(() => buildRouteLookup(sewingRoute), [sewingRoute]);
  // Единый список split-блоков (▶/✔): сначала sewing-операции в
  // порядке маршрута, затем ОТК, затем ВТО. Все три блока рисуются
  // одной и той же парой колонок и используют ту же diff-логику —
  // см. `ProcessSplit` и `buildProcessSplits` выше.
  const processSplits = useMemo(
    () => buildProcessSplits(sewingRoute, routeLookup),
    [sewingRoute, routeLookup],
  );
  // Подсветка узкого места — чисто визуальная, считается из уже
  // готовых split'ов и общих totals'ов (никаких отдельных запросов
  // и DTO). См. `detectBottlenecks` про эвристику и edge-cases.
  const bottlenecks = useMemo(
    () => detectBottlenecks(processSplits, totals),
    [processSplits, totals],
  );
  // Static-стадии (CUT/PACKING/FINISHED) + по 2 колонки на каждый
  // split-блок (sewing/QC/WTO) + 1 колонка «Брак». Нужен для
  // colSpan заголовка цветовой группы.
  const dataColumnsCount = stages.length + processSplits.length * 2 + 1;
  // Авто-подгонка «вся матрица целиком, без скролла» (см. `useMatrixFit`).
  // Пересчёт с нуля нужен, когда меняется ГЕОМЕТРИЯ таблицы — число
  // цветовых блоков, строк-размеров или колонок маршрута; цифры внутри
  // ячеек на размеры не влияют, поэтому в ключ не входят (иначе каждый
  // polling-тик гонял бы замеры впустую).
  const fitKey = useMemo(
    () =>
      [
        processSplits.length,
        stages.length,
        ...colors.map((c) => `${c.colorKey}:${c.rows.length}`),
      ].join('|'),
    [colors, processSplits.length, stages.length],
  );
  const matrixScrollRef = useRef<HTMLDivElement | null>(null);
  const matrixTableRef = useRef<HTMLTableElement | null>(null);
  const matrixFit = useMatrixFit(matrixScrollRef, matrixTableRef, fitKey);
  // Шапка матрицы — двухстрочная:
  //   ряд 1 — постоянные колонки (Размер/Крой/Упаковка/...) идут с
  //           `rowSpan=2`; каждый split-блок (sewing-операция, ОТК,
  //           ВТО) занимает один th с `colSpan=2` (название блока
  //           центрируется над своими подколонками);
  //   ряд 2 — для каждого split-блока два th с маркерами
  //           `▶` (inProgress) и `✔` (done) под его названием.
  // Имя блока и маркеры разнесены по разным `tr`, чтобы визуально
  // иконка стояла строго ПОД названием, а не справа от него —
  // иначе на TV глаз оператора путает inline-формат
  // «<имя> ▶ ✔» и не понимает, к какой именно подколонке
  // относятся цифры в строках ниже.
  return (
    <div className="display-block display-block--matrix">
      <h2 className="display-block__title">
        Поток производства
        <span className="display-block__title-sub">
          размеры · цвета · стадии · ▶ в работе · ✔ готово
        </span>
      </h2>
      {colors.length === 0 ? (
        <div className="display-empty">нет активных партий</div>
      ) : (
        <div className="display-matrix__scroll" ref={matrixScrollRef}>
          <table
            className="display-matrix"
            ref={matrixTableRef}
            style={{ '--display-fit': matrixFit } as CSSProperties}
          >
            <thead>
              <tr>
                <th
                  className="display-matrix__th display-matrix__th--first"
                  scope="col"
                  rowSpan={2}
                >
                  Размер
                </th>
                {before.map((s) => (
                  <th
                    key={s}
                    className={`display-matrix__th display-matrix__th--${STAGE_TONE[s]}${flowDividerClass(s, hasSewing)}`}
                    scope="col"
                    rowSpan={2}
                  >
                    <span className="display-matrix__th-icon" aria-hidden="true">
                      <StageIcon stage={s} />
                    </span>
                    {SHOPFLOOR_STAGE_LABELS[s]}
                  </th>
                ))}
                {processSplits.map((sp, idx) => {
                  const isBottleneck = bottlenecks.has(sp.key);
                  return (
                    <th
                      key={sp.key}
                      className={`display-matrix__th display-matrix__th--${splitInTone(sp.kind)} display-matrix__th--sewing-op${splitHeadDividerClass(sp, idx)}${isBottleneck ? ' display-matrix__th--bottleneck' : ''}`}
                      scope="colgroup"
                      colSpan={2}
                      title={
                        isBottleneck
                          ? `${sp.label} — узкое место (буфер готового ${bottlenecks.get(sp.key)?.qty ?? ''})`
                          : sp.label
                      }
                      data-testid={`display-matrix-split-${sp.kind}`}
                      data-bottleneck={isBottleneck ? 'true' : undefined}
                    >
                      <span className="display-matrix__th-icon" aria-hidden="true">
                        <SplitHeadIcon kind={sp.kind} />
                      </span>
                      {/*
                        Drill-in по имени операции: менеджер, открывший
                        монитор со своего устройства, проваливается в
                        карточку операции. На TV (`drillIn = false`) —
                        обычный `span`, витрина остаётся без интерактива.
                      */}
                      {drillIn && sp.operationId ? (
                        <Link
                          href={`/admin/operations/${sp.operationId}`}
                          className="display-matrix__th-op display-matrix__th-op--link"
                        >
                          {sp.label}
                        </Link>
                      ) : (
                        <span className="display-matrix__th-op">{sp.label}</span>
                      )}
                      {isBottleneck ? (
                        <span
                          className="display-matrix__bottleneck-mark"
                          aria-hidden="true"
                        >
                          ⚠
                        </span>
                      ) : null}
                    </th>
                  );
                })}
                {after.map((s) => (
                  <th
                    key={s}
                    className={`display-matrix__th display-matrix__th--${STAGE_TONE[s]}${afterStageDividerClass(s)}`}
                    scope="col"
                    rowSpan={2}
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
                  rowSpan={2}
                >
                  <span className="display-matrix__th-icon" aria-hidden="true">
                    <DefectIcon />
                  </span>
                  Брак
                </th>
              </tr>
              <tr className="display-matrix__sub-row">
                {processSplits.map((sp, idx) => (
                  <SplitSubHeader
                    key={sp.key}
                    split={sp}
                    withDivider={splitSubDividerOn(sp, idx)}
                    isBottleneck={bottlenecks.has(sp.key)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {colors.map((block) => (
                <ColorBlockRows
                  key={block.colorKey}
                  block={block}
                  before={before}
                  after={after}
                  processSplits={processSplits}
                  hasSewing={hasSewing}
                  dataColumnsCount={dataColumnsCount}
                  changedCellKeys={changedCellKeys}
                  bottlenecks={bottlenecks}
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
                      className={`display-matrix__cell display-matrix__cell--${STAGE_TONE[s]}${flowDividerClass(s, hasSewing)}`}
                      value={v}
                    />
                  );
                })}
                {processSplits.map((sp, idx) => {
                  const inV = sp.inProgressForGrand(totals);
                  const doneV = sp.doneForGrand(totals);
                  const inDivider = splitInDividerClass(sp, idx);
                  const bnClass = bottlenecks.has(sp.key)
                    ? ' display-matrix__bottleneck-col'
                    : '';
                  return (
                    <Fragment key={sp.key}>
                      <FlashCell
                        key={`${sp.key}-in|v=${inV}`}
                        cellKey={grandCellKey(`${sp.cellPrefix}:in`)}
                        changedCellKeys={changedCellKeys}
                        className={`display-matrix__cell display-matrix__cell--${splitInTone(sp.kind)} display-matrix__cell--sew-in${inDivider}${bnClass}`}
                        value={inV}
                      />
                      <FlashCell
                        key={`${sp.key}-done|v=${doneV}`}
                        cellKey={grandCellKey(`${sp.cellPrefix}:done`)}
                        changedCellKeys={changedCellKeys}
                        className={`display-matrix__cell display-matrix__cell--ok-soft display-matrix__cell--sew-done${bnClass}`}
                        value={doneV}
                      />
                    </Fragment>
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
                      className={`display-matrix__cell display-matrix__cell--${STAGE_TONE[s]}${afterStageDividerClass(s)}`}
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

/**
 * Класс-маркер вертикального разделителя для шапки split-блока
 * (row-1, `colSpan=2`).
 *
 * Линии нужны там, где ОДИН СПЛИТ ОТДЕЛЁН от соседнего «зональным»
 * переходом маршрута:
 *   - перед первой sewing-операцией линию НЕ ставим — слева от неё
 *     уже стоит CUT с собственным `cut-divider`'ом (border-right);
 *   - между двумя sewing-операциями стоит обычный `op-divider`
 *     (тонкая линия, не двойная — это семантика «другая операция
 *     того же sewing-блока»);
 *   - перед ОТК (первый process-split с `isFlowStart=true`) ставим
 *     `qc-divider` — это «выход из sewing в зону контроля»;
 *   - перед ВТО — `wto-divider` — переход «из ОТК в утюжку»;
 *   - cut-divider у CUT-колонки автоматически подавляется когда
 *     `hasSewing=false`, чтобы не было двойной линии встык
 *     с qc-divider'ом — см. `flowDividerClass`.
 */
function splitHeadDividerClass(sp: ProcessSplit, idx: number): string {
  if (sp.kind === 'qc') return ' display-matrix__qc display-matrix__qc-divider';
  if (sp.kind === 'wto') return ' display-matrix__wto display-matrix__wto-divider';
  // sewing
  if (idx > 0) return ' display-matrix__op-divider';
  return '';
}

/**
 * Тот же контракт, что у `splitHeadDividerClass`, но возвращает
 * флаг для row-2 (sub-header `▶`-ячейки). `SplitSubHeader` сам
 * прибавит соответствующий класс — здесь только bool.
 */
function splitSubDividerOn(sp: ProcessSplit, idx: number): boolean {
  if (sp.isFlowStart) return true;
  return idx > 0;
}

/**
 * Класс-маркер для ▶-ячейки одной строки `tbody`. Аналог
 * `splitHeadDividerClass`, но возвращает класс CSS-разделителя
 * `border-left` (а не суффиксный класс шапки).
 */
function splitInDividerClass(sp: ProcessSplit, idx: number): string {
  if (sp.kind === 'qc') return ' display-matrix__qc-divider';
  if (sp.kind === 'wto') return ' display-matrix__wto-divider';
  if (idx > 0) return ' display-matrix__op-divider';
  return '';
}

/**
 * Класс-маркер вертикального разделителя ПЕРЕД one-cell стадией
 * `after`-зоны (`PACKING`, `FINISHED`).
 *
 * После того как ОТК и ВТО уехали в split-блоки, между последним
 * split'ом (ВТО) и `PACKING` нужна та же зональная линия, что и
 * перед ОТК — иначе три «нейтральных» (▶) колонки слева от PACKING
 * визуально сливаются. Используем `wto-divider` (border-left того
 * же стиля, что qc-divider), но навешиваем уже на PACKING.
 *
 * `FINISHED` собственного «потокового» разделителя не получает —
 * он стоит вплотную к PACKING как «следующий шаг той же зоны
 * упаковки/выпуска» и оба тонированы как `neutral`/`ok`.
 */
function afterStageDividerClass(s: ShopfloorStage): string {
  if (s === 'PACKING') {
    return ' display-matrix__wto display-matrix__wto-divider';
  }
  return '';
}

/**
 * Подколонки одного split-блока во ВТОРОЙ строке шапки матрицы:
 *
 *   ┌────────── (название блока, sewing-операция / ОТК / ВТО) ──────────┐  ← row-1 (colSpan=2)
 *   │           ▶ в работе          │            ✔ готово               │  ← row-2 (этот компонент)
 *
 * Название блока рисуется отдельным `<th colSpan={2}>` в первой
 * строке шапки (см. `ProductionFlowMatrix`); этот компонент возвращает
 * только два th-маркера, которые встают РОВНО под названием.
 * Так оператор сразу видит соответствие «блок → его две колонки»,
 * а не путает inline-формат «<имя> ▶ ✔» с цифрами строк ниже.
 *
 * Для совместимости со существующими тестами и testid'ами sewing-
 * блок продолжает помечаться `display-matrix-sew-in/done` (старые
 * smoke-/e2e-тесты ловят его именно этими атрибутами); QC и ВТО
 * получают свои `display-matrix-qc-in/done` и `display-matrix-wto-in/done`.
 */
function SplitSubHeader({
  split,
  withDivider,
  isBottleneck,
}: {
  split: ProcessSplit;
  /**
   * Рисовать ли вертикальную разделительную линию ПЕРЕД этим
   * split-блоком. Линия живёт ровно на ▶-подколонке (первой в паре
   * ▶/✔), потому что именно она открывает блок в визуальном порядке.
   * Класс линии зависит от типа блока — см. `splitInDividerClass`.
   */
  withDivider: boolean;
  /**
   * Этот split — «узкое место» (см. `detectBottlenecks`)? Если да,
   * обе подколонки (▶ и ✔) получают класс
   * `display-matrix__bottleneck-col`, чтобы кораловый pulse шёл по
   * ВСЕЙ вертикали столбца, включая sticky-шапку.
   */
  isBottleneck: boolean;
}) {
  const inTone = splitInTone(split.kind);
  const dividerClass = withDivider
    ? split.kind === 'qc'
      ? ' display-matrix__qc-divider'
      : split.kind === 'wto'
        ? ' display-matrix__wto-divider'
        : ' display-matrix__op-divider'
    : '';
  const bnClass = isBottleneck ? ' display-matrix__bottleneck-col' : '';
  const inTestid =
    split.kind === 'sew'
      ? 'display-matrix-sew-in'
      : `display-matrix-${split.kind}-in`;
  const doneTestid =
    split.kind === 'sew'
      ? 'display-matrix-sew-done'
      : `display-matrix-${split.kind}-done`;
  return (
    <Fragment>
      <th
        className={`display-matrix__th display-matrix__th--${inTone} display-matrix__th--sub display-matrix__th--sew-in${dividerClass}${bnClass}`}
        scope="col"
        title={`${split.label} · в работе`}
        data-testid={inTestid}
      >
        <span className="display-matrix__th-dir" aria-hidden="true">▶</span>
        <span className="display-visually-hidden">{split.label} · в работе</span>
      </th>
      <th
        className={`display-matrix__th display-matrix__th--ok-soft display-matrix__th--sub display-matrix__th--sew-done${bnClass}`}
        scope="col"
        title={`${split.label} · готово`}
        data-testid={doneTestid}
      >
        <span className="display-matrix__th-dir" aria-hidden="true">✔</span>
        <span className="display-visually-hidden">{split.label} · готово</span>
      </th>
    </Fragment>
  );
}

function ColorBlockRows({
  block,
  before,
  after,
  processSplits,
  hasSewing,
  dataColumnsCount,
  changedCellKeys,
  bottlenecks,
}: {
  block: ShopfloorDisplayColorBlock;
  before: readonly ShopfloorStage[];
  after: readonly ShopfloorStage[];
  processSplits: ProcessSplit[];
  hasSewing: boolean;
  dataColumnsCount: number;
  changedCellKeys: ReadonlySet<string>;
  /**
   * Карта «ключ split'а → инфа об узком месте» (см. `detectBottlenecks`).
   * Для каждой строки матрицы обе ячейки (▶ и ✔) операции, которая
   * признана узким местом, получают класс
   * `display-matrix__bottleneck-col` — пульс идёт по всему столбцу.
   */
  bottlenecks: ReadonlyMap<string, BottleneckInfo>;
}) {
  return (
    <>
      <tr className="display-matrix__color-row">
        <th
          colSpan={dataColumnsCount + 1}
          scope="colgroup"
          className={`display-matrix__color-label display-matrix__color-label--${block.colorKey}`}
        >
          {/*
            Содержимое обёрнуто в отдельный span, потому что липнуть при
            горизонтальном скролле матрицы должно именно оно: сама ячейка
            растянута colSpan'ом на всю ширину таблицы, и sticky на ней
            бессмысленен — сдвигаться внутри своего containing block ей
            некуда. Стиль — `.display-matrix__color-label-inner`.
          */}
          <span className="display-matrix__color-label-inner">
            <span
              className={`display-matrix__color-swatch display-matrix__color-swatch--${block.colorKey}`}
              aria-hidden="true"
            />
            {block.colorLabel}
          </span>
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
                className={`display-matrix__cell display-matrix__cell--${STAGE_TONE[s]}${flowDividerClass(s, hasSewing)}`}
                value={v}
              />
            );
          })}
          {processSplits.map((sp, idx) => {
            const inV = sp.inProgressForRow(row, block.colorKey);
            const doneV = sp.doneForRow(row, block.colorKey);
            const inDivider = splitInDividerClass(sp, idx);
            const bnClass = bottlenecks.has(sp.key)
              ? ' display-matrix__bottleneck-col'
              : '';
            return (
              <Fragment key={sp.key}>
                <FlashCell
                  key={`${sp.key}-in|v=${inV}`}
                  cellKey={rowCellKey(
                    block.colorKey,
                    row.sizeId,
                    `${sp.cellPrefix}:in`,
                  )}
                  changedCellKeys={changedCellKeys}
                  className={`display-matrix__cell display-matrix__cell--${splitInTone(sp.kind)} display-matrix__cell--sew-in${inDivider}${bnClass}`}
                  value={inV}
                />
                <FlashCell
                  key={`${sp.key}-done|v=${doneV}`}
                  cellKey={rowCellKey(
                    block.colorKey,
                    row.sizeId,
                    `${sp.cellPrefix}:done`,
                  )}
                  changedCellKeys={changedCellKeys}
                  className={`display-matrix__cell display-matrix__cell--ok-soft display-matrix__cell--sew-done${bnClass}`}
                  value={doneV}
                />
              </Fragment>
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
                className={`display-matrix__cell display-matrix__cell--${STAGE_TONE[s]}${afterStageDividerClass(s)}`}
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
              className={`display-matrix__cell display-matrix__cell--${STAGE_TONE[s]}${flowDividerClass(s, hasSewing)}`}
              value={v}
            />
          );
        })}
        {processSplits.map((sp, idx) => {
          // Color total для одного split-блока: Σ per-size аггрегатов
          // по размерам, присутствующим в этом цветовом блоке (для
          // sewing — потому что backend не разрезает route по цвету;
          // для QC/ВТО — это просто `block.totals.qtyQc[Done]` и т.п.,
          // см. `inProgressForBlockTotals`).
          const inSum = sp.inProgressForBlockTotals(block);
          const doneSum = sp.doneForBlockTotals(block);
          const inDivider = splitInDividerClass(sp, idx);
          const bnClass = bottlenecks.has(sp.key)
            ? ' display-matrix__bottleneck-col'
            : '';
          return (
            <Fragment key={sp.key}>
              <FlashCell
                key={`${sp.key}-in|v=${inSum}`}
                cellKey={colorTotalsCellKey(
                  block.colorKey,
                  `${sp.cellPrefix}:in`,
                )}
                changedCellKeys={changedCellKeys}
                className={`display-matrix__cell display-matrix__cell--${splitInTone(sp.kind)} display-matrix__cell--sew-in${inDivider}${bnClass}`}
                value={inSum}
              />
              <FlashCell
                key={`${sp.key}-done|v=${doneSum}`}
                cellKey={colorTotalsCellKey(
                  block.colorKey,
                  `${sp.cellPrefix}:done`,
                )}
                changedCellKeys={changedCellKeys}
                className={`display-matrix__cell display-matrix__cell--ok-soft display-matrix__cell--sew-done${bnClass}`}
                value={doneSum}
              />
            </Fragment>
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
              className={`display-matrix__cell display-matrix__cell--${STAGE_TONE[s]}${afterStageDividerClass(s)}`}
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

/**
 * Компактная сетка оборудования. Радикально упрощена:
 *
 *   - в плитке ТОЛЬКО `displayNumber`, актуальный размер/размеры
 *     (если на станке прямо сейчас есть изделие в работе) и
 *     цветной dot статуса;
 *   - никаких иконок, имён оборудования, ФИО, текста статуса,
 *     больших карточек;
 *   - плотная сетка `auto-fill` 4–6 колонок умещает 30+ станков
 *     без скролла на TV.
 *
 * Размер берём из `eq.currentSizes` — backend считает его как
 * «уникальные размеры активных паспортов на станке этой смены»
 * (см. `ShopfloorService.listEquipmentStatus` про assigned-shift
 * fallback). Если массив пустой — строка размеров не рендерится
 * вообще (плитка почти не растёт по высоте), оператор видит, что
 * станок «в простое» по самому отсутствию подписи.
 *
 * Сортировка стабильна между polling-tick'ами: ONLINE → WARNING →
 * OFFLINE, внутри статуса — числовой `displayNumber`, дальше `code`.
 * Источник данных — `summary.equipment` (контракт DTO не меняли).
 * Под сеткой — компактный итог-чип с количеством станков по статусам,
 * тоже только цветом + цифрой.
 */
function EquipmentPanel({
  items,
  drillIn = false,
}: {
  items: ShopfloorEquipmentStatusDto[];
  /** См. `Props.drillIn` — плитка станка становится ссылкой. */
  drillIn?: boolean;
}) {
  const counts = useMemo(() => countByStatus(items), [items]);
  const sorted = useMemo(() => {
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
              className={
                `display-equipment-tile display-equipment-tile--${eq.status.toLowerCase()}` +
                (eq.hasOpenMasterCall
                  ? ' display-equipment-tile--master-call'
                  : '')
              }
              data-status={eq.status}
              data-master-call={eq.hasOpenMasterCall ? 'true' : undefined}
              data-testid="display-equipment-tile"
              title={
                eq.hasOpenMasterCall
                  ? `${eq.displayNumber ? `№${eq.displayNumber}` : eq.code} — вызван мастер`
                  : eq.displayNumber
                    ? `№${eq.displayNumber}`
                    : eq.code
              }
            >
              {/*
                Drill-in по плитке станка → карточка оборудования.
                Ссылка-оверлей (`inset: 0`), а не обёртка вокруг
                содержимого: плитка — квадратный flex-контейнер с
                aspect-ratio, и вложенный блок сломал бы её раскладку.
                На TV (`drillIn = false`) ссылки нет вообще — витрина
                остаётся без интерактива.
              */}
              {drillIn ? (
                <Link
                  href={`/admin/equipment/${eq.id}`}
                  className="display-equipment-tile__link"
                  aria-label={`Открыть карточку станка ${
                    eq.displayNumber ? `№${eq.displayNumber}` : eq.code
                  }`}
                />
              ) : null}
              <span className="display-equipment-tile__num">
                <EquipmentKindIcon kind={eq.kind} />
                {eq.displayNumber ?? '·'}
              </span>
              {eq.currentSizes.length > 0 ? (
                <span
                  className="display-equipment-tile__sizes"
                  title={eq.currentSizes.join(', ')}
                >
                  {eq.currentSizes.join(',')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="display-equipment__totals">
        <span className="display-equipment__total display-equipment__total--online">
          <strong>{counts.ONLINE}</strong>
        </span>
        <span className="display-equipment__total display-equipment__total--warning">
          <strong>{counts.WARNING}</strong>
        </span>
        <span className="display-equipment__total display-equipment__total--offline">
          <strong>{counts.OFFLINE}</strong>
        </span>
      </div>
    </div>
  );
}

/**
 * Блок «Вызовы мастера» для display board'а — список вызовов
 * мастера, у которых нет привязки к оборудованию (рабочий нажал
 * «Мастер» вне станка). Если список пуст — UI скрывает блок
 * целиком, чтобы не плодить визуальный шум на TV.
 *
 * Время ожидания считается на клиенте от `createdAt` относительно
 * `now`-часов. Если `now` ещё не пришёл (до маунта), показываем
 * placeholder «—», чтобы DOM остался стабильным под hydration
 * (та же модель, что у display-clock'ов в шапке выше).
 *
 * Источник данных — `ShopfloorDisplayDto.orphanMasterCalls`.
 */
function OrphanMasterCalls({
  items,
  now,
}: {
  items: ShopfloorOrphanMasterCallDto[];
  now: Date | null;
}) {
  if (items.length === 0) return null;
  return (
    <div className="display-orphan-calls" data-testid="display-orphan-calls">
      <p className="display-orphan-calls__title">Вызовы мастера</p>
      <ul className="display-orphan-calls__list">
        {items.map((c) => {
          const waiting = formatMasterCallWaiting(c.createdAt, now);
          return (
            <li key={c.id} className="display-orphan-calls__item">
              <span>{c.employeeName}</span>
              <span className="display-orphan-calls__waiting">{waiting}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatMasterCallWaiting(createdAtIso: string, now: Date | null): string {
  if (!now) return '—';
  const created = new Date(createdAtIso).getTime();
  if (Number.isNaN(created)) return '—';
  const diffMs = Math.max(0, now.getTime() - created);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return '< 1 мин';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} ч` : `${hours} ч ${remainder} мин`;
}

/**
 * Маппинг «категория оборудования → тонкая line-иконка» для плитки
 * на `/shopfloor/display`. Иконка — ВТОРИЧНЫЙ маркер рядом с
 * `displayNumber`: основной сигнал плитки — номер + актуальные
 * размеры, а статус читается ЦВЕТОМ всей плитки
 * (`display-equipment-tile--online/warning/offline`), без отдельного
 * dot'а.
 *
 * Источник `kind` — `ShopfloorEquipmentStatusDto.kind`, рассчитанный
 * на backend через `pickEquipmentKind` из `OperationCategory`
 * разрешённых на станке операций. `OTHER` и любая неожиданная
 * категория → иконку не рисуем (компонент возвращает `null`),
 * плитка остаётся в прежнем виде без пустого слота.
 *
 * Выбор иконок:
 *   - PACKING  → lucide `Package` — коробка;
 *   - CUTTING  → lucide `Scissors` — ножницы;
 *   - QC       → lucide `Search` — лупа;
 *   - SEWING   → локальный `IconSewingMachine` (см. ниже). В
 *     `lucide-react@1.9.0` нет ни `SewingMachine`, ни визуально
 *     близкого аналога — раньше тут стоял `Shirt`, который читается
 *     как «футболка» (готовое изделие), а не как швейная машина и
 *     путал оператора. Своя SVG в едином line-style решает проблему
 *     без апгрейда зависимости;
 *   - IRONING  → локальный `IconIron`. Прежний `Heater` читается
 *     как «обогреватель», а не утюг — оператор не понимал, какая
 *     категория ВТО за ним стоит. Своя SVG (подошва + корпус +
 *     ручка + пар) однозначно читается как утюг.
 *
 * Все иконки — line-style (stroke="currentColor", fill="none",
 * strokeWidth=1.5), приглушённые через CSS (`opacity: 0.65`,
 * `width/height: 0.85em`). Это держит плитку компактной и не даёт
 * иконке перетянуть внимание с цифрового `displayNumber`.
 */
type EquipmentKindIconRender = ((props: {
  className: string;
}) => JSX.Element) & { displayName?: string };

function lucide(Icon: LucideIcon): EquipmentKindIconRender {
  const Render: EquipmentKindIconRender = ({ className }) => (
    <Icon
      className={className}
      strokeWidth={1.5}
      aria-hidden="true"
      focusable={false}
    />
  );
  Render.displayName = `LucideEquipmentIcon(${Icon.displayName ?? 'Icon'})`;
  return Render;
}

const renderSewingIcon: EquipmentKindIconRender = ({ className }) => (
  <IconSewingMachine className={className} />
);
renderSewingIcon.displayName = 'EquipmentKindIcon(SEWING)';

const renderIronIcon: EquipmentKindIconRender = ({ className }) => (
  <IconIron className={className} />
);
renderIronIcon.displayName = 'EquipmentKindIcon(IRONING)';

const EQUIPMENT_KIND_ICON: Record<
  ShopfloorEquipmentStatusDto['kind'],
  EquipmentKindIconRender | null
> = {
  SEWING: renderSewingIcon,
  PACKING: lucide(Package),
  CUTTING: lucide(Scissors),
  QC: lucide(Search),
  IRONING: renderIronIcon,
  OTHER: null,
};

function EquipmentKindIcon({
  kind,
}: {
  kind: ShopfloorEquipmentStatusDto['kind'];
}) {
  const render = EQUIPMENT_KIND_ICON[kind];
  if (!render) return null;
  return render({ className: 'display-equipment-tile__icon' });
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

/**
 * Локальная line-иконка швейной машины (silhouette: стол + корпус +
 * иголка над «гладкой» лапкой). Используется в двух местах:
 *
 *   1. `StageIcon` — заголовок sewing-колонок матрицы (без className,
 *      stroke у `<svg>` приходит от родителя через `currentColor`);
 *   2. `EquipmentKindIcon` — плитка оборудования kind=`SEWING`. На
 *      плитке нужна тонкая «вторичная» иконка, поэтому добавляем
 *      `className="display-equipment-tile__icon"` (CSS приглушает
 *      opacity и задаёт размер 0.85em).
 *
 * `lucide-react@1.9.0` не содержит ни `SewingMachine`, ни какой-либо
 * семантически близкой замены (все варианты Shirt/Scissors/Heater
 * визуально читаются как другие категории — крой / ОТК / ВТО).
 * Поэтому используем свою тонкую SVG, согласованную по стилю
 * (stroke="currentColor", fill="none", strokeWidth=1.5–1.6) с
 * остальными иконками экрана.
 */
function IconSewingMachine({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable={false}
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

/**
 * Локальная line-иконка утюга (silhouette: подошва + корпус + ручка,
 * пар — три коротких штриха над ручкой). Используется и в
 * `StageIcon` для колонок ВТО матрицы, и в `EquipmentKindIcon` для
 * плитки оборудования kind=`IRONING`.
 *
 * В `lucide-react@1.9.0` нет иконки `Iron`. Прежний кандидат `Heater`
 * визуально читается как «обогреватель», а не утюг (на TV оператор
 * путает её с категорией оборудования отопления, которой у нас вообще
 * нет). Поэтому делаем свою тонкую SVG в едином стиле с остальными.
 */
function IconIron({ className }: { className?: string } = {}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable={false}
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
  out: Map<string, number>,
): void {
  // Static-стадии матрицы (только то, что UI реально рисует
  // отдельной td: CUT/PACKING/FINISHED + Брак). QC/QC_DONE/WTO/WTO_DONE
  // больше не визуализируются как отдельные ячейки — они уехали в
  // split-блоки `proc:qc:in|done` / `proc:wto:in|done`, см.
  // `flattenProcessSplits` ниже. Хранить их здесь под старыми ключами
  // нельзя: тогда diff насчитал бы «изменение» в ячейке, которой на
  // экране нет, и flash-эффект бы не сработал ни на одной видимой
  // td (старые ключи не совпадают с новыми cellKey'ами).
  out.set(`${prefix}|CUT`, s.qtyCut);
  out.set(`${prefix}|PACKING`, s.qtyPacking);
  out.set(`${prefix}|FINISHED`, s.qtyFinished);
  out.set(`${prefix}|defect`, s.qtyDefect);
}

/**
 * Расширяет flat-map значениями маршрутных sewing-колонок (▶/✔):
 *
 *   - per-(color,size) — берём per-size lookup (одинаковый по
 *     цветам, потому что backend агрегирует route без цветового
 *     измерения; см. комментарий у `ColorBlockRows`);
 *   - per-color totals — Σ по rows блока (как в JSX);
 *   - grand totals — честный итог операции (sum по всем sizes).
 *
 * Без этого diff-флэш на route-колонках не подсвечивал бы изменения
 * — а это самые «динамичные» цифры на дисплее.
 */
/**
 * Раскладывает все split-блоки матрицы (sewing-операции + ОТК + ВТО)
 * в плоскую map'у `cellKey → value` для diff'а:
 *
 *   - per-(color, size) — `<color>|<sizeId>|<prefix>:in|done`
 *     (sewing берёт per-size lookup, QC/ВТО — `row.qtyQc[Done]` и т. п.);
 *   - per-color totals — `<color>|<TOTALS_SUFFIX>|<prefix>:in|done`
 *     (sewing — Σ rows блока через `inProgressForBlockTotals`,
 *      QC/ВТО — готовый `block.totals.qtyQc[Done]`);
 *   - grand totals — `<GRAND_PREFIX>|<TOTALS_SUFFIX>|<prefix>:in|done`
 *     (sewing — `lookup.totalIn/Done`, QC/ВТО — `totals.qtyQc[Done]`).
 *
 * Без этого diff-флэш на маршрутных колонках не подсвечивал бы
 * изменения — а именно эти цифры (▶/✔ по каждой операции) и есть
 * самые «динамичные» на дисплее. Унификация ОТК/ВТО под тот же
 * формат `:in|done` чинит и подсветку этих новых split-колонок.
 */
function flattenProcessSplits(
  s: ShopfloorDisplayDto,
  out: Map<string, number>,
): void {
  const routeLookup = buildRouteLookup(s.sewingRoute);
  const splits = buildProcessSplits(s.sewingRoute, routeLookup);
  if (splits.length === 0) return;
  for (const block of s.colors) {
    for (const sp of splits) {
      let inSum = 0;
      let doneSum = 0;
      for (const row of block.rows) {
        const inV = sp.inProgressForRow(row, block.colorKey);
        const doneV = sp.doneForRow(row, block.colorKey);
        out.set(
          `${block.colorKey}|${row.sizeId}|${sp.cellPrefix}:in`,
          inV,
        );
        out.set(
          `${block.colorKey}|${row.sizeId}|${sp.cellPrefix}:done`,
          doneV,
        );
        // Для sewing per-color totals — это Σ per-size; для QC/ВТО
        // backend кладёт честное значение в `block.totals.qtyQc[Done]`,
        // но и Σ rows даёт тот же результат (рамка 'IN_PROGRESS' +
        // category + freshFlag — это count по этому же блоку).
        // Используем `inProgressForBlockTotals` — оно одно и то же
        // правильно работает для всех видов splits.
        inSum += inV;
        doneSum += doneV;
      }
      // Для QC/ВТО берём готовые значения из block.totals — это
      // источник истины (а Σ rows может разойтись с totals на 0,
      // если backend меняет порядок суммирования). Для sewing
      // `inProgressForBlockTotals` пройдёт по rows блока ровно так
      // же, как мы только что: значения совпадут.
      const blockIn = sp.inProgressForBlockTotals(block);
      const blockDone = sp.doneForBlockTotals(block);
      void inSum;
      void doneSum;
      out.set(
        `${block.colorKey}|${TOTALS_SUFFIX}|${sp.cellPrefix}:in`,
        blockIn,
      );
      out.set(
        `${block.colorKey}|${TOTALS_SUFFIX}|${sp.cellPrefix}:done`,
        blockDone,
      );
    }
  }
  for (const sp of splits) {
    out.set(
      `${GRAND_PREFIX}|${TOTALS_SUFFIX}|${sp.cellPrefix}:in`,
      sp.inProgressForGrand(s.totals),
    );
    out.set(
      `${GRAND_PREFIX}|${TOTALS_SUFFIX}|${sp.cellPrefix}:done`,
      sp.doneForGrand(s.totals),
    );
  }
}

function flattenSnapshot(s: ShopfloorDisplayDto): Map<string, number> {
  const map = new Map<string, number>();
  for (const block of s.colors) {
    for (const row of block.rows) {
      flattenMatrixSummary(row, `${block.colorKey}|${row.sizeId}`, map);
    }
    flattenMatrixSummary(
      block.totals,
      `${block.colorKey}|${TOTALS_SUFFIX}`,
      map,
    );
  }
  flattenMatrixSummary(s.totals, `${GRAND_PREFIX}|${TOTALS_SUFFIX}`, map);
  flattenProcessSplits(s, map);
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
