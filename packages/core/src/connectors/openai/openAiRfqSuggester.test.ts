import type OpenAI from 'openai';
import { APIConnectionError, APIError } from 'openai';
import { describe, expect, it } from 'vitest';
import {
  SUGGEST_RFQ_MAX_BODY_CHARACTERS,
  SUGGEST_RFQ_PROMPT_VERSION,
  SUGGEST_RFQ_SYSTEM_PROMPT,
} from '../../rfqs/prompts/suggestRfqPromptV1.js';
import type { EmailToSuggestFrom } from '../../rfqs/rfqSuggestion.js';
import type { ParsedAttachment } from '../../utils/mime/parsedEmail.js';
import { createOpenAiRfqSuggester } from './openAiRfqSuggester.js';

const email: EmailToSuggestFrom = {
  senderName: 'Ravi Kumar',
  senderEmail: 'ravi@acme.com',
  subject: 'Rates Mundra to Tema',
  bodyText: 'Please quote 2 x 40ft HC, granite slabs, 52 tons, FOB Mundra to Tema.',
  attachments: [],
};

const packingList: ParsedAttachment = {
  fileName: 'packing-list.pdf',
  contentType: 'application/pdf',
  sizeBytes: 8,
  content: new Uint8Array(Buffer.from('%PDF-1.4')),
  contentId: undefined,
  isInline: false,
};

const fullReading = {
  originPort: 'Mundra',
  destinationPort: 'Tema',
  senderAddress: null,
  receiverAddress: null,
  mode: 'sea_freight',
  containers: [
    { type: '40ft HC', quantity: 2 },
    { type: '20ft', quantity: 0 },
  ],
  commodity: 'granite slabs',
  grossWeightKg: 52000,
  volumeCbm: null,
  incoterm: 'FOB',
  readyDate: null,
  specialInstructions: null,
};

/** The slice of the SDK the suggester touches; `parse` returns or throws what the test says. */
function fakeOpenAi(
  behaviour: { output_parsed?: unknown; model?: string; incomplete?: string } | Error,
): { client: OpenAI; requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  const client = {
    responses: {
      async parse(request: Record<string, unknown>) {
        requests.push(request);
        if (behaviour instanceof Error) throw behaviour;
        return {
          output_parsed: behaviour.output_parsed ?? null,
          model: behaviour.model ?? '',
          incomplete_details: behaviour.incomplete ? { reason: behaviour.incomplete } : null,
          output: [],
        };
      },
    },
  } as unknown as OpenAI;
  return { client, requests };
}

function apiError(status: number, code?: string): APIError {
  return new APIError(
    status,
    { message: `status ${status}`, code },
    `status ${status}`,
    new Headers(),
  );
}

describe('createOpenAiRfqSuggester', () => {
  it('sends the mail as data with the suggest prompt and returns the reading, dropping zero-count containers', async () => {
    const { client, requests } = fakeOpenAi({
      output_parsed: fullReading,
      model: 'gpt-6-luna-2026-10-01',
    });
    const suggester = createOpenAiRfqSuggester({ openAiClient: client, model: 'gpt-6-luna' });

    const result = await suggester.suggest(email);

    expect(result).toEqual({
      outcome: 'suggested',
      suggestion: { ...fullReading, containers: [{ type: '40ft HC', quantity: 2 }] },
      model: 'gpt-6-luna-2026-10-01',
      promptVersion: SUGGEST_RFQ_PROMPT_VERSION,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: 'gpt-6-luna',
      instructions: SUGGEST_RFQ_SYSTEM_PROMPT,
      store: false,
    });
    const [userMessage] = requests[0]!.input as { content: { type: string; text: string }[] }[];
    expect(userMessage!.content).toHaveLength(1);
    expect(userMessage!.content[0]!.text).toContain('Subject: Rates Mundra to Tema');
    expect(userMessage!.content[0]!.text).toContain('Attachments: none');
  });

  it('sends the files it is given as native inputs after the mail text', async () => {
    const { client, requests } = fakeOpenAi({ output_parsed: fullReading });
    const suggester = createOpenAiRfqSuggester({ openAiClient: client, model: 'gpt-6-luna' });

    await suggester.suggest({ ...email, attachments: [packingList] });

    const [userMessage] = requests[0]!.input as {
      content: { type: string; text?: string; filename?: string }[];
    }[];
    expect(userMessage!.content).toHaveLength(2);
    expect(userMessage!.content[0]!.text).toContain(
      '- packing-list.pdf (application/pdf, 8 bytes)',
    );
    expect(userMessage!.content[1]).toMatchObject({
      type: 'input_file',
      filename: 'packing-list.pdf',
    });
  });

  it('reads far more of the body than the classifier does, and still marks a cut', async () => {
    const { client, requests } = fakeOpenAi({ output_parsed: fullReading });
    const suggester = createOpenAiRfqSuggester({ openAiClient: client, model: 'gpt-6-luna' });

    await suggester.suggest({
      ...email,
      bodyText: 'x'.repeat(SUGGEST_RFQ_MAX_BODY_CHARACTERS + 10),
    });

    const [userMessage] = requests[0]!.input as { content: { text: string }[] }[];
    expect(userMessage!.content[0]!.text).toContain('x'.repeat(SUGGEST_RFQ_MAX_BODY_CHARACTERS));
    expect(userMessage!.content[0]!.text).toContain('[truncated]');
  });

  it('is failed when the response carries no parsed reading', async () => {
    const { client } = fakeOpenAi({ incomplete: 'max_output_tokens' });
    const suggester = createOpenAiRfqSuggester({ openAiClient: client, model: 'gpt-6-luna' });

    expect(await suggester.suggest(email)).toEqual({
      outcome: 'failed',
      detail: 'incomplete: max_output_tokens',
    });
  });

  it('maps connection errors, 429 and 5xx to retry, and 4xx or no credit to failed', async () => {
    const outcomes = await Promise.all(
      [
        new APIConnectionError({ message: 'socket hang up' }),
        apiError(429),
        apiError(503),
        apiError(400),
        apiError(429, 'insufficient_quota'),
      ].map((error) =>
        createOpenAiRfqSuggester({ openAiClient: fakeOpenAi(error).client, model: 'm' }).suggest(
          email,
        ),
      ),
    );
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
      'retry',
      'retry',
      'retry',
      'failed',
      'failed',
    ]);
  });
});
