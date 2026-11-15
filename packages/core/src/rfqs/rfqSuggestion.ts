import type { LlmFailureOutcome } from '../connectors/openai/openAiEmailClassifier.js';
import type { ParsedAttachment } from '../utils/mime/parsedEmail.js';

export type FreightMode = 'sea_freight' | 'air_freight' | 'road';

export interface SuggestedContainer {
  type: string;
  quantity: number;
}

/**
 * The shipment details an LLM read out of a customer mail, every field null when the mail did
 * not state it. Same keys as the contract's rfqDetails so the frontend can pour it straight into
 * the form; the ports are nullable here because a suggestion may not find them.
 */
export interface RfqSuggestion {
  originPort: string | null;
  destinationPort: string | null;
  senderAddress: string | null;
  receiverAddress: string | null;
  mode: FreightMode | null;
  containers: SuggestedContainer[];
  commodity: string | null;
  grossWeightKg: number | null;
  volumeCbm: number | null;
  incoterm: string | null;
  readyDate: string | null;
  specialInstructions: string | null;
}

export interface EmailToSuggestFrom {
  senderName: string;
  senderEmail: string | undefined;
  subject: string;
  bodyText: string;
  /** Files to show the model as well (PDFs and images; the caller decides whether to fetch any). Empty: text only. */
  attachments: ParsedAttachment[];
}

/**
 * suggested: a reading, with the model and prompt that produced it.
 * retry: the provider was unavailable or rate-limited; the operator can try again shortly.
 * failed: the request itself is wrong (rejected input, refusal, unparseable output); the operator fills the form by hand.
 */
export type RfqSuggesterOutcome =
  | { outcome: 'suggested'; suggestion: RfqSuggestion; model: string; promptVersion: string }
  | LlmFailureOutcome;

export interface RfqSuggester {
  suggest(email: EmailToSuggestFrom): Promise<RfqSuggesterOutcome>;
}
