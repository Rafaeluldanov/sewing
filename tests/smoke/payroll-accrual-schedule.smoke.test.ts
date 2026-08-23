/**
 * Smoke-тесты «Расписание начисления зарплаты» (23.08.2026).
 *
 * Полноценного React-рендера в проекте нет, поэтому инварианты фичи
 * фиксируем прямо в исходниках — тот же паттерн, что у остальных
 * smoke-наборов.
 *
 * Что охраняем:
 *
 *   1. ДАТА ЗАКРЫТИЯ ЗАКАЗА. Правило отсечки читает
 *      `Order.completedAt`. Если хоть одна точка закрытия перестанет
 *      её проставлять, сдельщина по таким заказам зависнет отложенной
 *      навсегда — молча, без ошибки. Точек три: ручное завершение,
 *      отмена и авто-«Готово» при полной упаковке.
 *   2. ОДНО ПРАВИЛО НА ДВОИХ. Отбор строк документа и предпросмотр
 *      «войдёт / отложено» обязаны ходить через общий helper
 *      `accrual-cutoff.ts`. Две копии правила разъезжаются ровно в
 *      день выплаты.
 *   3. ОКЛАД НЕ ЖДЁТ ЗАКАЗА. `SalaryEntry` к заказу не привязан
 *      (часы смены, месячный оклад, подкрой) — отсечка к нему
 *      неприменима, он всегда идёт по своей дате.
 *   4. КАЛЕНДАРЬ В SHARED. Даты начисления считает shared, а не веб и
 *      backend по отдельности: иначе «ближайшее начисление» на экране
 *      и реальная дата документа разойдутся на границе месяца.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('дата закрытия заказа', () => {
  const orders = read('apps/api/src/modules/orders/orders.service.ts');
  const packing = read('apps/api/src/modules/packing/packing.service.ts');

  test('ручное завершение проставляет completedAt', () => {
    expect(orders).toMatch(
      /status: OrderStatus\.DONE,[\s\S]{0,600}completedAt: new Date\(\)/,
    );
  });

  test('отмена заказа тоже закрывает его для зарплаты', () => {
    // Иначе работа по отменённому заказу не оплатится никогда: `DONE`
    // у него уже не наступит.
    expect(orders).toMatch(
      /status: OrderStatus\.CANCELLED,[\s\S]{0,600}completedAt: new Date\(\)/,
    );
  });

  test('авто-«Готово» при полной упаковке проставляет completedAt', () => {
    expect(packing).toMatch(
      /status: OrderStatus\.DONE,[\s\S]{0,600}completedAt: new Date\(\)/,
    );
  });

  test('колонка есть в схеме и в миграции с бэкфиллом', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).toContain('completedAt    DateTime?');
    const migration = read(
      'prisma/migrations/20261021100000_payroll_accrual_schedule/migration.sql',
    );
    expect(migration).toContain('ALTER TABLE "Order" ADD COLUMN "completedAt"');
    // Бэкфилл обязателен: без него все исторические заказы выглядят
    // «никогда не закрытыми».
    expect(migration).toContain('UPDATE "Order"');
    expect(migration).toContain('CREATE TABLE "PayrollAccrualSchedule"');
  });
});

describe('одно правило отсечки на документ и предпросмотр', () => {
  const cutoff = read('apps/api/src/modules/payroll-schedule/accrual-cutoff.ts');
  const documents = read(
    'apps/api/src/modules/payroll-accrual-documents/payroll-accrual-documents.service.ts',
  );
  const schedule = read(
    'apps/api/src/modules/payroll-schedule/payroll-schedule.service.ts',
  );

  test('helper знает все три основы отсечки', () => {
    expect(cutoff).toContain('ORDER_COMPLETED');
    expect(cutoff).toContain('PASSPORT_PACKED');
    expect(cutoff).toContain('WORK_DATE');
  });

  test('документ отбирает сдельщину через helper', () => {
    expect(documents).toContain('pieceworkAccrualWhere');
    // Собственного условия по статусу/дате рядом остаться не должно —
    // иначе правило снова раздвоится.
    expect(documents).not.toMatch(
      /status: EntryStatus\.APPROVED,\s*\n\s*createdAt: \{ lte: cutoff \}/,
    );
  });

  test('предпросмотр делит кандидатов тем же helper-ом', () => {
    expect(schedule).toContain('passesAccrualCutoff');
    expect(schedule).toContain('pieceworkCandidateWhere');
  });

  test('обе границы суток считает один helper', () => {
    // Документ и предпросмотр обязаны спрашивать даты у одной функции:
    // разошедшиеся границы (endOfDayUtc против московских суток) дают
    // расхождение ровно в день выплаты.
    expect(cutoff).toContain('export function resolveAccrualBounds');
    expect(documents).toContain('resolveAccrualBounds');
    expect(schedule).toContain('resolveAccrualBounds');
    expect(documents).not.toContain('endOfDayUtc(');
  });

  test('миграция приезжает с ВЫКЛЮЧЕННЫМ правилом', () => {
    // Сама по себе миграция не имеет права менять состав зарплатных
    // документов: до решения менеджера отбор остаётся прежним
    // (WORK_DATE), иначе сдельщина по незакрытым заказам молча выпадет
    // из ближайшей выплаты у всех сразу.
    const migration = read(
      'prisma/migrations/20261021100000_payroll_accrual_schedule/migration.sql',
    );
    expect(migration).toContain(`DEFAULT 'WORK_DATE'`);
    expect(migration).toContain('"appliesToSewing" BOOLEAN NOT NULL DEFAULT false');
    expect(migration).toMatch(/INSERT INTO "PayrollAccrualSchedule"[\s\S]*'WORK_DATE'/);
    // Дефолт схемы и fallback сервиса обязаны совпадать, иначе база без
    // строки и база со свежей строкой ведут себя по-разному.
    const schema = read('prisma/schema.prisma');
    expect(schema).toContain('cutoffBasis PayrollCutoffBasis @default(WORK_DATE)');
    expect(schema).toContain('appliesToSewing Boolean @default(false)');
    expect(documents).toContain(`cutoffBasis: 'WORK_DATE'`);
  });

  test('автосоздание застолбляет дату до создания документа', () => {
    // Два параллельных рендера /admin/payroll иначе создавали два
    // документа на одну дату, конкурирующих за одни начисления.
    expect(schedule).toContain('updateMany');
    expect(schedule).toContain('claimed.count === 0');
    // И догоняет пропущенный день, а не пропускает выплату молча.
    expect(schedule).toContain('previousAccrualDate');
  });

  test('оклад отбирается по дате, а не по заказу', () => {
    // В `SalaryEntry` нет заказа вовсе; попытка применить к нему
    // отсечку означала бы, что окладник не получит зарплату, пока цех
    // не закроет чужой заказ.
    expect(cutoff).toContain('OperationEntryWhereInput');
    expect(cutoff).not.toContain('SalaryEntryWhereInput');
  });
});

describe('календарь и настройка', () => {
  const shared = read('packages/shared/src/payroll-schedule.ts');
  const scheduleService = read(
    'apps/api/src/modules/payroll-schedule/payroll-schedule.service.ts',
  );
  const page = read('apps/web/app/admin/payroll/settings/schedule/page.tsx');

  test('даты считает shared, а не каждый слой сам', () => {
    expect(shared).toContain('export function upcomingAccrualDates');
    expect(shared).toContain('export function accrualPeriodFor');
    expect(scheduleService).toContain('upcomingAccrualDates');
    expect(scheduleService).toContain('accrualPeriodFor');
  });

  test('31-е схлопывается в последний день месяца', () => {
    expect(shared).toContain('export function clampDayToMonth');
  });

  test('сутки считаются по Москве', () => {
    // Граница суток в контейнерах — UTC (03:00 МСК); день начисления
    // обязан жить в московских сутках, иначе ночная смена уезжает.
    expect(scheduleService).toContain('moscowDayKey');
    expect(scheduleService).toContain('moscowDayWindow');
  });

  test('экран правил доступен из настроек зарплаты', () => {
    const settings = read('apps/web/app/admin/payroll/settings/page.tsx');
    expect(settings).toContain('/admin/payroll/settings/schedule');
    expect(page).toContain('Правила начисления');
  });

  test('автосоздание останавливается на черновике', () => {
    // Проведение создаёт выплаты и списывает деньги из кассы — оно
    // остаётся решением человека.
    expect(scheduleService).toContain('ensureDueDraft');
    expect(scheduleService).not.toContain('this.documents.pay(');
  });
});
