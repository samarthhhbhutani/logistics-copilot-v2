import type { ClassificationLabel } from './classificationLabel.js';

/** A tenant rule decided; the rule is kept so the row explains itself. */
export interface RuleClassification {
  source: 'rule';
  label: ClassificationLabel;
  ruleId: string;
}

/** The model decided; model and prompt version are kept so later prompts can be compared. */
export interface LlmClassification {
  source: 'llm';
  label: ClassificationLabel;
  /** The model's own estimate in [0, 1]; not calibrated, stored for later analysis. */
  confidence: number;
  llmModel: string;
  promptVersion: string;
}

/** What the processor hands the repository to store alongside the email, in the same transaction. */
export type EmailClassification = RuleClassification | LlmClassification;
