/**
 * Бэкфилл сдельных начислений за `WTO_PASSED`-события, у которых
 * нет `OperationEntry`.
 *
 * Контекст. До коммита `c7782ed vto price` (28.05.2026) ВТО-операция
 * писала только `PassportEvent(WTO_PASSED)`, без вызова
 * `EarningsService.createPendingForCompletedOperation`. После выкатки
 * новые завершения создают `OperationEntry` штатно, но исторические
 * 500+ событий остались без начислений — у ВТО-сотрудника в кабинете
 * (/wto, чип «Мой день») и в `/api/me/history` стоят нули.
 *
 * Скрипт идёт по всем `WTO_PASSED` без attached `OperationEntry`
 * (через `sourceEventId`) и создаёт недостающие записи:
 *
 *   - `qty`         = `PassportEvent.qty` (он же `Passport.qtyGood` для
 *                      ВТО, см. wto.service.ts);
 *   - `ratePerUnit` = ставка операции (resolveRate: `FIXED.fixedRate`
 *                      или `BY_SIZE` через `OperationRateBySize` по
 *                      `Passport.sizeId`);
 *   - `amount`      = round2(rate × qty);
 *   - `status`      = APPROVED (паспорта в проде уже PACKED, второго
 *                      `approvePendingForPassport` не случится);
 *   - `createdAt`   = `PassportEvent.createdAt` (исторический день,
 *                      чтобы попало в правильный bucket `/api/me/history`);
 *   - `approvedAt`  = `PassportEvent.createdAt`;
 *   - `sourceEventId` = `PassportEvent.id` (для трассировки).
 *
 * Идемпотентность — на уникальный ключ
 * `(passportId, operationId, employeeId, sourceEventType)`. Повторный
 * запуск ловит `P2002` и пропускает.
 *
 * Запуск:
 *   - Сухой прогон (по умолчанию):
 *       npx tsx scripts/backfill-wto-earnings.ts
 *   - Применить изменения:
 *       npx tsx scripts/backfill-wto-earnings.ts --apply
 *   - Ограничить одним сотрудником (по id):
 *       npx tsx scripts/backfill-wto-earnings.ts --employee=<id>
 *   - В контейнере прод-api (чтобы взять прод-DATABASE_URL):
 *       docker exec -it sewing-prod-api-1 npx tsx /app/scripts/backfill-wto-earnings.ts --apply
 *
 * После применения сотрудник видит дневные суммы в чипе «Мой день»
 * (за исторические дни) и в `/api/me/history`. Аналогичный скрипт для
 * `QC_PASSED` можно сделать копированием — на 28.05.2026 пропусков по
 * ОТК нет.
 */

