/** One mailbox as it appears in From/To/Cc. Groups (RFC 5322 "undisclosed-recipients:;") are flattened. */
export interface EmailAddress {
  /** Display name, empty string when the header had only the address. */
  name: string;
  /** Lowercased, so comparisons with mailbox addresses need no normalisation. */
  address: string;
}

export interface ParsedAttachment {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  content: Uint8Array;
  /** Set for images referenced from the HTML body (cid:...), which are not real attachments to a user. */
  contentId: string | undefined;
  isInline: boolean;
}

/**
 * What the process Lambda needs from one RFC 822 message: enough to store, display, thread and
 * classify it. Header names are lowercased keys; multi-valued headers (Received) keep the first.
 */
export interface ParsedEmail {
  messageId: string | undefined;
  /**
   * Message-ID of the message replied to. Thread linking uses Gmail's threadId first and this
   * second; the References chain is not surfaced because Gmail's threading already encodes it.
   */
  inReplyTo: string | undefined;
  from: EmailAddress | undefined;
  replyTo: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  /** The Date header; undefined when missing or unparseable (the caller falls back to Gmail's internalDate). */
  date: Date | undefined;
  /**
   * Plain-text body. Taken from the text/plain part when present, otherwise derived from the HTML
   * so every mail has text for display, classification and extraction.
   */
  text: string;
  /** The text/html part as sent, undefined for text-only mail. Sanitised by the frontend, not here. */
  html: string | undefined;
  attachments: ParsedAttachment[];
  headers: Record<string, string>;
}
