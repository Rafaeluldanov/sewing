# Deploy / CI-CD

Документ описывает текущий способ автоматического деплоя SEWING на сервер
через docker compose. Stage-окружение по systemd — отдельный документ
`docs/deploy-stage.md`; здесь — только Docker-деплой dev/prod.

## 1. Окружения и ветки

| Окружение | Git-ветка   | Compose project | Compose-файлы                                  | Env-file   | Хост-порты         |
|-----------|-------------|-----------------|------------------------------------------------|------------|--------------------|
| **dev**   | `develop`   | `sewing`        | `docker-compose.base.yml` + `docker-compose.dev.yml`  | `.env.dev` | web `:3000`, api `:3001` |
| **prod**  | `main`      | `sewing-prod`   | `docker-compose.base.yml` + `docker-compose.prod.yml` | `.env.prod` | web `:80`, api `:8081` |

Окружения **физически изолированы** на хосте:

- разные Compose project name → разные контейнеры (`sewing-api-1` vs `sewing-prod-api-1`),
- разные сети (`sewing_app-network` vs `sewing_prod-network`),
- разные тома БД (`sewing_db_data` vs `sewing_prod_db_data`),
- разные хост‑порты.

Поэтому dev и prod можно держать запущенными одновременно на одной машине.

## 2. Скрипты

Оба скрипта лежат в `scripts/` и идемпотентны (повторный запуск ничего не ломает):

- `scripts/deploy-dev.sh` — деплой DEV (ветка `develop`).
- `scripts/deploy-prod.sh` — деплой PROD (ветка `main`).

Обе процедуры одинаковы по шагам, отличаются только названием ветки,
project name, env-file и compose‑файлами:

1. `set -euo pipefail` (любая ошибка → `exit 1`, неинициализированные
   переменные → `exit 1`, упавшая команда в pipeline → `exit 1`).
2. `cd /root/sewing` (можно переопределить переменной `REPO_ROOT`).
3. `git fetch --prune origin`.
4. Если текущая ветка ≠ целевой — `git checkout <branch>`.
5. `git pull --ff-only origin <branch>` — если history разъехался,
   деплой падает (намеренно: ребейс/мердж — ручная операция оператора).
6. Печать `git rev-parse --short HEAD` + subject коммита.
7. `docker compose -p <project> -f base -f dev|prod --env-file .env.* build`.
8. `docker compose ... up -d --remove-orphans`.
9. `docker compose ... exec -T api npx prisma migrate deploy --schema=prisma/schema.prisma`
   (см. §«Migrations» — упавший шаг не валит деплой, потому что
   PRISMA_AUTO_SYNC entrypoint API уже синхронизировал схему).
10. `docker compose ... ps` (статус контейнеров).
11. Печать последних 30 строк `logs api` и `logs web` (best-effort,
    `|| true`, не валит деплой).
12. **Healthcheck** `GET <API_HEALTH_URL>`: успехом считается **HTTP 200
    или 401** (401 на `/api/auth/me` без cookie — ожидаемое поведение,
    означает, что AuthGuard живой). 30 попыток × 2 секунды, потом
    `exit 1`.

## 3. Запуск вручную

```bash
# DEV (ветка develop, project sewing, .env.dev)
sudo bash /root/sewing/scripts/deploy-dev.sh

# PROD (ветка main, project sewing-prod, .env.prod)
sudo bash /root/sewing/scripts/deploy-prod.sh
```

Опциональные параметры через env (полезны для CI):

| Переменная           | Default (dev)                      | Default (prod)                      | Назначение                                              |
|----------------------|------------------------------------|-------------------------------------|---------------------------------------------------------|
| `REPO_ROOT`          | `/root/sewing`                     | `/root/sewing`                      | Корень репозитория на сервере                           |
| `DEPLOY_BRANCH`      | `develop`                          | `main`                              | Какая ветка деплоится                                   |
| `COMPOSE_PROJECT`    | `sewing`                           | `sewing-prod`                       | Compose project name                                    |
| `ENV_FILE`           | `.env.dev`                         | `.env.prod`                         | Файл с переменными окружения                            |
| `API_HEALTH_URL`     | `http://127.0.0.1:3001/api/auth/me`| `http://127.0.0.1:8081/api/auth/me` | Эндпоинт healthcheck                                    |
| `HEALTH_ATTEMPTS`    | `30`                               | `30`                                | Сколько раз пробовать `curl`                            |
| `HEALTH_DELAY_S`     | `2`                                | `2`                                 | Пауза между попытками healthcheck                       |
| `SKIP_MIGRATIONS`    | `0`                                | `0`                                 | `=1` — пропустить шаг `prisma migrate deploy`           |

