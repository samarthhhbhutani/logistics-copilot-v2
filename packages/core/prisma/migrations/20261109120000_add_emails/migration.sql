-- CreateEnum
CREATE TYPE "gmail_label" AS ENUM ('inbox', 'sent');

-- CreateTable
CREATE TABLE "emails" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "gmail_message_id" TEXT NOT NULL,
    "gmail_thread_id" TEXT NOT NULL,
    "gmail_label" "gmail_label" NOT NULL,
    "rfc_message_id" TEXT,
    "sender_name" TEXT NOT NULL,
    "sender_email" TEXT,
    "to_recipients" JSONB NOT NULL,
    "cc_recipients" JSONB NOT NULL,
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "body_html" TEXT,
    "raw_email_s3_key" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "emails_mailbox_id_received_at_idx" ON "emails"("mailbox_id", "received_at");

-- CreateIndex
CREATE INDEX "emails_mailbox_id_gmail_thread_id_idx" ON "emails"("mailbox_id", "gmail_thread_id");

-- CreateIndex
CREATE INDEX "emails_tenant_id_idx" ON "emails"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "emails_mailbox_id_gmail_message_id_key" ON "emails"("mailbox_id", "gmail_message_id");

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

