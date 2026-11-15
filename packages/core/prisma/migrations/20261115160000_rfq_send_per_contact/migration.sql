-- rfq send (roadmap 4.4b): a customer mail may be processed more than once, so rfqs.source_email_id is no longer
-- unique; sent_mails.vendor_contact_id records the person an rfq mail went to and, with rfq_id, keys one mail
-- per contact per RFQ so a retried send cannot create a second row.
-- DropIndex
DROP INDEX "rfqs_source_email_id_key";

-- AlterTable
ALTER TABLE "sent_mails" ADD COLUMN     "vendor_contact_id" UUID;

-- CreateIndex
CREATE INDEX "rfqs_source_email_id_idx" ON "rfqs"("source_email_id");

-- CreateIndex
CREATE UNIQUE INDEX "sent_mails_rfq_id_vendor_contact_id_key" ON "sent_mails"("rfq_id", "vendor_contact_id");

-- AddForeignKey
ALTER TABLE "sent_mails" ADD CONSTRAINT "sent_mails_vendor_contact_id_fkey" FOREIGN KEY ("vendor_contact_id") REFERENCES "vendor_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

