-- sent_mails: write-ahead record of every mail we send (roadmap 4.2). Row first, messages.send second.

-- CreateEnum
CREATE TYPE "sent_mail_kind" AS ENUM ('reply');

-- CreateEnum
CREATE TYPE "sent_mail_status" AS ENUM ('pending', 'sending', 'sent', 'failed');

-- CreateTable
CREATE TABLE "sent_mails" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "kind" "sent_mail_kind" NOT NULL,
    "in_reply_to_email_id" UUID,
    "gmail_thread_id" TEXT,
    "rfc_message_id" TEXT NOT NULL,
    "to_recipients" JSONB NOT NULL,
    "cc_recipients" JSONB NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "status" "sent_mail_status" NOT NULL DEFAULT 'pending',
    "gmail_message_id" TEXT,
    "sent_email_id" UUID,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sent_mails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sent_mails_mailbox_id_in_reply_to_email_id_idx" ON "sent_mails"("mailbox_id", "in_reply_to_email_id");

-- CreateIndex
CREATE INDEX "sent_mails_tenant_id_idx" ON "sent_mails"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sent_mails_mailbox_id_rfc_message_id_key" ON "sent_mails"("mailbox_id", "rfc_message_id");

-- AddForeignKey
ALTER TABLE "sent_mails" ADD CONSTRAINT "sent_mails_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sent_mails" ADD CONSTRAINT "sent_mails_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sent_mails" ADD CONSTRAINT "sent_mails_in_reply_to_email_id_fkey" FOREIGN KEY ("in_reply_to_email_id") REFERENCES "emails"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sent_mails" ADD CONSTRAINT "sent_mails_sent_email_id_fkey" FOREIGN KEY ("sent_email_id") REFERENCES "emails"("id") ON DELETE SET NULL ON UPDATE CASCADE;

