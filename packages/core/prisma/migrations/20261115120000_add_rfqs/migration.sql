-- rfqs: one row per customer request turned into vendor mails; sent_mails.rfq_id / vendor_id link each vendor mail to it (roadmap 4.3a).
-- CreateEnum
CREATE TYPE "rfq_status" AS ENUM ('open', 'closed');

-- AlterEnum
ALTER TYPE "sent_mail_kind" ADD VALUE 'rfq';

-- AlterTable
ALTER TABLE "sent_mails" ADD COLUMN     "rfq_id" UUID,
ADD COLUMN     "vendor_id" UUID;

-- CreateTable
CREATE TABLE "rfqs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "source_email_id" UUID NOT NULL,
    "origin_port" TEXT NOT NULL,
    "destination_port" TEXT NOT NULL,
    "incoterm" TEXT,
    "status" "rfq_status" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_source_email_id_key" ON "rfqs"("source_email_id");

-- CreateIndex
CREATE INDEX "rfqs_mailbox_id_created_at_idx" ON "rfqs"("mailbox_id", "created_at");

-- CreateIndex
CREATE INDEX "rfqs_tenant_id_idx" ON "rfqs"("tenant_id");

-- CreateIndex
CREATE INDEX "sent_mails_rfq_id_idx" ON "sent_mails"("rfq_id");

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_source_email_id_fkey" FOREIGN KEY ("source_email_id") REFERENCES "emails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sent_mails" ADD CONSTRAINT "sent_mails_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sent_mails" ADD CONSTRAINT "sent_mails_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