Например, точечно задеплоить prod без `migrate deploy`:

```bash
SKIP_MIGRATIONS=1 sudo bash /root/sewing/scripts/deploy-prod.sh
```

## 4. CI/CD через GitHub Actions

Реальный workflow живёт в `.github/workflows/deploy.yml`. Триггеры:

- `push` в `develop` → деплой dev;
- `push` в `main` → деплой prod;
- ручной запуск через **Actions → Deploy → Run workflow**
  (`workflow_dispatch`) с выбором target = `auto | dev | prod`.

Пайплайн состоит из трёх job-ов:

| Job          | Когда                                              | Что делает                                                                 |
|--------------|----------------------------------------------------|----------------------------------------------------------------------------|
| `ci`         | всегда                                             | `npm ci` → `npm run build --workspace=@sewing/api` → `--workspace=@sewing/web` (на ubuntu-runner-е) |
| `deploy-dev` | `needs: ci`, ветка `develop` (или manual `dev`)    | SSH на сервер + `bash /root/sewing/scripts/deploy-dev.sh`                  |
| `deploy-prod`| `needs: ci`, ветка `main` (или manual `prod`)      | SSH на сервер + `bash /root/sewing/scripts/deploy-prod.sh`                 |

Логика деплоя (git pull, docker compose, prisma, healthcheck) живёт в
скриптах на сервере — workflow её **не дублирует**.

`concurrency: group: deploy-${{ github.ref }}` + `cancel-in-progress: false`
гарантируют, что два деплоя одной ветки **никогда** не выполняются
параллельно — хвостовой push ждёт, пока завершится текущий.

### 4.1. GitHub Secrets (Settings → Secrets and variables → Actions)

Workflow читает только **именованные secrets**, никаких хардкод-значений
в репо. Минимально нужны три:

| Secret           | Назначение                                                               | Где взять                                                |
|------------------|--------------------------------------------------------------------------|----------------------------------------------------------|
| `SERVER_HOST`    | IP или DNS-имя сервера деплоя (один на dev и prod — оба стека на одной машине). | `curl -s https://api.ipify.org` на сервере.              |
| `SERVER_USER`    | SSH-пользователь (например, `deploy` или `root`).                        | Тот, кто имеет права на `sudo bash /root/sewing/scripts/deploy-*.sh`. |
| `SERVER_SSH_KEY` | Приватный SSH-ключ в формате OpenSSH/PEM, **без passphrase**.            | `ssh-keygen -t ed25519 -f deploy_key -N ""`, паблик в `~/.ssh/authorized_keys` пользователя на сервере. |

Опциональный secret:

| Secret             | Default | Когда нужен                                            |
|--------------------|---------|--------------------------------------------------------|
| `SERVER_SSH_PORT`  | `22`    | Если SSH слушает на нестандартном порту.               |

> Важно: в `SERVER_SSH_KEY` кладётся **именно приватный ключ** (вся
> строка от `-----BEGIN OPENSSH PRIVATE KEY-----` до
> `-----END OPENSSH PRIVATE KEY-----` включительно). Соответствующий
> публичный ключ должен быть прописан на сервере в файле
> `~SERVER_USER/.ssh/authorized_keys`.

### 4.2. GitHub Environments (manual approval)

Job `deploy-prod` помечен `environment: production`. Это включает
интеграцию с GitHub Environments:

1. Settings → **Environments** → **New environment** → `production`.
2. (Опционально) **Required reviewers** — список тех, кто должен
   нажать **Approve** до того, как job стартует. Без этого pipeline
   подвиснет в статусе «Waiting for review».
