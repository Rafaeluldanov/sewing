# Deploy / Static routing для `/uploads/*`

> Точечный документ по одной поломке: **превью лекала на
> `/admin/patterns` и в форме заказа открывается с `404 Not Found`** на
> stage/prod, потому что nginx отдаёт `/uploads/...` в Next.js, а не в
> NestJS. Здесь фиксируем, как должно быть, и как это проверить.

Связанные документы:

- общий nginx-конфиг и DNS — [`docs/deploy-stage.md §2`](./deploy-stage.md);
- скрипт деплоя — [`scripts/deploy-stage.sh`](../scripts/deploy-stage.sh);
- модуль «Лекала» (откуда берётся `/uploads/patterns/...`) —
  [`docs/recon-soft-integration.md`](./recon-soft-integration.md).

---

## 1. Где физически лежат файлы

Источник правды — `apps/api/src/modules/patterns/patterns-storage.service.ts`
и `apps/api/src/main.ts`.

| Параметр                | Значение                                                        |
|-------------------------|-----------------------------------------------------------------|
| Корень storage на диске | `PATTERNS_UPLOADS_DIR` (env), default `apps/api/uploads/`       |
| Раскладка patterns      | `<root>/patterns/<patternItemId>/preview/<filename>.<ext>`      |
|                         | `<root>/patterns/<patternItemId>/sizes/<sizeId>/<filename>.dxf` |
| Публичный URL-prefix    | `/uploads`                                                      |
| Что лежит в БД          | `PatternItem.previewImageUrl = "/uploads/patterns/.../preview/..."` (relative) |
| Кто раздаёт static      | NestJS `useStaticAssets(uploadsRoot, { prefix: '/uploads' })`   |
| Порт API                | `3001`                                                          |

> URL в БД — **относительный** (`/uploads/...`), это сознательное
> решение: у нас один `<host>` для web и api на каждом окружении (см.
> `docs/index.md §«Домены и URL-ы»`). Фронт подставляет его в
> `<img src=...>` без префикса домена и попадает в тот же origin.

`PATTERNS_UPLOADS_DIR` на stage/prod **должен** указывать на
persisted-том (NFS / volume / отдельный каталог вне репозитория),
иначе очередной `git pull && npm run build` физически снесёт всё
накопленное. На голом stage без NFS достаточно вынести каталог из
репозитория, например в `/var/lib/sewing/uploads`, и сослаться на него
из `.env`:

```env
PATTERNS_UPLOADS_DIR=/var/lib/sewing/uploads
```

---

## 2. Почему это ломалось

`stage.teeon.ru` — один домен, и nginx по умолчанию проксирует:

- `/api/` → `127.0.0.1:3001` (NestJS),
- `/`    → `127.0.0.1:3000` (Next.js).

`/uploads/...` под longest-prefix попадает в `location /`, то есть в
Next.js. У Next.js нет route `/uploads/...`, он отдаёт HTML 404 →
браузер видит `Image failed to load`. NestJS при этом исправно отдал бы
файл, но запрос до него просто не доходит.

Лечится одним блоком в nginx, объявленным **ДО** общего `location /`.

---

## 3. Как должно быть в nginx

Файл (на stage): `/etc/nginx/sites-available/stage.teeon.ru`. Полный
конфиг — [`docs/deploy-stage.md §2`](./deploy-stage.md). Ключевой блок
(должен лежать **выше** `location /`):

```nginx
location ^~ /uploads/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Замечания:

- `^~` нужен только как маркер «дальше regex-`location`-ы для этого
  префикса не рассматриваем». В нашем конфиге сейчас regex-`location`-ов
  нет, но добавление дешёвое и защищает от регрессов вроде
  `location ~ \.jpg$` где-нибудь в другом блоке.
- Если в проекте появится `upstream api { server 127.0.0.1:3001; }` —
  заменить `proxy_pass http://127.0.0.1:3001;` на `proxy_pass http://api;`,
  чтобы не дублировать адрес. Сейчас upstream-а нет.
- **Не** вкладывать раздачу через `alias` (как для `/_next/static/`):
  вся валидация имени, защита от path-traversal и whitelist расширений
  живут в `PatternsStorageService`, а файл на диск пишется ровно тем же
  процессом. Перенос раздачи на nginx сэкономит один hop, но размывает
  ответственность; на MVP не оправдано.

---

## 4. Что нельзя делать на деплое

- **Не удалять** `apps/api/uploads/` (или путь из `PATTERNS_UPLOADS_DIR`)
  при деплое. В `.gitignore` каталог уже исключён, но любой ручной
  `rm -rf apps/api` на сервере снесёт превью и DXF, восстановить их
  будет нечем. Нужен persisted-том вне репозитория или хотя бы явное
  «не трогать» в любом cleanup-скрипте.
