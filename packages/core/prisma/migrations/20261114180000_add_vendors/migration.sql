-- vendors + vendor_contacts: the companies the desk sends RFQs to and the people there (roadmap 4.2b).
-- CreateEnum
CREATE TYPE "vendor_category" AS ENUM ('cha', 'carrier');

-- CreateTable
CREATE TABLE "vendors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_name" TEXT NOT NULL,
    "category" "vendor_category" NOT NULL,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_contacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "contact_name" TEXT NOT NULL,
    "email_address" TEXT NOT NULL,
    "phone_number" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendors_tenant_id_active_idx" ON "vendors"("tenant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_tenant_id_vendor_name_key" ON "vendors"("tenant_id", "vendor_name");

-- CreateIndex
CREATE INDEX "vendor_contacts_tenant_id_idx" ON "vendor_contacts"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_contacts_vendor_id_email_address_key" ON "vendor_contacts"("vendor_id", "email_address");

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

