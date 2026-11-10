import type { GmailLabel as PrismaGmailLabel } from '../db/generated/client.js';
import type { EmailAddress } from '../utils/mime/parsedEmail.js';
import {
  CLASSIFICATION_LABEL_BY_PRISMA_LABEL,
  CLASSIFICATION_SOURCE_BY_PRISMA_SOURCE,
} from '../classification/classificationLabel.js';
import type {
  ClassificationLabel,
  ClassificationSource,
} from '../classification/classificationLabel.js';

/** Which Gmail folder the message arrived in; snake_case like every other enum the API speaks. */
export type GmailLabel = 'inbox' | 'sent';

/** One row of the inbox list: everything the list view shows, no bodies. */
export interface EmailSummary {
  id: string;
  gmailThreadId: string;
  gmailLabel: GmailLabel;
  senderName: string;
  senderEmail: string | null;
  toRecipients: EmailAddress[];
  subject: string;
  snippet: string;
  receivedAt: Date;
}

/** The newest classifications row of an email: what the desk currently calls it and who said so. */
export interface CurrentClassification {
  label: ClassificationLabel;
  source: ClassificationSource;
  confidence: number | null;
  classifiedAt: Date;
}

/** One mail in full, for the detail and thread views. */
export interface EmailDetail extends EmailSummary {
  ccRecipients: EmailAddress[];
  rfcMessageId: string | null;
  bodyText: string;
  bodyHtml: string | null;
  classification: CurrentClassification | null;
}

// Prisma generates UPPER_CASE enum members; the API and the column speak snake_case.
export const PRISMA_ENUM_BY_SNAKE_CASE_LABEL: Record<GmailLabel, PrismaGmailLabel> = {
  inbox: 'INBOX',
  sent: 'SENT',
};
export const SNAKE_CASE_LABEL_BY_PRISMA_ENUM: Record<PrismaGmailLabel, GmailLabel> = {
  INBOX: 'inbox',
  SENT: 'sent',
};

/** The jsonb column holds what toJsonAddresses wrote; anything else is treated as no recipients. */
export function fromJsonAddresses(value: unknown): EmailAddress[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { name, address } = entry as Record<string, unknown>;
    return typeof name === 'string' && typeof address === 'string' ? [{ name, address }] : [];
  });
}

/**
 * Postgres refuses the NUL character in text and jsonb columns; malformed mail (a mislabelled
 * UTF-16 part, say) can carry one. Dropping it keeps the row insertable; the raw .eml is intact.
 */
export function withoutNulCharacters(text: string): string {
  return text.replaceAll('\u0000', '');
}

/** Prisma's Json input wants plain object literals; an interface type without an index signature is refused. */
export function toJsonAddresses(addresses: EmailAddress[]): { name: string; address: string }[] {
  return addresses.map(({ name, address }) => ({
    name: withoutNulCharacters(name),
    address: withoutNulCharacters(address),
  }));
}

/**
 * The newest classifications row of the parent email; Prisma scopes the nested select to that email, and the
 * parent query already carries the tenant filter. The id tie-breaker only makes the pick deterministic when
 * two rows share a classified_at; it carries no ordering meaning.
 */
export const CURRENT_CLASSIFICATION_SELECT = {
  orderBy: [{ classifiedAt: 'desc' as const }, { id: 'desc' as const }],
  take: 1,
  select: { label: true, source: true, confidence: true, classifiedAt: true },
};

export const EMAIL_DETAIL_SELECT = {
  id: true,
  gmailThreadId: true,
  gmailLabel: true,
  senderName: true,
  senderEmail: true,
  toRecipients: true,
  ccRecipients: true,
  subject: true,
  snippet: true,
  receivedAt: true,
  rfcMessageId: true,
  bodyText: true,
  bodyHtml: true,
  classifications: CURRENT_CLASSIFICATION_SELECT,
};

export type CurrentClassificationRow = {
  label: keyof typeof CLASSIFICATION_LABEL_BY_PRISMA_LABEL;
  source: keyof typeof CLASSIFICATION_SOURCE_BY_PRISMA_SOURCE;
  confidence: number | null;
  classifiedAt: Date;
};

export type EmailDetailRow = {
  id: string;
  gmailThreadId: string;
  gmailLabel: PrismaGmailLabel;
  senderName: string;
  senderEmail: string | null;
  toRecipients: unknown;
  ccRecipients: unknown;
  subject: string;
  snippet: string;
  receivedAt: Date;
  rfcMessageId: string | null;
  bodyText: string;
  bodyHtml: string | null;
  classifications: CurrentClassificationRow[];
};

export function toCurrentClassification(
  rows: CurrentClassificationRow[],
): CurrentClassification | null {
  const row = rows[0];
  if (!row) return null;
  return {
    label: CLASSIFICATION_LABEL_BY_PRISMA_LABEL[row.label],
    source: CLASSIFICATION_SOURCE_BY_PRISMA_SOURCE[row.source],
    confidence: row.confidence,
    classifiedAt: row.classifiedAt,
  };
}

export function toEmailDetail(row: EmailDetailRow): EmailDetail {
  return {
    id: row.id,
    gmailThreadId: row.gmailThreadId,
    gmailLabel: SNAKE_CASE_LABEL_BY_PRISMA_ENUM[row.gmailLabel],
    senderName: row.senderName,
    senderEmail: row.senderEmail,
    toRecipients: fromJsonAddresses(row.toRecipients),
    ccRecipients: fromJsonAddresses(row.ccRecipients),
    subject: row.subject,
    snippet: row.snippet,
    receivedAt: row.receivedAt,
    rfcMessageId: row.rfcMessageId,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    classification: toCurrentClassification(row.classifications),
  };
}
