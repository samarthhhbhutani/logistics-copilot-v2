-- agent_runs: one "Ask the copilot" run per operator ask (roadmap 6.2). The agent proposes, never sends.
-- CreateEnum
CREATE TYPE "agent_run_status" AS ENUM ('running', 'proposed', 'failed');

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "email_id" UUID NOT NULL,
    "gmail_thread_id" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "status" "agent_run_status" NOT NULL DEFAULT 'running',
    "proposal" JSONB,
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_runs_mailbox_id_gmail_thread_id_created_at_idx" ON "agent_runs"("mailbox_id", "gmail_thread_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agent_runs_email_id_idx" ON "agent_runs"("email_id");

-- CreateIndex
CREATE INDEX "agent_runs_tenant_id_idx" ON "agent_runs"("tenant_id");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "emails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
