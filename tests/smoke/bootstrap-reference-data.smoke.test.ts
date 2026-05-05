/**
 * Smoke-щит для bootstrap-а системных референс-данных.
 *
 * Регресс-бекстоп для бага «помощник раскройщика не может выпустить
 * паспорт» (`docs/cutter-assistant-passport-release-recon.md`) и его
 * follow-up-а: `PassportsService.create` требует `Operation.code =
 * CUT_DIVISION`, которая в проде раньше отсутствовала, потому что
 * `prisma/seed.ts` там не запускают. Чтобы подобный кейс не вернулся
 * (и для других системных операций — `QC`/`WTO`/`PACKING`/`SEW_*`),
 * `ReferenceDataBootstrapService` поднимает их при старте Nest.
 *
 * Тесты исходник-уровневые (vitest без Prisma/БД): проверяем, что
 * модули объявлены, в `AppModule` подключены, контракт массивов не
 * сломался и единственный источник истины не разъехался.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('reference-data — единственный источник истины для bootstrap и seed', () => {
  test('apps/api/src/modules/bootstrap/reference-data.ts экспортирует REFERENCE_OPERATIONS и REFERENCE_SIZES', () => {
    const src = readSrc('apps/api/src/modules/bootstrap/reference-data.ts');
    expect(src).toMatch(
      /export const REFERENCE_OPERATIONS:\s*readonly ReferenceOperationSeed\[\]/,
    );
    expect(src).toMatch(/export const REFERENCE_SIZES:\s*readonly string\[\]/);
    // Ключевые системные операции, на которые опираются server-actions
    // и контроллеры (`PassportsService`, `QcTerminal`, `WtoTerminal`,
    // `PackingTerminal`).
    for (const code of [
      'CUT_DIVISION',
      'CUT_ISSUE',
      'SEW_OVERLOCK_1',
      'SEW_OVERLOCK_2',
      'SEW_BINDING',
      'SEW_COVERSTITCH',
      'QC',
      'WTO',
      'PACKING',
    ]) {
      expect(src).toMatch(new RegExp(`code:\\s*'${code}'`));
    }
    // Размеры покрывают и детский, и взрослый ряд.
    expect(src).toMatch(/'104'/);
    expect(src).toMatch(/'XS'/);
    expect(src).toMatch(/'6XL'/);
  });

  test('prisma/seed.ts использует ровно те же массивы и НЕ объявляет свои дубли', () => {
    const src = readSrc('prisma/seed.ts');
    expect(src).toMatch(
      /import \{[\s\S]*REFERENCE_OPERATIONS[\s\S]*REFERENCE_SIZES[\s\S]*\} from '\.\.\/apps\/api\/src\/modules\/bootstrap\/reference-data\.js'/,
    );
    // Оба алиаса присваиваются прямо из канонического массива —
    // никакой inline-копии (которая бы дрейфовала вне CI).
    expect(src).toMatch(/const SIZES: readonly string\[\] = REFERENCE_SIZES/);
    expect(src).toMatch(
      /const OPERATIONS: readonly OperationSeed\[\] = REFERENCE_OPERATIONS/,
    );
    // Старая inline-таблица операций c полями `code: 'CUT_DIVISION'`
    // не должна вернуться — иначе seed разойдётся с bootstrap-ом.
    const occurrences = src.match(/code:\s*'CUT_DIVISION'/g) ?? [];
    expect(occurrences.length).toBe(0);
  });
});

describe('ReferenceDataBootstrapService — OnApplicationBootstrap idempotent ensure', () => {
  test('сервис реализует OnApplicationBootstrap и создаёт ТОЛЬКО отсутствующие строки (никакого upsert/update)', () => {
    const src = readSrc(
      'apps/api/src/modules/bootstrap/reference-data.service.ts',
    );
    expect(src).toMatch(
      /export class ReferenceDataBootstrapService implements OnApplicationBootstrap/,
    );
    expect(src).toMatch(/async onApplicationBootstrap\(\)/);
    // Идемпотентность через createMany + skipDuplicates, а не через
    // upsert: существующие строки не перезаписываются — менеджер мог
    // изменить `name`/`pricingMode`/`fixedRate` через
    // `/admin/operations`, и это не должно сноситься перезапуском.
    expect(src).toMatch(/createMany\(/);
    expect(src).toMatch(/skipDuplicates:\s*true/);
    expect(src).not.toMatch(/\.upsert\(/);
    // Канонические массивы импортируются из единственного источника.
    expect(src).toMatch(
      /import \{[\s\S]*REFERENCE_OPERATIONS[\s\S]*REFERENCE_SIZES[\s\S]*\} from '\.\/reference-data\.js'/,
    );
    // Структурный лог события — нужен для деплой-смока (см.
    // `apps/api/scripts/docker-entrypoint.sh` ничего не логирует
    // про reference-data сам, поэтому ловим строку именно отсюда).
    expect(src).toMatch(/event=bootstrap\.reference-data\.ready/);
  });

  test('BootstrapModule подключён в AppModule', () => {
    const moduleSrc = readSrc('apps/api/src/modules/bootstrap/bootstrap.module.ts');
    expect(moduleSrc).toMatch(/export class BootstrapModule/);
    expect(moduleSrc).toMatch(/ReferenceDataBootstrapService/);

    const appSrc = readSrc('apps/api/src/app.module.ts');
    expect(appSrc).toMatch(
      /import \{ BootstrapModule \} from '\.\/modules\/bootstrap\/bootstrap\.module\.js'/,
    );
    expect(appSrc).toMatch(/^\s*BootstrapModule,\s*$/m);
  });
});

describe('PassportsService.OPERATION_NOT_FOUND перестал ссылаться на ручной seed', () => {
  test('сообщение об ошибке не предлагает запускать `npm run db:seed`', () => {
    // На корректно поднятом инстансе ветка с `OPERATION_NOT_FOUND`
    // не должна срабатывать — bootstrap гарантирует наличие
    // `CUT_DIVISION`. Сообщение направляет менеджера в
    // `/admin/operations` или к рестарту контейнера, а не на
    // CLI-команду, недоступную в проде.
    const src = readSrc('apps/api/src/modules/passports/passports.service.ts');
    expect(src).toMatch(/code: 'OPERATION_NOT_FOUND'/);
    expect(src).not.toMatch(/npm run db:seed/);
    expect(src).toMatch(/\/admin\/operations/);
  });
});
