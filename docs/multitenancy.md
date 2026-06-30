# Мультитенантность (DB-per-tenant)

> Источник истины по мультиарендности. Если код расходится с этим
> документом — правим код. Дата: 30.06.2026. Ветка фичи: `develop`.

---

## 1. Модель и почему так

Выбрана модель **DB-per-tenant**: один общий код в единственной версии +
**отдельная БД на компанию** в общем Postgres-кластере + отдельная
**control-plane БД** (реестр тенантов) + роутинг по **поддомену** (`Host`).

Почему именно DB-per-tenant (а не колонка `tenant_id` или VPS-на-клиента):

- доменная схема (~120 моделей) **не меняется** — никакого `tenant_id`;
- синглтон `CompanySettings` становится ровно правильным (одна компания = одна БД);
- глобальные уникальности (`Employee.login`, номера заказов) остаются валидны;
- изоляция данных на уровне БД, бэкап/restore по одному клиенту;
- VPS-на-клиента отвергнут (зоопарк версий); код один на всех.

**Ключевой инвариант:** мультитенантность **опциональна и обратносовместима**.
Без `CONTROL_PLANE_DATABASE_URL` приложение работает как раньше (single-tenant,
БД = `DATABASE_URL`). Прод сегодня работает именно так.

---

## 2. Окружения (независимые) и адреса

prod / dev / (будущий) teeon.ru — это **отдельные окружения** (деплои одного
кода со своей Postgres), а НЕ тенанты. У каждого окружения **своя
мультитенантность**: свой control-plane, свои тенанты, свой супер-админ.

| Окружение | Вход | Тенанты клиентов | control-plane БД | Postgres |
|---|---|---|---|---|
| **dev** | `dev.teeon.ru` | `*.dev.teeon.ru` | свой `control_plane` | `sewing-db-1` |
| **prod** | `prod.teeon.ru` | `*.prod.teeon.ru` | свой `control_plane` | `sewing-prod-db-1` |
| **teeon.ru** (будущий SaaS) | `teeon.ru` | `*.teeon.ru` | свой `control_plane` | своя |

Привязка окружения = переменная `CONTROL_PLANE_DATABASE_URL` (указывает на
control_plane именно этого окружения). Окружения полностью изолированы: тенант,
заведённый в dev, в prod не существует.

**Namespace не пересекается** — nginx wildcard `*.teeon.ru` матчит только ОДИН
уровень, точные `server_name` приоритетнее wildcard:

```
acme.teeon.ru        → teeon.ru SaaS   (один уровень → *.teeon.ru)
acme.dev.teeon.ru    → dev             (два уровня   → *.dev.teeon.ru)
acme.prod.teeon.ru   → prod            (два уровня   → *.prod.teeon.ru)
dev/prod/teeon.ru    → точные server_name (вход окружения / дефолтный тенант)
```

DNS: на каждое окружение — wildcard A-запись его namespace на IP сервера
(`*.dev.teeon.ru`, `*.prod.teeon.ru`, `*.teeon.ru`). На 30.06 добавлена
`*.teeon.ru → 159.194.208.32`.

---

## 3. Архитектура (компоненты)

Бэкенд (`apps/api/src/prisma/`):

- **`control-plane.service.ts`** — отдельный Prisma-клиент к control-plane БД
  (`.prisma/control-plane-client`). Опционален: `isEnabled()` = задан ли
  `CONTROL_PLANE_DATABASE_URL`.
- **`tenant-context.ts`** — `TenantContext` на встроенном `AsyncLocalStorage`:
  держит `tenantId` на время запроса.
- **`tenant-registry.service.ts`** — резолв `Host → TenantInfo` через
  control-plane (`TenantDomain`), LRU-кэш + TTL + короткий негатив-TTL +
  `invalidate*`. Single-tenant fallback (дефолтный тенант = `DATABASE_URL`).
- **`prisma-client-manager.ts`** — LRU-пул `PrismaClient` по тенанту (по одному
  на БД), DB-инварианты (partial unique indexes), бюджет коннектов (warn при
  `cacheMax×connLimit > TENANT_DB_MAX_CONNECTIONS`).
- **`prisma.service.ts`** — `PrismaService` стал `abstract` DI-токеном; реальный
  инстанс = **Proxy-делегатор**, форвардит на клиент текущего тенанта. Все ~84
  потребителя `this.prisma.*` не тронуты.
- **`tenant-resolver.middleware.ts`** — на каждый запрос ставит `TenantContext`
  (приоритет `x-tenant-host`, затем `Host`), `/health` исключён (liveness).

