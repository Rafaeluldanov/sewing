-- Месячный оклад (`SalaryRateMode.MONTHLY`) + производственный
-- календарь (`PayrollCalendarMonth`), 29.07.2026.
--
-- Что меняется. У окладного контура появляется вторая ось: как раньше
-- `CompensationType` отвечал «получает ли человек оклад», так теперь
-- `Employee.salaryRateMode` отвечает «в каких единицах ставка».
--   - `HOURLY`  — старое поведение: `salaryPerHour`, дневные строки
--                 `SalaryEntry(source = SHIFT_DAY)` по часам смены;
--   - `MONTHLY` — `salaryPerMonth` целиком одной строкой на месяц
--                 (`source = MONTH_SALARY`, `date` = 1-е число).
--
-- Бэкфилл нулевой: дефолт `HOURLY` + `salaryPerMonth = NULL` означает,
-- что для всех существующих сотрудников расчёт не меняется ни на
-- копейку. Ни одна `MONTH_SALARY`-строка не появится, пока менеджер
-- сам не переключит карточку сотрудника.
--
-- ⚠️ Для `MONTHLY` дневные `SHIFT_DAY`-строки не создаются вовсе —
-- иначе месячник получил бы и оклад, и повременку за те же часы. Гейт
-- живёт в `SalaryService.syncDailySalary` (диспетчер по режиму).
--
-- `PayrollCalendarMonth` нужен НЕ для суммы оклада (она полная), а как
-- знаменатель производной ставки ₽/час = `salaryPerMonth / normHours`:
-- по ней считаются доплата за подкрой, ₽/минуту простоя в дашборде и
-- разнос оклада на себестоимость. Норма зависит от переносов
-- праздников, из даты не выводится, поэтому — справочник, который
-- ведёт менеджер. Строки нет → код падает на константу
-- `DEFAULT_MONTH_NORM_HOURS` (21 × 8), экран календаря подсвечивает
-- пропуск.

-- CreateEnum
CREATE TYPE "SalaryRateMode" AS ENUM ('HOURLY', 'MONTHLY');

-- AlterEnum
ALTER TYPE "SalaryEntrySource" ADD VALUE 'MONTH_SALARY';

-- AlterTable
ALTER TABLE "Employee"
  ADD COLUMN "salaryRateMode" "SalaryRateMode" NOT NULL DEFAULT 'HOURLY',
  ADD COLUMN "salaryPerMonth" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "PayrollCalendarMonth" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "normDays" INTEGER NOT NULL,
    "normHours" DECIMAL(7,2) NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollCalendarMonth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollCalendarMonth_year_month_key" ON "PayrollCalendarMonth"("year", "month");

-- CreateIndex
CREATE INDEX "PayrollCalendarMonth_year_idx" ON "PayrollCalendarMonth"("year");
