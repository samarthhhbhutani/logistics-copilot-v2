-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "mailboxes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email_address" TEXT NOT NULL,
    "encrypted_refresh_token" TEXT NOT NULL,
    "last_history_id" BIGINT,
    "watch_expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mailboxes_email_address_key" ON "mailboxes"("email_address");