Сессия (мультиарендная привязка): `auth/session.ts` — `tid`-claim; `auth.service`
ставит `tid` при логине и **отвергает токен другого тенанта** в `resolvePrincipal`
(при включённом control-plane).

Control-plane схема (`prisma/control-plane/schema.prisma`, отдельный клиент):
`Tenant` / `TenantDomain` / `TenantModule` / `TenantMigration`.

Фронт: `apps/web/lib/api.ts` форвардит `x-tenant-host` (домен пользователя) в
SSR-вызовах; модули тенанта приходят через `GET /api/auth/me` (`modules`).

Скрипты (`scripts/tenants/`): `create-tenant.ts`, `register-existing.ts`,
`migrate-all.ts` (+ `migrations-util.ts`). npm: `tenant:create` /
`tenant:register` / `tenant:migrate-all` / `control-plane:push` /
`prisma:generate:control-plane`.

Панель супер-админа: API `/api/superadmin/*` (роль `SUPERADMIN`,
`SuperadminGuard` — НЕ пускает обычного `ADMIN`), web `/superadmin` (список,
создание тенанта, статус/домены/модули).

---

## 4. Что сделано (фазы, всё в `develop`)

| Фаза | Что | Коммит |
|---|---|---|
| 0 | Шов DB-per-tenant: TenantContext + Proxy-PrismaService + PrismaClientManager + resolver-middleware (single-tenant fallback) | `94bb8e3` |
| 1 | Runtime feature-модули через `/api/auth/me` вместо build-time `NEXT_PUBLIC_FEATURE_*` | `880c81e` |
| 2 | Control-plane: отдельная Prisma-схема+клиент, TenantRegistry/FeatureModulesService через БД, скрипты провижининга/миграций | `8aa0197` |
| — | fix: генерировать 2-й Prisma-клиент ДО `nest build` (иначе прод-сборка падала TS2307) | `7f8b465` |
| 3 | Tenant-bound session (`tid`), deploy-prod control-plane:push+migrate-all, бюджет коннектов | `8476be6` |
| 4 | Панель супер-админа `/superadmin` (роль SUPERADMIN, миграция `20260829100000`) | `a4a993c` |
| — | dev nginx-vhosts для браузерного доступа к тенантам (host-local) | `7425062`, `6a4faef` |

Каждая фаза dev-проверена и прошла adversarial-ревью (Ф2: 22 находки, Ф3: 1,
Ф4: 3 — все подтверждённые исправлены).

**Состояние окружений:**
- **dev** — control-plane ВКЛЮЧЁН. Тенанты `default` (dev.teeon.ru) + `demo2`
  (demo2.dev.teeon.ru). Реально проверено: создание тенанта, резолв по домену,
  per-tenant модули, отказ кросс-тенантного токена (401), панель супер-админа.
- **prod** — задеплоен код (Фаза 4), но **single-tenant** (control-plane ВЫКЛ):
  панель `/superadmin` отдаёт 404 by design, поведение для пользователей не
  изменилось.

---

## 5. Как работает создание тенанта (per-окружение)

`create-tenant` (из панели `/superadmin` или CLI) исполняется в api-контейнере
ТОГО окружения и: создаёт БД в его Postgres → `migrate deploy` (см. грабли §8) →
DB-инварианты → сид справочников → `CompanySettings` + админ → регистрирует в
его control-plane (`Tenant` + `TenantDomain` + `TenantModule`).

Значит: вошёл в `dev.teeon.ru/superadmin` → тенант в dev; вошёл в
`prod.teeon.ru/superadmin` → тенант в prod. У каждого окружения свой
супер-админ (в его дефолтной БД).

---

## 6. Runbook: включить мультитенантность на окружении

Одинаково для prod и будущего teeon.ru (на dev уже сделано). Разово:

1. Создать `control_plane` БД в Postgres окружения; `npm run control-plane:push`.
2. `tenant:register` — зарегистрировать существующую БД как дефолтного тенанта с
   его хостами (для prod: `prod.teeon.ru`, `api`, `localhost`, `127.0.0.1`)
   **ДО** включения, иначе все запросы → 404.
3. Завести супер-админа в дефолтной БД (роль `SUPERADMIN`).
4. Выставить `CONTROL_PLANE_DATABASE_URL` в `.env` окружения; пересобрать образ
   (генерит 2-й клиент) и задеплоить.
   ⚠️ Разовый эффект: все активные сессии окружения станут невалидны
   (tenant-binding по `tid`) → пользователи перелогинятся.
