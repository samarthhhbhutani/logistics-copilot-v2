-- AlterTable
ALTER TABLE "mailboxes" ALTER COLUMN "encrypted_refresh_token" DROP NOT NULL;

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mailbox_logins" (
    "id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mailbox_logins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mailbox_logins_mailbox_id_key" ON "mailbox_logins"("mailbox_id");

-- CreateIndex
CREATE INDEX "mailbox_logins_tenant_id_idx" ON "mailbox_logins"("tenant_id");

-- CreateIndex
CREATE INDEX "mailboxes_tenant_id_idx" ON "mailboxes"("tenant_id");

-- AddForeignKey
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailbox_logins" ADD CONSTRAINT "mailbox_logins_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mailbox_logins" ADD CONSTRAINT "mailbox_logins_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

