# Ops runbook (`stage.teeon.ru`)

Runbook оператора для stage. Покрывает только инфраструктурный слой:
systemd, deploy, backup, restore, healthcheck, ручной rollback. Бизнес-логику
и nginx документ не трогает (nginx — см. `docs/deploy-stage.md §2`).

---

## 1. Systemd services

Два юнита держат приложение:

| Unit             | Порт  | ExecStart                                                    |
|------------------|-------|--------------------------------------------------------------|
| `sewing-api`     | 3001  | `/usr/bin/node /sewing/apps/api/dist/main.js`                |
| `sewing-web`     | 3000  | `/sewing/node_modules/.bin/next start apps/web -p 3000`      |

Источники в репо: `deploy/systemd/sewing-api.service`,
`deploy/systemd/sewing-web.service`. Установка/обновление — только через
`scripts/install-systemd.sh` (он же `daemon-reload` + `enable` + `restart`):

```bash
sudo bash /sewing/scripts/install-systemd.sh
```

Скрипт идемпотентен — если содержимое юнита не изменилось, копирование
пропускается, но `enable`/`restart` всё равно выполняются.

Оба юнита:

- `Restart=always`, `RestartSec=5` — автохилинг при крэше / OOM;
- `EnvironmentFile=/sewing/.env` — единый источник env (порты, JWT, БД);
- `Environment=NODE_ENV=production`;
- `StartLimitIntervalSec=0` — systemd не «сдаётся» после серии рестартов;
- логи в journald (`SyslogIdentifier=sewing-api` / `sewing-web`);
- `KillSignal=SIGTERM`, `TimeoutStopSec=20` — graceful shutdown
  (Nest успевает закрыть Prisma pool, Next — flush in-flight responses);
- `User=root` — пока так, см. follow-up §8.

Рутинные команды:

```bash
sudo systemctl status sewing-api
sudo systemctl status sewing-web

sudo systemctl restart sewing-api
sudo systemctl restart sewing-web

sudo journalctl -u sewing-api -n 200 -f
sudo journalctl -u sewing-web -n 200 -f
```

---

## 2. Deploy stage

Полный repeatable деплой — единственная корректная процедура для stage:

```bash
sudo bash /sewing/scripts/deploy-stage.sh
```

Шаги (всё внутри `set -euo pipefail`, любая ошибка → `exit 1`):

1. sanity: юниты установлены;
2. **pre-deploy backup БД** (`scripts/backup-db.sh`);
3. `npm ci` (если есть `package-lock.json`) или `npm install`;
4. `npm run typecheck`;
5. `npm run build` (workspaces: api + web);
6. `npx prisma migrate deploy` — применяет pending-миграции;
7. `bash scripts/cleanup-legacy-processes.sh` — глушит юниты и
   зачищает порты 3000/3001 от любых сторонних держателей
   (см. §2a);
8. `systemctl start sewing-api` + `systemctl start sewing-web`;
9. healthcheck до 30s × 1s:
   - `curl -fsS  http://127.0.0.1:3001/api/health`
   - `curl -fsSI http://127.0.0.1:3000`
10. печать `is-active` обоих юнитов и `journalctl -n 80`.

> Stage-deploy **не zero-downtime**: между шагами 7 и 8 оба сервиса
> лежат ~1–2 секунды (cleanup → start). Для stage это допустимо;
> zero-downtime — отдельная задача, см. §8.

Через npm shortcut:

```bash
sudo npm run deploy:stage
```

Что делать **нельзя** (вернётся ручной хаос с потерянными процессами):

- `fuser -k 3000/tcp` / `fuser -k 3001/tcp` руками **в обход** скрипта —
  мы больше не управляем процессами по портам, ими владеет systemd.
  `fuser -k` убьёт сервис, а systemd через 5 секунд поднимет его
  заново — с гонкой и пустыми логами. Нужен ли cleanup — решает
  `cleanup-legacy-processes.sh` (см. §2a), он сначала глушит юнит и
  только потом снимает порт;
- `nohup node apps/api/dist/main.js &` — параллельный процесс отнимет
  порт у systemd-овского, тот зациклится в рестартах;
