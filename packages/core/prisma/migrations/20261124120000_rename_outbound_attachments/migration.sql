-- Uploads are no longer reply-only: an RFQ's vendor mails will carry them too. Rename the table and
-- everything Prisma named after it.
ALTER TABLE "reply_attachments" RENAME TO "outbound_attachments";
ALTER TABLE "outbound_attachments" RENAME CONSTRAINT "reply_attachments_pkey" TO "outbound_attachments_pkey";
ALTER TABLE "outbound_attachments" RENAME CONSTRAINT "reply_attachments_tenant_id_fkey" TO "outbound_attachments_tenant_id_fkey";
ALTER TABLE "outbound_attachments" RENAME CONSTRAINT "reply_attachments_mailbox_id_fkey" TO "outbound_attachments_mailbox_id_fkey";
ALTER TABLE "outbound_attachments" RENAME CONSTRAINT "reply_attachments_sent_mail_id_fkey" TO "outbound_attachments_sent_mail_id_fkey";
ALTER INDEX "reply_attachments_mailbox_id_idx" RENAME TO "outbound_attachments_mailbox_id_idx";
ALTER INDEX "reply_attachments_sent_mail_id_idx" RENAME TO "outbound_attachments_sent_mail_id_idx";
