-- customer_reply: a later inbound mail in a thread that already holds a customer_request.
-- thread: the source of such a label (derived from the thread; not a rule, not the LLM).

-- AlterEnum
ALTER TYPE "classification_label" ADD VALUE 'customer_reply';

-- AlterEnum
ALTER TYPE "classification_source" ADD VALUE 'thread';