5. nginx: wildcard-vhost на namespace окружения (`*.prod.teeon.ru` /
   `*.teeon.ru`) → app, со strip `x-tenant-host`; в deploy-prod уже есть §4b
   (control-plane:push + tenant:migrate-all при заданном env).
6. TLS поддоменов — см. §7 (выбор A/B).

---

## 7. Что осталось

**Решение по TLS поддоменов тенантов** (для «онбординг в один клик»):

- **A. Wildcard-cert** `*.<namespace>` через Let's Encrypt **DNS-01** — один cert
  + один wildcard-vhost, zero-touch. Нужен API DNS-провайдера (домен на Яндексе —
  PDD-токен). *Рекомендуется.*
- **B. Per-subdomain HTTP-01** — cert + nginx-блок выпускаются автоматически
  внутри `create-tenant` при заведении тенанта (токен не нужен; auto-renew крон).

Сейчас по факту сделан ручной образец пути B (demo2 на настоящем домене,
доверенный cert). Автоматизация (A или B) — **не сделана**, выбор за владельцем.

**Ops/бизнес (вне кода):**
- включить control-plane на prod по §6 (когда появится 2-й реальный клиент или
  чтобы оформить текущую компанию тенантом `default`);
- поднять окружение teeon.ru (SaaS) по §6, когда дойдёт;
- wildcard DNS на namespace prod/SaaS (на dev/`*.teeon.ru` — добавлено);
- auto-renew Let's Encrypt (на хосте нет certbot/крона — продление через
  `docker run … certbot/certbot renew && nginx -s reload`);
- PgBouncer — при росте числа одновременно прогретых тенантов
  (`cacheMax×connLimit` vs `max_connections`).

---

## 8. Отложено / known issues

- **QR-токен (`employee-qr`) НЕ привязан к тенанту** — но его HMAC-verify сейчас
  не консьюмится в живом флоу (master-flow использует `parseEmployeeQr`).
  Привязать `tid`, когда заведут master-flow на QR.
- **Инвалидация кэша резолва из out-of-process** — скрипты (create/register)
  не сигналят работающему API; правка статуса/домена видна до TTL (30с). Панель
  супер-админа (в процессе) инвалидирует сразу. Приемлемо.
- **Провижининг через `migrate deploy`** требует, чтобы миграции в репозитории
  были в сине со `schema.prisma`. В этом проекте dev-схема ведётся через
  `db push` и может уходить вперёд миграций — тогда свежая тенант-БД получит
  неполную схему. Грабли: на 30.06 дев-клиент Prisma устарел относительно
  `schema.prisma` (внешняя правка убрала `Employee.salaryPerHour`) → логин
  тенанта давал 500; лечится `prisma generate` из текущей схемы. На будущее —
  периодически вливать `main` в `develop` (дев-БД живёт под main-схемой) и
  держать миграции актуальными ИЛИ провижинить тенанта через `db push`.
- **2-й Prisma-клиент** надо генерить в обоих Dockerfile (`prisma:generate:
  control-plane`) и ДО `nest build` (prod типизирует импорт); `scripts/`
  обязан попасть в prod-образ (COPY) — иначе `tenant:migrate-all` падает.

---

## 9. Текущее состояние dev (для проверки)

- control-plane ВКЛЮЧЁН (`CONTROL_PLANE_DATABASE_URL` в `.env.dev`).
- Тенанты: `default` (БД `myapp`, dev.teeon.ru) + `demo2` (БД `tenant_demo2`).
- Супер-админ: `dev.teeon.ru/superadmin`, логин `superadmin` (пароль — в dev-заметках).
- Доступ к demo2 в браузере (доверенный cert, без правок hosts):
  `https://demo2.dev.teeon.ru` или `https://demo2.159.194.208.32.nip.io`
  (nip.io — публичный wildcard-DNS, LE-cert через HTTP-01).
- Дев-логины — демо (`Demo12345!`), см. `prisma/seed.ts`.
- Host-local артефакты (НЕ зависят только от репо — нужны cert-ы на хосте):
  `nginx/conf.d/22-tenants-dev-teeon-ru.conf` (wildcard `*.dev.teeon.ru` +
  `*.<ip>.nip.io`), `23-demo2-nip-io.conf`, `24-demo2-teeon.conf`.
- Откат dev в single-tenant: убрать `CONTROL_PLANE_DATABASE_URL` из `.env.dev`
  + пересоздать api-контейнер.

> Маркер «какой тенант резолвится» при отладке: НЕ по `modules.suppliers`
> (могли переключить), а по `company-settings.legalName` (demo2 = «ООО Демо-2»,
> default = пусто).
