-- AlterTable
ALTER TABLE "Operation" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "CompanySettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "legalName" TEXT,
    "shortName" TEXT,
    "inn" TEXT,
    "kpp" TEXT,
    "ogrn" TEXT,
    "legalAddress" TEXT,
    "actualAddress" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "directorName" TEXT,
    "accountantName" TEXT,
    "bankName" TEXT,
    "bik" TEXT,
    "correspondentAccount" TEXT,
    "settlementAccount" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyDivision" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyDivision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanySettings_singleton_key" ON "CompanySettings"("singleton");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyDivision_code_key" ON "CompanyDivision"("code");

-- CreateIndex
CREATE INDEX "CompanyDivision_isActive_idx" ON "CompanyDivision"("isActive");

-- CreateIndex
CREATE INDEX "CompanyDivision_sortOrder_idx" ON "CompanyDivision"("sortOrder");
