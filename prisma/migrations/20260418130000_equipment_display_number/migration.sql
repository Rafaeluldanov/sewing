-- Add manual display number to Equipment for physical marking and
-- print labels. Additive change: nullable, no default. Existing rows
-- остаются с NULL, seed/админка проставят значения по факту.

ALTER TABLE "Equipment"
ADD COLUMN "displayNumber" TEXT;
