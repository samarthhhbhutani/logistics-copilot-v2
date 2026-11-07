-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "pubsub_topic_name" TEXT,
ADD COLUMN     "push_service_account_email" TEXT;
