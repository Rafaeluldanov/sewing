# Deploy / Stage (`stage.teeon.ru`)

Документ описывает развёртывание stage-окружения для MVP 1.1. **Только
инфраструктура (DNS / nginx / процессы / .env / smoke-checklist)**.
Бизнес-логику, prisma-схему, auth и CI/CD этот документ не трогает.

Целевые компоненты:

- **WEB** (Next.js 14, `apps/web`) → `127.0.0.1:3000`
- **API** (NestJS 10, `apps/api`) → `127.0.0.1:3001`, prefix `/api`
- **nginx** на 80/tcp → reverse-proxy `/` → web, `/api/` → api
- **PostgreSQL 15** локально (см. `DATABASE_URL` в `.env`)

---

## 1. Настройка stage-домена (DNS)

Stage обслуживается на одном сервере. Перед любыми остальными шагами
домен `stage.teeon.ru` **обязан резолвиться в IP этого сервера**, иначе
браузер просто не дойдёт до nginx.

Проверка:

```bash
getent hosts stage.teeon.ru
# ожидаем: <SERVER_IP>  stage.teeon.ru
```

Если запись пустая, создать в панели DNS-провайдера домена `teeon.ru`:

| Поле     | Значение            |
| -------- | ------------------- |
| Тип      | `A`                 |
| Имя      | `stage`             |
| Значение | `<SERVER_IP>`       |
| TTL      | `300` (5 минут)     |

`<SERVER_IP>` — публичный IPv4 stage-сервера (узнаётся командой
`curl -s https://api.ipify.org` на самом сервере). **Не хардкодить IP в
репозитории** — он зависит от площадки и может меняться.

После создания записи DNS подхватывается за единицы минут. Повторить
`getent hosts stage.teeon.ru` до получения корректного ответа.

---

## 2. NGINX конфиг

Файл: `/etc/nginx/sites-available/stage.teeon.ru`

