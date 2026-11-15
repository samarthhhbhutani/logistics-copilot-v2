import type { LlmFailureOutcome } from '../connectors/openai/openAiEmailClassifier.js';
import type { VendorCategory } from '../vendors/vendorModels.js';
import type { FreightMode, SuggestedContainer } from './rfqSuggestion.js';

/**
 * The operator's confirmed shipment facts, the ground truth a draft is written from. Same keys as
 * the contract's rfqDetails (the API validates and hands them over); only the ports are required.
 */
export interface RfqDetailsForDraft {
  originPort: string;
  destinationPort: string;
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

export interface CustomerMailForDraft {
  senderName: string;
  senderEmail: string | undefined;
  subject: string;
  bodyText: string;
}

export interface RfqMailToDraft {
  /** Decides which questions the mail asks; one draft serves every vendor of the category. */
  category: VendorCategory;
  details: RfqDetailsForDraft;
  /** Context only: tone and anything the details leave null. */
  customerMail: CustomerMailForDraft;
}

export interface RfqMailDraft {
  subject: string;
  bodyText: string;
}

/**
 * drafted: text for the operator to edit on screen; nothing has been sent or stored.
 * retry: the provider was unavailable or rate-limited. failed: the request itself was refused or unreadable.
 */
export type RfqMailDrafterOutcome =
  | { outcome: 'drafted'; draft: RfqMailDraft; model: string; promptVersion: string }
  | LlmFailureOutcome;

/** The two ways a draft call ends without text: provider unavailable (retry) or unusable answer (failed). */
export type RfqMailDraftFailure = Exclude<RfqMailDrafterOutcome, { outcome: 'drafted' }>;

export function isNotDrafted(outcome: RfqMailDrafterOutcome): outcome is RfqMailDraftFailure {
  return outcome.outcome !== 'drafted';
}

export interface RfqMailDrafter {
  draft(input: RfqMailToDraft): Promise<RfqMailDrafterOutcome>;
}
