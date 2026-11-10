import type { ClassificationLabel } from './classificationLabel.js';

/** One classification_rules row. Disabled rules are kept, so rule_id on a classification stays meaningful. */
export interface ClassificationRule {
  id: string;
  /** Lower value is checked first. */
  priority: number;
  /** Case-insensitive; with an "@" it must equal the whole address, otherwise the domain after "@". */
  senderPattern: string;
  label: ClassificationLabel;
  enabled: boolean;
  createdAt: Date;
}
