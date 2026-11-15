import type OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { RfqSuggester } from '../../rfqs/rfqSuggestion.js';
import {
  SUGGEST_RFQ_MAX_BODY_CHARACTERS,
  SUGGEST_RFQ_PROMPT_VERSION,
  SUGGEST_RFQ_SYSTEM_PROMPT,
} from '../../rfqs/prompts/suggestRfqPromptV1.js';
import { runInsideSpan } from '../../telemetry/runInsideSpan.js';
import {
  buildUserContent,
  describeMissingOutput,
  toLlmFailureOutcome,
} from './openAiEmailClassifier.js';

/** Structured output is small, but specialInstructions and addresses can run to a few hundred tokens. */
const MAX_OUTPUT_TOKENS = 1200;

/** What the model must return: every key present, null where the mail is silent (the strict format allows no optional keys). */
export const rfqSuggestionOutputSchema = z.object({
  originPort: z.string().nullable(),
  destinationPort: z.string().nullable(),
  senderAddress: z.string().nullable(),
  receiverAddress: z.string().nullable(),
  mode: z.enum(['sea_freight', 'air_freight', 'road']).nullable(),
  containers: z.array(z.object({ type: z.string(), quantity: z.number().int() })),
  commodity: z.string().nullable(),
  grossWeightKg: z.number().nullable(),
  volumeCbm: z.number().nullable(),
  incoterm: z.string().nullable(),
  readyDate: z.string().nullable(),
  specialInstructions: z.string().nullable(),
});

export interface OpenAiRfqSuggesterOptions {
  openAiClient: OpenAI;
  model: string;
}

/** Reads shipment details out of a customer mail with the same client, prompt framing, span and failure mapping as the classifier. */
export function createOpenAiRfqSuggester({
  openAiClient,
  model,
}: OpenAiRfqSuggesterOptions): RfqSuggester {
  return {
    async suggest(email) {
      // Whatever files the caller fetched are sent (PDFs and images natively, within the shared caps).
      const content = buildUserContent(
        email,
        email.attachments.length > 0,
        SUGGEST_RFQ_MAX_BODY_CHARACTERS,
      );
      try {
        const response = await runInsideSpan(
          'openai.suggestRfq',
          () =>
            openAiClient.responses.parse({
              model,
              instructions: SUGGEST_RFQ_SYSTEM_PROMPT,
              input: [{ role: 'user', content }],
              text: { format: zodTextFormat(rfqSuggestionOutputSchema, 'rfq_suggestion') },
              max_output_tokens: MAX_OUTPUT_TOKENS,
              store: false,
            }),
          { 'llm.model': model, 'llm.prompt_version': SUGGEST_RFQ_PROMPT_VERSION },
        );
        const parsed = response.output_parsed;
        if (!parsed) return { outcome: 'failed', detail: describeMissingOutput(response) };
        return {
          outcome: 'suggested',
          suggestion: {
            ...parsed,
            // The model is told to give a count per type; a zero or negative one is a misread, not a request.
            containers: parsed.containers.filter((container) => container.quantity > 0),
          },
          model: response.model || model,
          promptVersion: SUGGEST_RFQ_PROMPT_VERSION,
        };
      } catch (error) {
        return toLlmFailureOutcome(error);
      }
    },
  };
}
