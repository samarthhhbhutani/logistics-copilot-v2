-- CreateEnum
CREATE TYPE "classification_label" AS ENUM ('general', 'customer_request', 'rate_card');

-- CreateEnum
CREATE TYPE "classification_source" AS ENUM ('rule', 'llm', 'user');

-- CreateTable
CREATE TABLE "classification_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "priority" INTEGER NOT NULL,
    "sender_pattern" TEXT NOT NULL,
    "label" "classification_label" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email_id" UUID NOT NULL,
    "label" "classification_label" NOT NULL,
    "source" "classification_source" NOT NULL,
    "rule_id" UUID,
    "llm_model" TEXT,
    "prompt_version" TEXT,
    "confidence" DOUBLE PRECISION,
    "classified_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "classification_rules_tenant_id_enabled_priority_idx" ON "classification_rules"("tenant_id", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "classification_rules_tenant_id_sender_pattern_key" ON "classification_rules"("tenant_id", "sender_pattern");

-- CreateIndex
CREATE INDEX "classifications_email_id_classified_at_idx" ON "classifications"("email_id", "classified_at" DESC);

-- CreateIndex
CREATE INDEX "classifications_tenant_id_idx" ON "classifications"("tenant_id");

-- AddForeignKey
ALTER TABLE "classification_rules" ADD CONSTRAINT "classification_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "emails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "classification_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

