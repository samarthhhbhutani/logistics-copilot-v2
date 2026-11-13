/** Leading reply/forward markers in any mix and case: "Re:", "RE: Re:", "Fwd:", "FW:". Localised ones (AW:, SV:) are out of scope. */
const REPLY_PREFIX_CHAIN = /^(\s*(re|fwd?)\s*:\s*)+/i;

/**
 * Subject for a reply: exactly one "Re: " in front of the original subject with any existing
 * Re/Fwd chain removed, so a long thread never grows "Re: Re: Re:". Hand-rolled: a mail
 * composer builds headers, it does not know reply conventions, and this is the whole rule.
 */
export function replySubject(originalSubject: string): string {
  const bareSubject = originalSubject.replace(REPLY_PREFIX_CHAIN, '').trim();
  return `Re: ${bareSubject}`;
}
