// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmailDetailResponse,
  OutboundAttachmentResponse,
  RfqMailWithRepliesResponse,
  RfqWithMailsResponse,
  SendRfqBody,
  VendorResponse,
} from '@lc/contract';
import { frontendApi } from './frontendApi.js';
import { RfqPanel } from './rfqPanel.js';

const session = {
  tenantId: '00000000-0000-4000-8000-000000000002',
  mailboxId: '00000000-0000-4000-8000-000000000001',
};
const inbound: EmailDetailResponse = {
  id: '00000000-0000-4000-8000-000000000011',
  gmailThreadId: 'abc123',
  gmailLabel: 'inbox',
  sender: { name: 'Ravi', email: 'ravi@example.com' },
  toRecipients: [{ name: '', address: 'ops@example.com' }],
  ccRecipients: [],
  subject: 'Rates',
  snippet: '',
  receivedAt: '2026-11-22T09:00:00.000Z',
  classification: null,
  rfcMessageId: null,
  bodyText: 'Please quote Hazira to Jebel Ali.',
  bodyHtml: null,
};
const carrier: VendorResponse = {
  id: '00000000-0000-4000-8000-000000000021',
  vendorName: 'Sea Lines',
  category: 'carrier',
  notes: null,
  active: true,
  contacts: [
    {
      id: '00000000-0000-4000-8000-000000000031',
      contactName: 'Asha Rao',
      emailAddress: 'asha.rao@sealines.example',
      phoneNumber: null,
      active: true,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

function rfqMail(rfqId: string): RfqMailWithRepliesResponse {
  return {
    id: '00000000-0000-4000-8000-000000000041',
    kind: 'rfq',
    status: 'sent',
    inReplyToEmailId: null,
    rfqId,
    vendorId: carrier.id,
    vendorContactId: carrier.contacts[0]!.id,
    gmailThreadId: 't1',
    rfcMessageId: '<x@example.com>',
    toRecipients: [{ name: 'Asha Rao', address: 'asha.rao@sealines.example' }],
    ccRecipients: [],
    subject: 'RFQ: carrier rates',
    bodyText: 'Dear Team',
    gmailMessageId: 'm1',
    errorCode: null,
    attachments: [],
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:01.000Z',
    replies: { count: 0, latest: null },
  };
}
function rfqResult(rfqId: string, attachments: OutboundAttachmentResponse[]): RfqWithMailsResponse {
  return {
    rfq: {
      id: rfqId,
      sourceEmailId: inbound.id,
      originPort: 'Hazira',
      destinationPort: 'Jebel Ali',
      incoterm: null,
      status: 'open',
      createdAt: '2026-11-22T10:00:00.000Z',
      updatedAt: '2026-11-22T10:00:00.000Z',
    },
    mails: [rfqMail(rfqId)],
    attachments,
  };
}

/** The uploads made so far, by id, so a send can list the ones its body names. */
const uploaded = new Map<string, OutboundAttachmentResponse>();
function acceptUploads() {
  return vi.spyOn(frontendApi, 'uploadOutboundAttachment').mockImplementation((_session, file) => {
    const attachment: OutboundAttachmentResponse = {
      id: `00000000-0000-4000-8000-0000000000a${uploaded.size + 1}`,
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      createdAt: '2026-11-22T09:30:00.000Z',
    };
    uploaded.set(attachment.id, attachment);
    return Promise.resolve(attachment);
  });
}
/** A fresh mailbox: no earlier RFQ, a suggestion with both ports, one carrier contact, one draft. */
function stubFormBackend() {
  vi.spyOn(frontendApi, 'rfqBySourceEmail').mockResolvedValue(null);
  vi.spyOn(frontendApi, 'rfqSuggestion').mockResolvedValue({
    originPort: 'Hazira',
    destinationPort: 'Jebel Ali',
    senderAddress: null,
    receiverAddress: null,
    mode: null,
    containers: [],
    commodity: null,
    grossWeightKg: null,
    volumeCbm: null,
    incoterm: null,
    readyDate: null,
    specialInstructions: null,
    model: 'test',
    promptVersion: '1',
  });
  vi.spyOn(frontendApi, 'vendors').mockResolvedValue({ vendors: [carrier] });
  vi.spyOn(frontendApi, 'rfqDrafts').mockResolvedValue({
    drafts: [
      {
        category: 'carrier',
        subject: 'RFQ: carrier rates',
        bodyText: 'Dear Team',
        model: 'test',
        promptVersion: '1',
      },
    ],
  });
  return vi.spyOn(frontendApi, 'sendRfq').mockImplementation((_session, rfqId, body: SendRfqBody) =>
    Promise.resolve(
      rfqResult(
        rfqId,
        (body.attachmentIds ?? []).map((id) => uploaded.get(id)!),
      ),
    ),
  );
}

let container: HTMLDivElement;
let root: Root | undefined;
let queryClient: QueryClient;
const onSignedOut = vi.fn();

async function render() {
  root ??= createRoot(container);
  await act(async () => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RfqPanel, { email: inbound, session, onSignedOut }),
      ),
    );
  });
  await settle();
}
/** React Query notifies through a setTimeout(0): wait one macrotask for a query or mutation to settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function button(name: string) {
  return [...container.querySelectorAll('button')].find(
    (candidate) =>
      candidate.textContent?.includes(name) || candidate.getAttribute('aria-label') === name,
  );
}
async function click(name: string) {
  const target = button(name);
  if (!target) throw new Error(`no button "${name}"`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}
async function tickContact(contactName: string) {
  const label = [...container.querySelectorAll('.rfqContacts label')].find((candidate) =>
    candidate.textContent?.includes(contactName),
  );
  if (!label) throw new Error(`no contact "${contactName}"`);
  await act(async () => {
    label.querySelector('input')!.click();
  });
}
async function pickFiles(...names: string[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', {
    value: names.map((name) => new File(['x'], name, { type: 'application/pdf' })),
    configurable: true,
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
function attachedFileNames() {
  return [...container.querySelectorAll('[aria-label="Attached files"] .attachedFileName')].map(
    (chip) => chip.textContent,
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onSignedOut.mockReset();
  uploaded.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('RfqPanel attachments', () => {
  it('sends the attached files by id, freezes them with the request, and starts the next request without them', async () => {
    acceptUploads();
    const sendRfq = stubFormBackend();
    await render();
    await click('Request vendor quotes');
    await tickContact('Asha Rao');
    await click('Write vendor mails');
    expect(button('Send to 1 contact')).toBeDefined();

    await pickFiles('rates.pdf', 'terms.pdf');
    expect(attachedFileNames()).toEqual(['rates.pdf', 'terms.pdf']);

    await click('Send to 1 contact');
    const [, firstRfqId, firstBody] = sendRfq.mock.calls[0]!;
    expect(firstBody.attachmentIds).toEqual([...uploaded.keys()]);
    expect(firstBody.attachmentIds).toHaveLength(2);
    // Sent: the files stay listed but can no longer be changed.
    expect(attachedFileNames()).toEqual(['rates.pdf', 'terms.pdf']);
    expect(button('Attach files')!.disabled).toBe(true);
    expect(button('Remove rates.pdf')!.disabled).toBe(true);

    await click('Start another request for this message');
    expect(attachedFileNames()).toEqual([]);
    expect(button('Attach files')!.disabled).toBe(false);
    await click('Send to 1 contact');
    const [, secondRfqId, secondBody] = sendRfq.mock.calls[1]!;
    expect(secondRfqId).not.toBe(firstRfqId);
    expect(secondBody).not.toHaveProperty('attachmentIds');
  });

  it('hides the attachments field after a send without files', async () => {
    const sendRfq = stubFormBackend();
    await render();
    await click('Request vendor quotes');
    await tickContact('Asha Rao');
    await click('Write vendor mails');
    expect(button('Attach files')).toBeDefined();

    await click('Send to 1 contact');
    expect(sendRfq.mock.calls[0]![2]).not.toHaveProperty('attachmentIds');
    expect(button('Attach files')).toBeUndefined();
  });

  it('lists the files an earlier request carried in its record, without a way to remove them', async () => {
    const rateCard: OutboundAttachmentResponse = {
      id: '00000000-0000-4000-8000-0000000000a1',
      fileName: 'Rate card.pdf',
      contentType: 'application/pdf',
      sizeBytes: 40_960,
      createdAt: '2026-11-22T09:30:00.000Z',
    };
    const earlier = rfqResult('00000000-0000-4000-8000-000000000051', [rateCard]);
    vi.spyOn(frontendApi, 'rfqBySourceEmail').mockResolvedValue(earlier);
    vi.spyOn(frontendApi, 'vendors').mockResolvedValue({ vendors: [carrier] });
    await render();

    await click('Vendor quotes: 1 vendor asked, none replied yet');
    expect(attachedFileNames()).toEqual(['Rate card.pdf']);
    expect(container.textContent).toContain('Every vendor mail carried these files.');
    expect(container.textContent).toContain('40 KB');
    expect(button('Remove Rate card.pdf')).toBeUndefined();
  });
});
