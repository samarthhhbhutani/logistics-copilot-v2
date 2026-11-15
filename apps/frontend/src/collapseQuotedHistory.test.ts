// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { collapseQuotedHistory } from './collapseQuotedHistory.js';

function parse(html: string) {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
}
function folded(html: string) {
  return parse(html).querySelector('details.quotedHistory');
}

describe('collapseQuotedHistory', () => {
  it('folds a Gmail quote, attribution included, behind a details toggle and keeps the reply text outside', () => {
    const html =
      '<div dir="ltr">Thread UI test</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Sun, 15 Nov 2026 at 2:48 PM, Samarth &lt;s@example.com&gt; wrote:<br></div><blockquote class="gmail_quote">Dear Sir, please quote.</blockquote></div>';
    const body = parse(collapseQuotedHistory(html));
    const details = body.querySelector('details.quotedHistory')!;
    expect(details).not.toBeNull();
    expect(details.querySelector('summary')?.textContent).toBe('Show quoted textHide quoted text');
    expect(details.querySelector('.gmail_quote_container')).not.toBeNull();
    expect(details.textContent).toContain('Dear Sir, please quote.');
    expect(body.firstElementChild?.textContent).toBe('Thread UI test');
    expect(body.textContent).toContain('Thread UI test');
  });

  it('matches the Gmail quote container when Gmail has scoped its class names', () => {
    const html =
      '<div id="msg_ABC"><div dir="auto">Thread UI test</div><div dir="auto"><br><div class="msg_ABC_gmail_quote msg_ABC_gmail_quote_container"><div class="msg_ABC_gmail_attr">On Sun wrote:<br></div><blockquote class="msg_ABC_gmail_quote">Old</blockquote></div></div></div>';
    const details = folded(collapseQuotedHistory(html))!;
    expect(details.firstElementChild?.nextElementSibling?.className).toBe(
      'msg_ABC_gmail_quote msg_ABC_gmail_quote_container',
    );
    expect(details.parentElement?.querySelector('details')).toBe(details);
  });

  it('folds an Outlook reply header and everything after it', () => {
    const html =
      '<div>Thanks, noted.</div><div id="divRplyFwdMsg" dir="ltr"><b>From:</b> a@example.com</div><div>Original text</div><div>More original</div>';
    const details = folded(collapseQuotedHistory(html))!;
    expect(details.textContent).toContain('From:');
    expect(details.textContent).toContain('More original');
    expect(details.previousSibling?.textContent).toBe('Thanks, noted.');
  });

  it('folds an Apple Mail cite blockquote with the "wrote:" line before it', () => {
    const html =
      '<div>Sure.</div><div>On 15 Nov 2026, at 14:48, Ravi wrote:</div><blockquote type="cite"><div>Can you quote?</div></blockquote>';
    const details = folded(collapseQuotedHistory(html))!;
    expect(details.textContent).toContain('Ravi wrote:');
    expect(details.textContent).toContain('Can you quote?');
  });

  it('folds a plain last blockquote only when an attribution line introduces it', () => {
    const introduced =
      '<p>Agreed.</p><p>----- Original Message -----</p><blockquote>Old text</blockquote>';
    expect(folded(collapseQuotedHistory(introduced))).not.toBeNull();
    const standalone =
      '<p>Agreed.</p><blockquote>A pull quote the sender wrote themselves</blockquote>';
    expect(collapseQuotedHistory(standalone)).toBe(standalone);
    const sentenceEndingInWrote =
      '<p>Agreed.</p><p>For context, here is the long explanation the supplier sent us last week about the demurrage waiver, which they wrote:</p><blockquote>Their text</blockquote>';
    expect(collapseQuotedHistory(sentenceEndingInWrote)).toBe(sentenceEndingInWrote);
  });

  it('leaves a bare forward alone: nothing of the sender before the quote', () => {
    const html =
      '<div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br></div><blockquote>Body</blockquote></div>';
    expect(collapseQuotedHistory(html)).toBe(html);
    expect(collapseQuotedHistory('<p>Just text</p>')).toBe('<p>Just text</p>');
  });
});
