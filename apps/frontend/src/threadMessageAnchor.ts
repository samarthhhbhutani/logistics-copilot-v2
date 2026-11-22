/**
 * The DOM id of a message's <details> on the thread view, so a copilot citation chip can open and
 * scroll to it. Its own module: the thread view renders the composer, which renders the chips.
 */
export function threadMessageElementId(emailId: string): string {
  return `message-${emailId}`;
}