3. (Опционально) **Wait timer** — задержка перед стартом (минуты).
4. (Опционально) **Deployment branches** — ограничить, с каких веток
   разрешён деплой в окружение (фактически защита «деплой только из main»).

Job `deploy-dev` помечен `environment: development` — его тоже можно
гейтить approval-ом, но обычно для dev этого не делают.

> Если environment в Settings ещё не создан — workflow всё равно
> пройдёт; gating будет неактивен. Создание environment не ломает
> репо/PR-ы, его можно добавить в любой момент.

### 4.3. Ручной запуск workflow

В UI:

1. **Actions** → выбрать workflow **Deploy** в левой колонке.
2. Кнопка **Run workflow** справа.
3. Выбрать ветку (`develop` или `main`) и параметр **target**:
   - `auto` — сам решит по ветке (`develop`→dev, `main`→prod);
   - `dev` — принудительно деплой dev (можно с любой ветки, для hotfix);
   - `prod` — принудительно деплой prod.

Через `gh` CLI:

```bash
# DEV из ветки develop
gh workflow run Deploy --ref develop -f target=auto

# PROD из ветки main
gh workflow run Deploy --ref main -f target=auto

# Аварийный деплой dev из feature-ветки
gh workflow run Deploy --ref feature/foo -f target=dev
```

### 4.4. Логи и наблюдение

После запуска:

- **Actions → Deploy → текущий run** — логи каждого шага в UI.
- В job-е SSH полностью видны:
  - вывод `git pull --ff-only`,
  - `docker compose build` / `up -d`,
  - `prisma migrate deploy` (или WARN с fallback),
  - `docker compose ps`,
  - последние 30 строк логов api/web,
  - результат healthcheck.

Через CLI:

```bash
# последние 5 запусков workflow
gh run list --workflow=Deploy --limit 5

# логи последнего run
gh run view --log

# логи конкретного run
gh run view <RUN_ID> --log
```

На сервере смотреть напрямую:

```bash
# DEV
docker compose -p sewing      -f docker-compose.base.yml -f docker-compose.dev.yml  --env-file .env.dev  logs --tail=200 api
docker compose -p sewing      -f docker-compose.base.yml -f docker-compose.dev.yml  --env-file .env.dev  logs -f api

# PROD
docker compose -p sewing-prod -f docker-compose.base.yml -f docker-compose.prod.yml --env-file .env.prod logs --tail=200 api
docker compose -p sewing-prod -f docker-compose.base.yml -f docker-compose.prod.yml --env-file .env.prod logs -f api
```

### 4.5. Что важно НЕ делать

- НЕ хранить реальные IP/ключи/пароли в репозитории. Всё, что чувствительно
  — только в **GitHub Secrets** или в `.env.dev`/`.env.prod` на сервере.
- НЕ давать deploy-пользователю shell-доступ без `~/.ssh/authorized_keys`
  с ограничением `command="bash /root/sewing/scripts/deploy-*.sh"` —
  по best practice. (Можно сделать на следующем шаге, выходит за
  рамки текущей задачи.)
- НЕ запускать workflow с `cancel-in-progress: true` для prod —
  оборванный посередине миграции деплой может оставить БД в
  непредсказуемом состоянии.

## 5. Migrations

Каноническая команда — `prisma migrate deploy`. Она применяет
`prisma/migrations/*` в порядке имён и помечает их в служебной таблице
`_prisma_migrations`.

Однако в текущем состоянии проекта несколько ранних миграций ссылаются
на индексы, которые создаются динамически в коде
(`apps/api/src/prisma/prisma.service.ts`). На свежей prod-БД это
ломает порядок применения. Поэтому:

- Контейнер api **при старте** запускает entrypoint
  `apps/api/scripts/docker-entrypoint.sh`, который при `PRISMA_AUTO_SYNC=1`
  выполняет `prisma db push --skip-generate`. Это гарантирует, что
  БД соответствует `schema.prisma` ещё до того, как Nest откроет порт.