- редактировать юнит руками в `/etc/systemd/system/` — изменения уйдут
  при следующем `install-systemd.sh`. Менять только в репо.

---

## 2a. Legacy process cleanup

Скрипт: `scripts/cleanup-legacy-processes.sh`. Также доступен как
`npm run cleanup:legacy`.

```bash
sudo bash /sewing/scripts/cleanup-legacy-processes.sh
sudo systemctl start sewing-api sewing-web
```

Что делает (идемпотентно, в этом порядке):

1. `systemctl stop sewing-api sewing-web` — иначе systemd воскресит
   процесс через `RestartSec=5` сразу после `fuser -k`;
2. `fuser -k 3000/tcp` и `fuser -k 3001/tcp` — снимает любых
   держателей именно этих портов;
3. узкие `pkill -f "apps/api/dist/main.js"` и
   `pkill -f "next start apps/web"` — добивает осиротевшие nohup-ы,
   которые могли уже отпустить порт, но висеть процессом;
4. `sleep 1` + `ss -ltnp | grep ':3000|:3001'` — печатает, свободны
   ли порты. Если занят — выводит, кем (PID/имя процесса).

**Сервисы скрипт сам не стартует** — это ответственность
`install-systemd.sh` или `deploy-stage.sh` (иначе stop/start ordering
размазывается между двумя скриптами).

Когда запускать вручную:

- **разово** при первом переходе с `nohup`-флоу на systemd: в
  `journalctl -u sewing-api` / `-u sewing-web` видны строки
  `EADDRINUSE` или `Error: listen EADDRINUSE :::3001`, а юнит
  висит в `activating` / постоянно перезапускается;
- если кто-то по ошибке поднял `node apps/api/dist/main.js` или
  `next start apps/web` мимо systemd, и port:owner снова разъехался.

В обычном `deploy-stage.sh` cleanup уже встроен (шаг 7) — отдельно
вызывать не нужно. После cleanup приложение **не** держит порты до
тех пор, пока их явно не поднимут через `systemctl start sewing-*`.

Что cleanup **не** трогает:

- postgres (порт 5432), nginx (80/443) — они слушают другие порты,
  `fuser -k 3000/tcp` / `3001/tcp` их не зацепит;
- произвольные `node`-процессы (`prisma`, `tsx`, `npm`-сабпроцессы,
  CI-runner) — `pkill` ходит только по узким паттернам
  `apps/api/dist/main.js` и `next start apps/web`, не по `node`.

---

## 3. Backup

Скрипт: `scripts/backup-db.sh`. Также доступен как `npm run backup:db`.

```bash
sudo bash /sewing/scripts/backup-db.sh
# или:
sudo npm run backup:db
```

Ключевые свойства:

- читает `DATABASE_URL` из `/sewing/.env` и парсит его в Node (URL API),
  потому что `?schema=public` в строке — Prisma-расширение, libpq его
  не понимает (`pg_dump "$DATABASE_URL"` падает на этом параметре);
- альтернатива: можно явно выставить `PGHOST/PGPORT/PGDATABASE/PGUSER/
  PGPASSWORD` — тогда `.env` не читается (полезно из cron / CI);
- формат дампа: `pg_dump --format=custom --no-owner --no-acl`
  (бинарный, переносимый между разными БД-ролями);
- путь: `/var/backups/sewing/sewing_YYYYMMDD_HHMMSS.dump`
  (переопределяется `BACKUP_DIR=...`);
- ротация: храним `KEEP=14` свежих файлов, остальные удаляются;
- atomic write: сначала `*.dump.partial`, потом `mv` — ротация не
  увидит полу-записанный файл;
- последняя строка stdout — путь созданного файла (deploy-stage.sh
  захватывает его через `tail -n 1`).

Cron-пример (опционально, не входит в задачу):

```cron
15 3 * * *  root  /sewing/scripts/backup-db.sh >>/var/log/sewing-backup.log 2>&1
```

---

## 4. Restore backup

> **Внимание.** Restore затирает текущую БД (`--clean --if-exists`).
> Перед запуском **обязательно**:
>
> 1. остановить оба сервиса, чтобы коннекты Prisma не мешали `DROP`;
> 2. сделать свежий backup текущей БД на случай, если файл, из которого
>    разворачиваем, окажется битым / устаревшим.

