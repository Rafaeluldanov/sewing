# scripts/ops — эксплуатационные скрипты dev/prod-хоста (teeon.ru)

Это **эталонные копии** скриптов, которые физически лежат на dev-хосте
(159.194.208.32) в `/usr/local/bin/` и `/etc/cron.d/`. Репозиторий монтирует
`nginx/conf.d` прямо в prod-nginx (`docker-compose.prod.yml`), а вот эти
скрипты — host-local, поэтому держим их копии здесь для версионирования и
ревью. Правишь тут — не забудь синхронизировать на хост (и наоборот).

## Let's Encrypt: авто-выпуск, авто-продление, мониторинг

| Файл (репо) | На хосте | Что делает |
|---|---|---|
| `sewing-cert-renew.sh` | `/usr/local/bin/` | `certbot renew` (docker, webroot) по всем `renewal/*.conf` + `nginx -t` + graceful `reload`. Cron: Пн 03:17. |
| `sewing-cert-check.sh` | `/usr/local/bin/` | Ежедневный мониторинг срока: **авто-обнаружение** всех `/etc/letsencrypt/live/*` (раньше был захардкожен только prod/dev — demo2 не мониторился). WARN при < 30 дней. Cron: 04:17. |
| `sewing-enable-demo2-dev.sh` | `/usr/local/bin/` | Turnkey-активация `https://demo2.dev.teeon.ru` — см. ниже. Cron: 04:47. |
| `cron.d-sewing-letsencrypt` | `/etc/cron.d/sewing-letsencrypt` | Расписание всех трёх задач. |

Продление доказано рабочим: `certbot renew --dry-run` → все серты `success`.

## Про demo2.dev.teeon.ru (единственный внешний блокер)

Namespace `*.dev.teeon.ru` **не имеет публичного DNS** (в Яндексе есть только
`dev.teeon.ru` и wildcard `*.teeon.ru`, но НЕ `*.dev.teeon.ru`). Поэтому
`demo2.dev.teeon.ru` снаружи = NXDOMAIN, и ни HTTP-01, ни DNS-01 cert невозможен,
пока владелец зоны не добавит A-запись:

```
*.dev   A   159.194.208.32      # wildcard, покроет все dev-тенанты (рекомендуется)
# или точечно:
demo2.dev   A   159.194.208.32
```

После этого `sewing-enable-demo2-dev.sh` (по cron или вручную) сам выпустит
доверенный cert (HTTP-01) и активирует `nginx/conf.d/25-demo2-dev-teeon.conf`
(лежит как `.disabled`, nginx его не грузит до переименования). Дальнейшее
продление — общий `sewing-cert-renew.sh`.

Для полного zero-touch wildcard-cert `*.dev.teeon.ru` (все будущие тенанты
одним сертом) нужен **PDD-токен Яндекса** для DNS-01 — его сгенерировать может
только владелец домена (панель Яндекс 360). Пока токена нет — путь выше
(per-subdomain HTTP-01) покрывает demo2.dev без токена.
