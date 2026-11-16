-- vendor_reply / vendor_quote (roadmap 5.1): an inbound mail answering an RFQ mail of ours, without / with a
-- price in it. Derived from emails.answers_sent_mail_id, never declared by a rule or offered to the general classifier.

-- AlterEnum
ALTER TYPE "classification_label" ADD VALUE 'vendor_reply';

-- AlterEnum
ALTER TYPE "classification_label" ADD VALUE 'vendor_quote';
