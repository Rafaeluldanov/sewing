import { Injectable, Logger } from '@nestjs/common';

/**
 * HTTP-клиент внешнего ERP upgifts (erp.upgifts.ru).
 *
 * Топология v1: sewing — КЛИЕНТ REST API upgifts. Аутентификация — JWT:
 * `POST /auth/token` по `{ tenant, email, password }` сервисного аккаунта
 * → `access_token` (RS256, короткоживущий) + `refresh_token`. Все
 * прикладные вызовы идут с `Authorization: Bearer <access_token>`.
 *
 * Клиент СТАТЕЛЕСС по учёткам (получает конфиг снаружи — из
 * `IntegrationsService`, который расшифровывает пароль), плюс держит
 * маленький in-memory кэш access-токенов, чтобы не логиниться на каждый
 * вызов (пригодится Фазам 2+ — выгрузка себестоимости/статусов).
 *
 * Ошибки транспорта/HTTP оборачиваются в {@link UpgiftsApiError} — их
 * ловит сервис и превращает в fail-soft результат
 * (`UpgiftsTestConnectionResult` и т.п.), наружу 5xx не пробрасываем.
 *
 * Контракты upgifts — `docs/upgifts-integration.md §3`.
 */

export interface UpgiftsCredentials {
  /** Base URL без завершающего слэша (напр. `https://erp.upgifts.ru`). */
  baseUrl: string;
  tenant: string;
  email: string;
  password: string;
}

/** Ответ `POST /auth/token` (upgifts `TokenOut`, нужные нам поля). */
interface UpgiftsTokenOut {
  access_token: string;
  token_type?: string;
  expires_in: number; // секунды
  refresh_token: string;
  tenant_id?: string;
}

/** Ответ `GET /auth/me` (upgifts Principal, нужные нам поля). */
export interface UpgiftsPrincipal {
  user_id?: string;
  tenant_id?: string;
  scopes?: string[];
  roles?: string[];
}

/** Ошибка вызова upgifts (транспорт или не-2xx). */
export class UpgiftsApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'UpgiftsApiError';
  }
}

interface CachedToken {
  accessToken: string;
  /** epoch ms, когда токен считаем протухшим (с запасом). */
  expiresAtMs: number;
}

/** Таймаут одного запроса к upgifts. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Запас до истечения токена, чтобы не словить 401 на границе. */
const TOKEN_SKEW_MS = 30_000;

@Injectable()
export class UpgiftsClient {
  private readonly logger = new Logger(UpgiftsClient.name);
  /** Кэш access-токенов по ключу учётки (baseUrl|tenant|email). */
  private readonly tokenCache = new Map<string, CachedToken>();

  /** Нормализовать base URL: срезать хвостовые слэши. */
  static normalizeBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
  }

  private cacheKey(c: UpgiftsCredentials): string {
    return `${UpgiftsClient.normalizeBaseUrl(c.baseUrl)}|${c.tenant}|${c.email}`;
  }

  /**
   * Низкоуровневый запрос с таймаутом. Возвращает распарсенный JSON.
   * Бросает {@link UpgiftsApiError} на таймаут/сеть/не-2xx.
   */
  private async request<T>(
    baseUrl: string,
    path: string,
    opts: {
      method: 'GET' | 'POST';
      token?: string;
      body?: unknown;
    },
  ): Promise<T> {
    const url = `${UpgiftsClient.normalizeBaseUrl(baseUrl)}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = (e as { name?: string })?.name === 'AbortError';
      throw new UpgiftsApiError(
        aborted
          ? `Таймаут запроса к upgifts (${REQUEST_TIMEOUT_MS} мс): ${path}`
          : `Сеть недоступна при запросе к upgifts: ${String(e)}`,
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new UpgiftsApiError(
        `upgifts ответил ${res.status} на ${path}`,
        res.status,
        text.slice(0, 500),
      );
    }
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new UpgiftsApiError(
        `Некорректный JSON от upgifts на ${path}`,
        res.status,
        text.slice(0, 200),
      );
    }
  }

  /** Логин по сервисному аккаунту → `TokenOut`. */
  private login(c: UpgiftsCredentials): Promise<UpgiftsTokenOut> {
    return this.request<UpgiftsTokenOut>(c.baseUrl, '/auth/token', {
      method: 'POST',
      body: { tenant: c.tenant, email: c.email, password: c.password },
    });
  }

  /**
   * Access-токен с кэшированием. Логинится при отсутствии/протухании.
   * `forceRefresh` игнорирует кэш (напр. после 401).
   */
  async getAccessToken(
    c: UpgiftsCredentials,
    forceRefresh = false,
  ): Promise<string> {
    const key = this.cacheKey(c);
    const now = Date.now();
    const cached = this.tokenCache.get(key);
    if (!forceRefresh && cached && cached.expiresAtMs > now) {
      return cached.accessToken;
    }
    const tok = await this.login(c);
    const ttlMs = Math.max(0, (tok.expires_in ?? 0) * 1000 - TOKEN_SKEW_MS);
    this.tokenCache.set(key, {
      accessToken: tok.access_token,
      expiresAtMs: now + ttlMs,
    });
    return tok.access_token;
  }

  /** Сбросить кэшированный токен (напр. при смене учётки/отключении). */
  invalidateToken(c: UpgiftsCredentials): void {
    this.tokenCache.delete(this.cacheKey(c));
  }

  /**
   * Проверка соединения: логин + `GET /auth/me`. Возвращает principal.
   * Бросает {@link UpgiftsApiError} — ловит вызывающий сервис.
   */
  async fetchMe(c: UpgiftsCredentials): Promise<UpgiftsPrincipal> {
    const token = await this.getAccessToken(c, /* forceRefresh */ true);
    return this.request<UpgiftsPrincipal>(c.baseUrl, '/auth/me', {
      method: 'GET',
      token,
    });
  }
}