Полная процедура:

```bash
# 0. свежий backup поверх текущей БД (HARD requirement)
sudo bash /sewing/scripts/backup-db.sh

# 1. погасить сервисы
sudo systemctl stop sewing-web sewing-api

# 2. восстановить (заменить путь на нужный файл)
#    PG* можно подсунуть так же, как делает backup-db.sh, либо вручную:
sudo -u postgres pg_restore \
  --dbname=sewing \
  --clean --if-exists \
  --no-owner --no-acl \
  /var/backups/sewing/sewing_20260424_030015.dump

# 3. поднять сервисы
sudo systemctl start sewing-api sewing-web

# 4. healthcheck (см. §5)
```

Если restore идёт не от `postgres`-роли, а через прикладного юзера —
пробросить PG* env и звать `pg_restore` без `sudo -u postgres`:

```bash
export PGHOST=localhost PGPORT=5432 PGUSER=sewing \
       PGPASSWORD=sewing PGDATABASE=sewing
pg_restore --clean --if-exists --no-owner --no-acl \
  /var/backups/sewing/sewing_20260424_030015.dump
```

---

## 5. Healthcheck

Минимальный набор проверок, которыми пользуется и `deploy-stage.sh`:

```bash
# API: NestJS живой и слушает
curl -fsS  http://127.0.0.1:3001/api/health
# {"status":"ok","time":"..."}

# API: БД отвечает (readiness)
curl -fsS  http://127.0.0.1:3001/api/ready
# {"status":"ready",...}  или  {"status":"not-ready","reason":"database",...}

# WEB: Next.js отдаёт страницу
curl -fsSI http://127.0.0.1:3000
# HTTP/1.1 200 OK или 307 на /login

# Снаружи (через nginx) — см. docs/deploy-stage.md §5
curl -fsSI http://stage.teeon.ru
```

Что значит, если падает только один из них:

| Падает                              | Почти наверняка                                     |
|-------------------------------------|-----------------------------------------------------|
| `/api/health`                       | API не стартанул → `journalctl -u sewing-api`       |
| `/api/health` ok, `/api/ready` нет  | Postgres не отвечает / роль / `DATABASE_URL`        |
| WEB head                            | `next start` упал → `journalctl -u sewing-web`      |
| 127.0.0.1 ok, домен нет             | nginx / DNS — это не про этот документ              |

---

## 6. Manual rollback

Автоматический rollback в этой задаче **сознательно не делается**
(см. follow-up §8). Ручная процедура — на случай, когда новый билд
поднялся, но в проде ведёт себя плохо:

```bash
# 1. зафиксировать текущее состояние БД (на случай, если потом
#    придётся откатываться обратно вперёд)
sudo bash /sewing/scripts/backup-db.sh

# 2. откатить код (пример: на предыдущий тег / коммит)
cd /sewing
sudo git fetch --tags
sudo git checkout <previous_tag_or_sha>

# 3. пересобрать и перезапустить — стандартный deploy-flow
sudo bash /sewing/scripts/deploy-stage.sh
```

Если откат связан с поломкой схемы БД (миграция съела данные) —
дополнительно перед `deploy-stage.sh` восстановить дамп:

```bash
sudo systemctl stop sewing-web sewing-api
sudo -u postgres pg_restore --dbname=sewing --clean --if-exists \
  --no-owner --no-acl /var/backups/sewing/<pre_deploy>.dump
sudo systemctl start sewing-api sewing-web
```

> Если pre-deploy backup был сделан `deploy-stage.sh`, его путь видно
> в выводе деплоя (последняя строка `DEPLOY OK — backup: ...`) и в
> `/var/backups/sewing/`.

---

## 7. Полезные команды

```bash
# Быстрый статус
systemctl is-active sewing-api sewing-web

# Логи в реальном времени
sudo journalctl -u sewing-api -u sewing-web -n 200 -f

# Кто реально сидит на портах
ss -ltnp | grep -E ':3000|:3001'

# Проверить, что юниты соответствуют репо
diff /etc/systemd/system/sewing-api.service /sewing/deploy/systemd/sewing-api.service
diff /etc/systemd/system/sewing-web.service /sewing/deploy/systemd/sewing-web.service
```

