-- An upload is owned by the reply that carried it or by the RFQ whose every vendor mail carries it.
-- AlterTable
ALTER TABLE "outbound_attachments" ADD COLUMN "rfq_id" UUID;

-- CreateIndex
CREATE INDEX "outbound_attachments_rfq_id_idx" ON "outbound_attachments"("rfq_id");

-- AddForeignKey
ALTER TABLE "outbound_attachments" ADD CONSTRAINT "outbound_attachments_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Never both owners (both null while the file waits in a composer).
ALTER TABLE "outbound_attachments" ADD CONSTRAINT "outbound_attachments_single_owner_check" CHECK ("sent_mail_id" IS NULL OR "rfq_id" IS NULL);