- **Не менять** формат `PatternItem.previewImageUrl` в БД на
  абсолютный URL вида `https://stage.teeon.ru/uploads/...`. Это
  ломает локальный dev (фронт уйдёт на чужой stage за картинкой) и
  миграции на prod-домен.
- **Не менять** prefix на `/api/uploads/...`. URL уже зашит в БД, и
  переименование требовало бы миграции данных. Раздаём именно `/uploads`.
- **Не подключать** `next/image` для превью лекала. Помимо того, что
  потребуется `next.config.js` с разрешённым `/uploads`-доменом, у нас
  одно превью на форму — оптимизация не оправдана.

---

## 5. Команды ручной проверки на stage

Берём реально существующий файл (например, тот, что воспроизводил
`404` в исходном баге):

```bash
UPLOAD_URL="/uploads/patterns/cmoeqygmg0000c8zigzd1bxmw/preview/1777187999239-2385c5608dfc2b1e.jpg"

curl -I "http://127.0.0.1:3001${UPLOAD_URL}"      # API напрямую
curl -I "http://127.0.0.1:3000${UPLOAD_URL}"      # Next.js напрямую
curl -I "https://stage.teeon.ru${UPLOAD_URL}"     # nginx → API
```

Ожидаемо:

| Запрос                          | Ожидаемый ответ                                |
|---------------------------------|------------------------------------------------|
| `127.0.0.1:3001` (API)          | `200 OK`, если файл есть на диске              |
| `127.0.0.1:3000` (Next.js)      | `404` или `200 + text/html` — это нормально,   |
|                                 | мы и не хотим, чтобы Next.js отдавал uploads   |
| `https://stage.teeon.ru` (nginx)| `200 OK` ⇒ `location ^~ /uploads/` работает    |

Если **API сам** (`127.0.0.1:3001`) возвращает 404 — значит проблема
не в nginx, а либо в физическом отсутствии файла, либо в неправильно
выставленном `PATTERNS_UPLOADS_DIR`. Диагностика:

```bash
# 1) Файл реально лежит?
find /sewing -name "1777187999239-2385c5608dfc2b1e.jpg" -ls

# 2) Какой каталог сейчас раздаёт API?
journalctl -u sewing-api --no-pager | grep -E 'Static uploads root' | tail -n 1
#   → ожидаем строку вида: «Static uploads root: /sewing/apps/api/uploads → /uploads»

# 3) Права на каталог: API запущен под root (см. deploy/systemd/sewing-api.service),
#    но если переехать на отдельного пользователя — у него должен быть r-доступ.
ls -ld /sewing/apps/api/uploads
ls -l /sewing/apps/api/uploads/patterns/<patternId>/preview/ | head
```

Если nginx (`stage.teeon.ru`) отдаёт `404`, а `127.0.0.1:3001` отдаёт
`200` — блок `location ^~ /uploads/` либо отсутствует, либо объявлен
**после** `location /`. Чинится правкой
`/etc/nginx/sites-available/stage.teeon.ru` (конфиг приведён в §3 этого
документа и в [`docs/deploy-stage.md §2`](./deploy-stage.md)) и:

```bash
sudo nginx -t                  # синтаксис конфига валиден
sudo systemctl reload nginx    # подхватить изменения
```

---

## 6. Стейдж-чеклист после правки nginx

Минимум, чтобы убедиться, что изменения не сломали остального:

```bash
# Главная страница / редирект на /login (как раньше)
curl -sSI http://stage.teeon.ru | head -n 1

# /api по-прежнему отвечает
curl -sS http://stage.teeon.ru/api/health

# /_next/static/* по-прежнему отдаётся nginx-ом, не Next-ом
CHUNK_URL=$(curl -s http://stage.teeon.ru/login \
  | grep -oE '/_next/static/chunks/[^"]+\.js' | head -n 1)
curl -sSI "http://stage.teeon.ru${CHUNK_URL}" | head -n 1

# /uploads/* идёт в API
SAMPLE=$(find /sewing/apps/api/uploads -type f | head -n 1)
SAMPLE_URL="/uploads${SAMPLE#/sewing/apps/api/uploads}"
curl -sSI "http://stage.teeon.ru${SAMPLE_URL}" | head -n 1
```

Все четыре — `200 OK` (или `302` для главной).

---

## 7. Что НЕ входит в этот документ

- HTTPS / Let's Encrypt — отдельная задача (см. `deploy-stage.md`).
- Переезд storage на S3 / CDN — за рамками MVP-1 модуля «Лекала»
  (см. `docs/recon-soft-integration.md §«Uploads / files»`).
- Перевод раздачи `/uploads` на сам nginx (через `alias`) — допустимо
  как оптимизация позже, но не на этом этапе (см. §3).
- Любые изменения формата URL в БД, frontend-компонентов превью,
  Prisma-схемы, миграций — этим документом не покрываются.
