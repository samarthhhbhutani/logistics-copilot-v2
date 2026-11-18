-- CreateTable
CREATE TABLE "signature_images" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "s3_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signature_images_mailbox_id_idx" ON "signature_images"("mailbox_id");

-- AddForeignKey
ALTER TABLE "signature_images" ADD CONSTRAINT "signature_images_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_images" ADD CONSTRAINT "signature_images_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