- Шаг `prisma migrate deploy` в deploy-скрипте оставлен «как есть»,
  но **упавший шаг не валит деплой** (только WARN в stderr). Когда
  миграционная история будет починена — он начнёт реально применять
  миграции, а warn-fallback окажется недостижимым.

Управление авто‑синхронизацией:

```env
# .env.prod
PRISMA_AUTO_SYNC=1                  # 0 — выключить
PRISMA_AUTO_SYNC_RETRIES=15
PRISMA_AUTO_SYNC_ACCEPT_DATA_LOSS=0 # 1 — разрешить деструктивные изменения
```

Подробнее — `apps/api/scripts/docker-entrypoint.sh`, `.env.example`.

## 6. Логи

Скрипты сами печатают последние 30 строк api/web. Полные логи в реальном
времени:

```bash
# DEV
docker compose -p sewing -f docker-compose.base.yml -f docker-compose.dev.yml \
  --env-file .env.dev logs -f api
docker compose -p sewing -f docker-compose.base.yml -f docker-compose.dev.yml \
  --env-file .env.dev logs -f web

# PROD
docker compose -p sewing-prod -f docker-compose.base.yml -f docker-compose.prod.yml \
  --env-file .env.prod logs -f api
docker compose -p sewing-prod -f docker-compose.base.yml -f docker-compose.prod.yml \
  --env-file .env.prod logs -f web
```

Контейнеры также видны через `docker ps`:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

## 7. Откат на предыдущий commit

Откат — ручная операция (намеренно). Алгоритм:

1. Найти нужный commit:

   ```bash
   cd /root/sewing
   git log --oneline -n 20 origin/main      # для prod
   git log --oneline -n 20 origin/develop   # для dev
   ```

2. Подготовить локальную ветку к нужному commit (без push в origin —
   историю в remote мы не трогаем):

   ```bash
   git fetch origin
   git checkout main                        # или develop для dev
   git reset --hard <SHA>
   ```

   (`reset --hard` — потому что deploy-скрипт делает `git pull --ff-only`,
   а у нас локально HEAD должен указывать ровно на нужный коммит.)

3. Запустить деплой того же окружения как обычно — он:

   - сделает `git fetch` (ничего не сломает: origin не трогали),
   - попробует `git pull --ff-only origin <branch>` — **упадёт**,
     потому что локальный HEAD теперь позади origin.

   Чтобы это обойти, временно поднимаем флаг `SKIP_MIGRATIONS=1`
   (опционально) и пропускаем git‑шаг ручным деплоем:

   ```bash
   cd /root/sewing
   docker compose -p sewing-prod \
     -f docker-compose.base.yml -f docker-compose.prod.yml \
     --env-file .env.prod up -d --build --remove-orphans
   ```

   Это пересоберёт образы из текущего locked HEAD и поднимет prod на
   нужный commit, **не трогая БД и тома**.

4. Проверить healthcheck вручную:

   ```bash
   curl -i http://127.0.0.1:8081/api/auth/me   # ждём 200 или 401
   curl -i http://127.0.0.1/login              # ждём 200/3xx
   ```

5. Когда нужный commit стабилизировали в `main`/`develop` — снова
   запустить штатный `deploy-prod.sh` / `deploy-dev.sh`; они подхватят
   ту же ветку и будут идемпотентны.

> **БД при откате не откатывается автоматически.** Если новый код
> требует уже применённой схемы, после `reset --hard` назад API может
> подняться поверх «слишком новой» схемы. Это, как правило, не ломает
> чтение/запись существующих таблиц, но требует понимания диффа.
> Снапшот БД делается отдельно — см. `scripts/backup-db.sh`.

## 8. Что точно не делать

- НЕ запускать `git pull` без `--ff-only` на сервере — получится
  merge-commit «с неба», который потом не воспроизводится локально.
- НЕ держать `.env.dev` / `.env.prod` в git. На сервере они должны
  быть отдельно, с правами `600`.
- НЕ менять `COMPOSE_PROJECT` на ходу — потеряете доступ к существующим
  томам/контейнерам (compose «не увидит» их, и `up -d` создаст новые).
- НЕ запускать `docker compose down -v` — это снесёт volume с БД.
  Откат не требует и не должен затрагивать данные.
