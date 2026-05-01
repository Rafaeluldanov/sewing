# ADR-0001: Монорепо со структурой apps/ + packages/ + prisma/

- Статус: принято
- Дата: 2026-04-17

## Контекст

Требуется frontend (Next.js 14 PWA) и backend (NestJS). Общая доменная
модель (типы паспорта, статусы и пр.) используется и там, и там.
Хочется единого процесса миграций и сидов Prisma.

## Решение

Используем **npm workspaces** в одном репозитории:

```
apps/web      — Next.js 14
apps/api      — NestJS
packages/shared — общие типы/Zod-схемы
prisma/       — схема и сиды (общий Prisma Client из apps/api)
```

Prisma Client генерируется в `apps/api/node_modules/.prisma/client` и
используется только бэкендом. Frontend обращается к данным через REST.

## Последствия

+ Единая версия TS, общие типы без публикации пакетов.
+ Один PR меняет и API, и UI, и миграции атомарно.
− Чуть сложнее CI (нужно знать о workspaces).
