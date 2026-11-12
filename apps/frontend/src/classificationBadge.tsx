import type { ClassificationLabel } from '@lc/contract';

export const classificationLabelTitles: Record<ClassificationLabel, string> = {
  general: 'General',
  customer_request: 'Customer request',
  customer_reply: 'Customer reply',
  rate_card: 'Rate card',
};

export function ClassificationBadge({ label }: { label: ClassificationLabel }) {
  return (
    <span className={`classificationBadge classification_${label}`}>
      {classificationLabelTitles[label]}
    </span>
  );
}
