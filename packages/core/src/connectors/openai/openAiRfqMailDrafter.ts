import type OpenAI from 'openai';
import type { ResponseInputContent } from 'openai/resources/responses/responses';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { RfqDetailsForDraft, RfqMailDrafter } from '../../rfqs/rfqMailDraft.js';
import {
  DRAFT_RFQ_MAIL_MAX_BODY_CHARACTERS,
  DRAFT_RFQ_MAIL_PROMPT_VERSION,
  draftRfqMailSystemPrompt,
} from '../../rfqs/prompts/draftRfqMailPromptV1.js';
import { runInsideSpan } from '../../telemetry/runInsideSpan.js';
import {
  buildUserContent,
  describeMissingOutput,
  toLlmFailureOutcome,
} from './openAiEmailClassifier.js';

/** A 220-word mail plus subject; generous so a long special-instructions list is not cut. */
const MAX_OUTPUT_TOKENS = 900;

export const rfqMailDraftOutputSchema = z.object({
  subject: z.string(),
  bodyText: z.string(),
});

export interface OpenAiRfqMailDrafterOptions {
  openAiClient: OpenAI;
  model: string;
}

/** Writes one vendor mail per category from the operator's facts, with the classifier's client, span and failure mapping. */
export function createOpenAiRfqMailDrafter({
  openAiClient,
  model,
}: OpenAiRfqMailDrafterOptions): RfqMailDrafter {
  return {
    async draft({ category, details, customerMail }) {
      const content: ResponseInputContent[] = [
        { type: 'input_text', text: shipmentAsData(details) },
        ...buildUserContent(
          { ...customerMail, attachments: [] },
          false,
          DRAFT_RFQ_MAIL_MAX_BODY_CHARACTERS,
        ),
      ];
      try {
        const response = await runInsideSpan(
          'openai.draftRfqMail',
          () =>
            openAiClient.responses.parse({
              model,
              instructions: draftRfqMailSystemPrompt(category),
              input: [{ role: 'user', content }],
              text: { format: zodTextFormat(rfqMailDraftOutputSchema, 'rfq_mail_draft') },
              max_output_tokens: MAX_OUTPUT_TOKENS,
              store: false,
            }),
          {
            'llm.model': model,
            'llm.prompt_version': DRAFT_RFQ_MAIL_PROMPT_VERSION,
            'rfq.vendor_category': category,
          },
        );
        const parsed = response.output_parsed;
        if (!parsed) return { outcome: 'failed', detail: describeMissingOutput(response) };
        const subject = parsed.subject.trim();
        const bodyText = parsed.bodyText.trim();
        if (!subject || !bodyText) return { outcome: 'failed', detail: 'empty subject or body' };
        return {
          outcome: 'drafted',
          draft: { subject, bodyText },
          model: response.model || model,
          promptVersion: DRAFT_RFQ_MAIL_PROMPT_VERSION,
        };
      } catch (error) {
        return toLlmFailureOutcome(error);
      }
    },
  };
}

const SHIPMENT_CLOSING_TAG_PATTERN = /<\/shipment/gi;
const LINE_BREAK_PATTERN = /[\r\n]+/g;

/**
 * The facts as a data block, one line per field, nulls spelled out so the model sees what is
 * unknown rather than inferring it. Values lose "</shipment" so a hostile value cannot close the
 * block, and their line breaks collapse to a space so a value cannot forge an extra fact line.
 */
export function shipmentAsData(details: RfqDetailsForDraft): string {
  const value = (field: string | number | null) =>
    field === null
      ? 'unknown'
      : String(field)
          .replace(LINE_BREAK_PATTERN, ' ')
          .replace(SHIPMENT_CLOSING_TAG_PATTERN, '</ shipment');
  const containers =
    details.containers.length === 0
      ? 'unknown'
      : details.containers.map((box) => `${box.quantity} x ${value(box.type)}`).join(', ');
  const lines = [
    `Origin port: ${value(details.originPort)}`,
    `Destination port: ${value(details.destinationPort)}`,
    `Mode: ${value(details.mode)}`,
    `Containers: ${containers}`,
    `Commodity: ${value(details.commodity)}`,
    `Gross weight (kg): ${value(details.grossWeightKg)}`,
    `Volume (cbm): ${value(details.volumeCbm)}`,
    `Incoterm: ${value(details.incoterm)}`,
    `Cargo ready: ${value(details.readyDate)}`,
    `Pickup address: ${value(details.senderAddress)}`,
    `Delivery address: ${value(details.receiverAddress)}`,
    `Special instructions: ${value(details.specialInstructions)}`,
  ];
  return `<shipment>\n${lines.join('\n')}\n</shipment>`;
}