```nginx
server {
    listen 80;
    server_name stage.teeon.ru;

    # --- Next.js static chunks (см. §2a, ОБЯЗАТЕЛЬНО) -------------------
    # Файлы из `apps/web/.next/static/` отдаются напрямую с диска,
    # минуя Node.js. Без этого блока браузер получит HTML 404 вместо JS
    # и упадёт с `ChunkLoadError`. Этот блок ДОЛЖЕН идти ДО общего
    # `location /` (nginx выбирает longest-prefix, но порядок объявления
    # держит конфиг читаемым).
    location /_next/static/ {
        alias /sewing/apps/web/.next/static/;
        access_log off;
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # Всё остальное под /_next/ (HMR, image optimization, RSC payload
    # и т.п.) уходит в Next-процесс как обычно.
    location /_next/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    # --- User uploads (модуль «Лекала» и любые будущие файловые модули) -
    # `/uploads/*` физически лежат на диске API-хоста (см.
    # `PATTERNS_UPLOADS_DIR`, по умолчанию `apps/api/uploads`), а раздаются
    # NestJS через `useStaticAssets('/uploads', uploadsRoot)` (см.
    # `apps/api/src/main.ts`). Без этого блока nginx по longest-prefix
    # отдаёт запрос в Next.js (`location /`), Next.js про `/uploads/...`
    # не знает и возвращает HTML 404 — у пользователя «битая картинка»
    # в карточке номенклатуры и в форме заказа. Подробнее — см.
    # `docs/deploy-uploads-static-routing.md`.
    #
    # `^~` фиксирует, что любые regex-`location`-ы дальше уже не имеют
    # значения для этого префикса; в нашем конфиге их сейчас нет, но
    # маркер дешёвый и бережёт нас от регрессов «кто-то добавил `~ \.jpg$`».
    # ОБЯЗАТЕЛЬНО объявлять ДО `location /`, иначе longest-prefix
    # посчитает их равными и порядок объявления решит, кто победит.
    location ^~ /uploads/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
    }
}
```

Активация:

```bash
sudo ln -s /etc/nginx/sites-available/stage.teeon.ru \
           /etc/nginx/sites-enabled/stage.teeon.ru
sudo nginx -t
sudo systemctl reload nginx
```

> HTTPS (Let's Encrypt) на этом этапе не настраивается — это отдельная
> задача после того, как голый HTTP откроется. Для production-сертификата
> в той же конфигурации потом добавляется `listen 443 ssl;` + блок
> certbot. Блок `/_next/static/` ДОЛЖЕН быть продублирован и в
> `https`-сервере — иначе после переезда на TLS снова появится
> `ChunkLoadError`.

---

## 2a. Next.js static chunks (обязательно)

**Это самая частая поломка stage-фронта.** Если её не настроить
заранее — приложение упадёт при первом же открытии после деплоя.

### Что происходит, если этого блока нет

1. Браузер запрашивает `/_next/static/chunks/app/<route>/<hash>.js`.
2. nginx отдаёт запрос в Next-процесс как обычный route.
3. Next.js не знает такого route и возвращает HTML 404.
4. Браузер получает HTML вместо JavaScript → `ChunkLoadError` /
   `Loading chunk failed` / `Unexpected token '<'`.
5. Страница либо вообще не рендерится, либо рендерится в HMR-loop.

Эта ошибка **не зависит от бизнес-логики** и воспроизводится на любом
билде Next.js — её нельзя «починить кодом». Единственное лечение —
правильный nginx.

### Что должно быть на сервере

| Параметр                    | Значение                                          |
|-----------------------------|---------------------------------------------------|
| Путь к статике на диске     | `/sewing/apps/web/.next/static/`                  |
| URL, который шлёт браузер   | `/_next/static/...`                               |
| Кто отдаёт файл             | nginx (`alias`), не Node.js                       |
| Кэш                         | `Cache-Control: public, immutable`, `expires 1y`  |

Конфиг — см. §2 (блок `location /_next/static/`).

> Между `npm run build` и `npm run start --workspace=apps/web` каталог
> `.next/static/` пересобирается. Если пользователь держит вкладку
> открытой во время деплоя — у него отвалятся старые chunk-и (это
> ожидаемо: hash в имени файла меняется). Runtime-guard в
> `apps/web/components/chunk-error-guard.tsx` ловит такие случаи и
> делает один `location.reload()`, после чего браузер берёт уже
> новый набор chunk-ов.

### Health-check после каждого деплоя

После `nginx reload` и старта `next start` ОБЯЗАТЕЛЬНО прогнать:

```bash
# Любой реально существующий chunk — например, из app-router-а:
CHUNK_URL=$(curl -s http://stage.teeon.ru/login \
  | grep -oE '/_next/static/chunks/[^"]+\.js' | head -n 1)

curl -sSI "http://stage.teeon.ru${CHUNK_URL}"
```

Ожидаем:

```
HTTP/1.1 200 OK
Content-Type: application/javascript
Cache-Control: public, immutable
```

Если приходит `Content-Type: text/html` или `404 Not Found` — конфиг
nginx сломан. **Дальше не идти**, чинить §2 / §2a:

1. проверить, что `alias` указывает на реальный путь
   (`ls -la /sewing/apps/web/.next/static/chunks/ | head`);
2. убедиться, что блок `location /_next/static/` объявлен ДО общего
   `location /` (или хотя бы есть `try_files $uri =404` —
   тогда порядок не важен);
3. `sudo nginx -t && sudo systemctl reload nginx`;
4. повторить curl.

---

## 3. ENV для stage

Файл `.env` в корне репозитория должен содержать stage-URL-ы. Полный
комментированный пример — `.env.example`. Минимально для stage:

```env
APP_URL=https://stage.teeon.ru
API_URL=https://stage.teeon.ru/api
NEXT_PUBLIC_APP_URL=https://stage.teeon.ru
NEXT_PUBLIC_API_URL=https://stage.teeon.ru/api
```

Что **не меняется** на stage:

- `DATABASE_URL` — остаётся как настроено локально на сервере;
- `JWT_SECRET` — на stage желательно переопределить случайной строкой
  ≥ 32 байт, но это вне scope данного документа (см. ADR-0014);
- `API_PORT=3001` — порт, к которому проксирует nginx.

---

## 4. Запуск приложения

API слушает порт `3001`, WEB — порт `3000`. nginx (см. §2) проксирует
снаружи только эти два порта, наружу они напрямую не торчат.

### DEV-режим (горячая перезагрузка)

```bash
npm run dev:api    # NestJS на :3001 (nest start --watch)
npm run dev:web    # Next.js на :3000 (next dev -p 3000)
```

Каждую команду запускать в своём терминале.

### PROD-режим (то, что крутится на stage)

```bash
npm install
npm run prisma:migrate     # применить миграции (требует DATABASE_URL)
npm run db:seed            # справочники + демо-учётки (идемпотентно)
npm run build              # next build + nest build для всех workspace
npm run start --workspace=apps/api    # node dist/main.js на :3001
npm run start --workspace=apps/web    # next start -p 3000
```

> `npm run build` в корне делает `--workspaces --if-present`, т.е. строит
> и web, и api. Старт двух процессов раздельный — `npm run start` в корне
> не определён сознательно (см. `package.json`). Для production-надзора
> ставить под `systemd` / `pm2` / `supervisord` — конкретный
> process-manager на усмотрение площадки.

---

## 5. Checklist проверки

Прогнать **по порядку** на stage-сервере. Если шаг падает — дальше идти
бессмысленно, чинить именно его.

| # | Команда                                       | Что ожидаем                                |
|---|-----------------------------------------------|--------------------------------------------|
| 1 | `getent hosts stage.teeon.ru`                 | строка с `<SERVER_IP> stage.teeon.ru`      |
| 2 | `ss -ltnp \| grep ':3000 '`                   | висит процесс `next start` / `node`        |
| 3 | `ss -ltnp \| grep ':3001 '`                   | висит процесс `node` (API)                 |
| 4 | `curl -sS http://127.0.0.1:3000 \| head`      | HTML (`<!DOCTYPE html>`)                   |
| 5 | `curl -sS http://127.0.0.1:3001/api/health`   | `{"status":"ok","time":"..."}` (HTTP 200)  |
| 6 | `curl -sSI http://stage.teeon.ru`             | `HTTP/1.1 200 OK` или редирект `/login`    |
| 7 | Открыть `http://stage.teeon.ru` в браузере    | редирект на `/login`, форма логина рисуется|
| 8 | См. §2a «health-check после деплоя»           | `200 OK` + `Content-Type: application/javascript` |
| 9 | См. [`docs/deploy-uploads-static-routing.md`](./deploy-uploads-static-routing.md) — uploads | `200 OK` для существующего файла из `apps/api/uploads/` |

Шаг 8 проверяет, что `/_next/static/*` идёт через nginx, а не через
Next-процесс. Если этот шаг упал — стопроцентно будет `ChunkLoadError`
у любого пользователя. Чинить — §2 / §2a.

Шаг 9 проверяет, что `/uploads/*` идёт через nginx → API (NestJS
`useStaticAssets`), а не через Next.js. Если он падает — превью лекала
не открывается на `/admin/patterns` и в форме заказа. Чинить — §2 (блок
`location ^~ /uploads/`) и [`docs/deploy-uploads-static-routing.md`](./deploy-uploads-static-routing.md).

Доп. sanity (опционально):

```bash
curl -sS http://127.0.0.1:3001/api/ready    # БД отвечает на SELECT 1
sudo nginx -t                                # синтаксис конфига валиден
sudo journalctl -u nginx -n 50 --no-pager    # последние логи nginx

# Прямая проверка, что .next/static/ собран на диске:
ls /sewing/apps/web/.next/static/chunks/ | head
```

---

## 6. Что НЕ входит в этот документ

- HTTPS / Let's Encrypt (отдельный шаг после §5.6);
- Docker / docker-compose (на stage не используется, см. ADR-0001);
- CI/CD pipeline и автодеплой;
- prod-окружение `prod.teeon.ru` / `api.prod.teeon.ru`;
- любые изменения бизнес-логики, prisma-схемы, auth.
