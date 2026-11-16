-- reply linking (roadmap 5.1a): an inbound mail can point at the sent_mails row it answers. Several
-- inbound mails may answer one sent mail (acknowledgement, then the quote), so the link lives on the
-- inbound side and nothing is overwritten. Inert until the processor starts setting it (5.1b).
-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "answers_sent_mail_id" UUID;

-- CreateIndex
CREATE INDEX "emails_answers_sent_mail_id_idx" ON "emails"("answers_sent_mail_id");

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_answers_sent_mail_id_fkey" FOREIGN KEY ("answers_sent_mail_id") REFERENCES "sent_mails"("id") ON DELETE SET NULL ON UPDATE CASCADE;