---

## 8. Diagnostics

Read-only «отчёт по невозможным состояниям БД». Цель — **заранее**
видеть рассинхронизацию (паспорт IN_PROGRESS без сотрудника, две
активные смены на одного человека, отрицательное количество в
ячейке, …) до того, как она выстрелит в зарплате/упаковке/отчётах.

### Контракт

- endpoint: `GET /api/admin/diagnostics/consistency`;
- доступ: `ADMIN`, `SHOP_MANAGER` (`@Roles('ADMIN','SHOP_MANAGER')`
  на контроллере + ту же матрицу проверяет
  `app/admin/layout.tsx`);
- UI: `/admin/diagnostics` (карточка «Диагностика данных» на
  главной у менеджера/админа);
- ответ — `DiagnosticConsistencyReportDto` из `@sewing/shared`:
  `generatedAt`, `summary { total, critical, warning }`, `issues[]`;
- inline-документация всех проверок и их severity — в
  `apps/api/src/modules/diagnostics/diagnostics.service.ts`.

### Severity

- **CRITICAL** — состояние, которое не должно возникать никогда и
  ломает либо бизнес-смысл (упакованный паспорт всё ещё «у
  сотрудника»), либо учёт денег (отрицательное количество в ячейке,
  две активные смены у одного человека). Разбирать **в первую
  очередь**, до того как менеджер возьмётся за остальные задачи.
- **WARNING** — состояние, которое формально не запрещено, но
  обычно сигнализирует о ручной правке БД или о потере шага в
  pipeline (например, отменённый паспорт всё ещё закреплён за
  ячейкой). Разбирать в течение рабочего дня.

### Что делать при CRITICAL

1. Открыть `/admin/diagnostics` и нажать «Обновить» — убедиться,
   что находка не «успела залечиться» сама (например, после закрытия
   смены).
2. Развернуть `Context` нужной строки — там минимально полезный
   срез (ids, qty, статусы), которого хватает, чтобы открыть карточку
   паспорта/заказа/смены.
3. Найти источник правки (обычно — это либо ручной SQL, либо баг в
   только что задеплоенном flow) и **починить руками**, не через
   сам отчёт. У отчёта **нет** auto-fix endpoints — он сознательно
   read-only (см. `apps/api/src/modules/diagnostics/diagnostics.module.ts`).
4. Если та же находка повторяется — завести follow-up в `docs/ops.md
   §«Follow-ups»` с примером и кодом проверки, чтобы починили
   pipeline, а не симптом.

### Что делать при WARNING

- Допустимо отложить: WARNING ничего не ломает в моменте.
- Перед следующей сменой/перед закрытием отчётного периода
  убедиться, что список не растёт лавинообразно — это может быть
  ранний сигнал бага в новом flow.
- Не закрывать молча: каждая warning-находка должна получить либо
  объяснение (`пометить «знаем, ждём X»` в журнале операций), либо
  ручную правку.

### Чего отчёт сознательно НЕ делает

- не правит данные автоматически (`no auto-fix`);
- не вызывает cron / алёрты / нотификации — на MVP это явный
  ручной обход;
- не меняет state-machine паспорта/заказа/смены;
- не делает тяжёлых join-ов без индексов: каждая проверка
  ограничена `LIMIT_PER_CHECK = 200`.

---

## 9. Follow-ups (вне scope текущей задачи)

- перевести оба юнита с `User=root` на отдельного `sewing` системного
  юзера (потребует chown на `/sewing` и на `STORAGE_DIR`, отдельный
  `~/.pgpass` и review nginx alias на `/sewing/apps/web/.next/static/`);
- automation rollback (хранить N последних `dist` + `.next` снапшотов,
  переключать через симлинк) — сейчас откат ручной (`git checkout` +
  `deploy-stage.sh`);
- HTTPS (Let's Encrypt) — отдельная задача после §5 в `deploy-stage.md`;
- вынести cron для `backup-db.sh` (например, ежедневно в 03:15);
- вынести `deploy-stage.sh` под GitHub Actions / CI с self-hosted runner.
