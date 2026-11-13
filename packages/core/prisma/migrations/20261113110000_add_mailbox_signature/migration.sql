-- signature: plain text appended to every mail sent from the mailbox (4.1 GmailSender). Null: no signature.

-- AlterTable
ALTER TABLE "mailboxes" ADD COLUMN "signature" TEXT;