import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Args {
  apply: boolean;
  employeeId: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, employeeId: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--employee=')) {
      args.employeeId = arg.slice('--employee='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: tsx scripts/backfill-wto-earnings.ts [--apply] [--employee=<id>]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

interface RateCache {
  fixed: Map<string, Prisma.Decimal>;
  bySize: Map<string, Prisma.Decimal>;
  modes: Map<string, string>;
}

async function buildRateCache(operationIds: string[]): Promise<RateCache> {
  const cache: RateCache = {
    fixed: new Map(),
    bySize: new Map(),
    modes: new Map(),
  };
  if (operationIds.length === 0) return cache;
  const ops = await prisma.operation.findMany({
    where: { id: { in: operationIds } },
    select: { id: true, pricingMode: true, fixedRate: true },
  });
  for (const op of ops) {
    cache.modes.set(op.id, op.pricingMode);
    if (op.pricingMode === 'FIXED' && op.fixedRate) {
      cache.fixed.set(op.id, op.fixedRate);
    }
  }
  // BY_SIZE: одной выборкой
  const bySize = await prisma.operationRateBySize.findMany({
    where: { operationId: { in: operationIds } },
    select: { operationId: true, sizeId: true, rate: true },
  });
  for (const r of bySize) {
    cache.bySize.set(`${r.operationId}::${r.sizeId}`, r.rate);
  }
  return cache;
}

function resolveRate(
  cache: RateCache,
  operationId: string,
  sizeId: string,
): Prisma.Decimal | null {
  const mode = cache.modes.get(operationId);
  if (mode === 'FIXED') return cache.fixed.get(operationId) ?? null;
  if (mode === 'BY_SIZE') {
    return cache.bySize.get(`${operationId}::${sizeId}`) ?? null;
  }
  // SALARY_ONLY / неизвестный — пропускаем, как штатный earnings-сервис.
  return null;
}

function round2(d: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(d.toFixed(2));
}

interface Skip {
  reason:
    | 'no_rate'
    | 'salary_only'
    | 'inactive_employee'
    | 'inactive_or_missing_employee'
    | 'zero_qty';
  count: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log(
    `[backfill-wto] mode=${args.apply ? 'APPLY' : 'DRY-RUN'}${
      args.employeeId ? ` employee=${args.employeeId}` : ''
    }`,
  );

  // 1) Все WTO_PASSED события для целевого сотрудника (или всех).
  //    Отсеиваем те, у которых уже есть `OperationEntry` (по
  //    `sourceEventId`). В Prisma нет обратной relation у PassportEvent
  //    на OperationEntry, поэтому делаем два запроса и фильтруем
  //    клиентом — это всё ещё O(N), но без джойнов.
  const allEvents = await prisma.passportEvent.findMany({
    where: {
      type: 'WTO_PASSED',
      employeeId: args.employeeId ?? undefined,
    },
    select: {
      id: true,
      passportId: true,
      operationId: true,
      employeeId: true,
      qty: true,
      createdAt: true,
      passport: { select: { sizeId: true, qtyGood: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const eventIds = allEvents.map((e) => e.id);
  const alreadyDone = await prisma.operationEntry.findMany({
    where: { sourceEventId: { in: eventIds } },
    select: { sourceEventId: true },
  });
  const doneSet = new Set(
    alreadyDone
      .map((r) => r.sourceEventId)
      .filter((x): x is string => x !== null),
  );
  const events = allEvents.filter((e) => !doneSet.has(e.id));

  console.log(`[backfill-wto] кандидатов на бэкфилл: ${events.length}`);
  if (events.length === 0) {
    await prisma.$disconnect();
    return;
  }

  // 2) Подтянем ставки операций и активность сотрудников разово.
  const opIds = Array.from(
    new Set(events.map((e) => e.operationId).filter((x): x is string => !!x)),
  );
  const empIds = Array.from(
    new Set(events.map((e) => e.employeeId).filter((x): x is string => !!x)),
  );
  const [rates, employees] = await Promise.all([
    buildRateCache(opIds),
    prisma.employee.findMany({
      where: { id: { in: empIds } },
      select: { id: true, compensationType: true, active: true },
    }),
  ]);
  const empMap = new Map(employees.map((e) => [e.id, e]));

  // 3) Подготовим план: посчитаем что и сколько будет создано.
  const plan: Array<{
    eventId: string;
    passportId: string;
    operationId: string;
    employeeId: string;
    qty: number;
    rate: Prisma.Decimal;
    amount: Prisma.Decimal;
    createdAt: Date;
  }> = [];
  const skips = new Map<Skip['reason'], number>();

  for (const ev of events) {
    if (!ev.operationId || !ev.employeeId) {
      const r: Skip['reason'] = 'inactive_or_missing_employee';
      skips.set(r, (skips.get(r) ?? 0) + 1);
      continue;
    }
    const emp = empMap.get(ev.employeeId);
    if (!emp || !emp.active) {
      const r: Skip['reason'] = 'inactive_employee';
      skips.set(r, (skips.get(r) ?? 0) + 1);
      continue;
    }
    if (
      emp.compensationType !== 'PIECEWORK' &&
      emp.compensationType !== 'MIXED'
    ) {
      // Сотрудник на чистом окладе — штатный earnings.service.ts тоже
      // пропускает (isPieceworkEligible). Не создаём ничего.
      const r: Skip['reason'] = 'inactive_employee';
      skips.set(r, (skips.get(r) ?? 0) + 1);
      continue;
    }
    if (ev.qty <= 0) {
      const r: Skip['reason'] = 'zero_qty';
      skips.set(r, (skips.get(r) ?? 0) + 1);
      continue;
    }
    if (rates.modes.get(ev.operationId) === 'SALARY_ONLY') {
      const r: Skip['reason'] = 'salary_only';
      skips.set(r, (skips.get(r) ?? 0) + 1);
      continue;
    }
    const rate = resolveRate(rates, ev.operationId, ev.passport.sizeId);
    if (!rate) {
      const r: Skip['reason'] = 'no_rate';
      skips.set(r, (skips.get(r) ?? 0) + 1);
      continue;
    }
    const amount = round2(rate.times(ev.qty));
    plan.push({
      eventId: ev.id,
      passportId: ev.passportId,
      operationId: ev.operationId,
      employeeId: ev.employeeId,
      qty: ev.qty,
      rate,
      amount,
      createdAt: ev.createdAt,
    });
  }

  // 4) Сводка по плану.
  const byEmployee = new Map<string, { qty: number; amount: Prisma.Decimal }>();
  let totalAmount = new Prisma.Decimal(0);
  let totalQty = 0;
  for (const p of plan) {
    const cur = byEmployee.get(p.employeeId) ?? {
      qty: 0,
      amount: new Prisma.Decimal(0),
    };
    cur.qty += p.qty;
    cur.amount = cur.amount.plus(p.amount);
    byEmployee.set(p.employeeId, cur);
    totalAmount = totalAmount.plus(p.amount);
    totalQty += p.qty;
  }

  console.log(`[backfill-wto] к созданию: ${plan.length} строк`);
  console.log(
    `[backfill-wto] итого: ${totalQty} шт, ${totalAmount.toFixed(2)} ₽`,
  );
  if (skips.size > 0) {
    console.log('[backfill-wto] пропущено:');
    for (const [reason, count] of skips) {
      console.log(`  - ${reason}: ${count}`);
    }
  }
  if (byEmployee.size > 0) {
    const empRows = await prisma.employee.findMany({
      where: { id: { in: [...byEmployee.keys()] } },
      select: { id: true, fullName: true },
    });
    const nameMap = new Map(empRows.map((e) => [e.id, e.fullName]));
    console.log('[backfill-wto] по сотрудникам:');
    for (const [empId, agg] of byEmployee) {
      console.log(
        `  - ${nameMap.get(empId) ?? empId}: ${agg.qty} шт, ${agg.amount.toFixed(2)} ₽`,
      );
    }
  }

  if (!args.apply) {
    console.log('[backfill-wto] DRY-RUN — изменений в БД не сделано.');
    console.log('[backfill-wto] для применения добавьте --apply');
    await prisma.$disconnect();
    return;
  }

  // 5) Применение. Идём батчами в небольших транзакциях по 50 строк,
  //    чтобы не держать длинный lock. Каждая create обёрнута в try/catch
  //    под P2002 (повторный запуск, идемпотентность).
  const BATCH = 50;
  let created = 0;
  let duplicates = 0;
  for (let i = 0; i < plan.length; i += BATCH) {
    const chunk = plan.slice(i, i + BATCH);
    await prisma.$transaction(async (tx) => {
      for (const row of chunk) {
        try {
          await tx.operationEntry.create({
            data: {
              passportId: row.passportId,
              operationId: row.operationId,
              employeeId: row.employeeId,
              qty: row.qty,
              ratePerUnit: row.rate,
              amount: row.amount,
              status: 'APPROVED',
              approvalMode: 'AFTER_RELEASE',
              sourceEventType: 'OPERATION_TRANSITION',
              sourceEventId: row.eventId,
              // Сохраняем исторический день — иначе все строки осядут
              // на «сегодня» и /api/me/history покажет неправильную
              // динамику.
              createdAt: row.createdAt,
              approvedAt: row.createdAt,
            },
          });
          created += 1;
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            duplicates += 1;
          } else {
            throw err;
          }
        }
      }
    });
    if ((i + BATCH) % 500 === 0 || i + BATCH >= plan.length) {
      console.log(
        `[backfill-wto] обработано ${Math.min(i + BATCH, plan.length)}/${plan.length}`,
      );
    }
  }
  console.log(
    `[backfill-wto] готово: создано ${created}, пропущено как дубль ${duplicates}`,
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[backfill-wto] FATAL', err);
  await prisma.$disconnect();
  process.exit(1);
});
