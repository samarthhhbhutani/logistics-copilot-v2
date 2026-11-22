-- CreateTable
CREATE TABLE "reply_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "sent_mail_id" UUID,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reply_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reply_attachments_mailbox_id_idx" ON "reply_attachments"("mailbox_id");

-- CreateIndex
CREATE INDEX "reply_attachments_sent_mail_id_idx" ON "reply_attachments"("sent_mail_id");

-- AddForeignKey
ALTER TABLE "reply_attachments" ADD CONSTRAINT "reply_attachments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply_attachments" ADD CONSTRAINT "reply_attachments_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply_attachments" ADD CONSTRAINT "reply_attachments_sent_mail_id_fkey" FOREIGN KEY ("sent_mail_id") REFERENCES "sent_mails"("id") ON DELETE SET NULL ON UPDATE CASCADE;
