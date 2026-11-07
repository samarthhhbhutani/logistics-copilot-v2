-- CreateEnum
CREATE TYPE "gmail_connection_status" AS ENUM ('not_connected', 'connected', 'needs_reconnect');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "encrypted_google_client_secret" TEXT,
ADD COLUMN     "google_client_id" TEXT;

-- AlterTable
ALTER TABLE "mailboxes" ADD COLUMN     "gmail_connected_at" TIMESTAMPTZ,
ADD COLUMN     "gmail_connection_status" "gmail_connection_status" NOT NULL DEFAULT 'not_connected';

