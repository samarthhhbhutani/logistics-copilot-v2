import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from './htmlToPlainText.js';

describe('htmlToPlainText', () => {
  it('turns block elements into paragraph breaks, <br> into a line break, decodes entities', () => {
    expect(
      htmlToPlainText('<p>Hi&nbsp;team,</p><div>Rate: USD&nbsp;1,100 &amp; up</div><br>Bye'),
    ).toBe('Hi team,\n\nRate: USD 1,100 & up\n\nBye');
  });

  it('drops script, style, comments and images; keeps link text without the href', () => {
    expect(
      htmlToPlainText(
        '<style>p{}</style><script>x()</script><!-- c --><p>See <a href="https://x.example/r">our rates</a> <img src="cid:logo" alt="logo"></p>',
      ),
    ).toBe('See our rates');
  });

  it('decodes numeric and named entities beyond the common few', () => {
    expect(htmlToPlainText('A &rarr; B &#x20B9; 5 &hellip;')).toBe('A → B ₹ 5 …');
  });

  it('renders a table one row per line with cells separated', () => {
    const text = htmlToPlainText(
      '<table><tr><th>POL</th><th>40HC</th></tr><tr><td>Nhava Sheva</td><td>USD 1,750</td></tr></table>',
    );
    expect(text.split('\n')).toEqual(['POL 40HC', 'Nhava Sheva USD 1,750']);
  });

  it('does not wrap long lines', () => {
    const longLine = 'word '.repeat(60).trim();
    expect(htmlToPlainText(`<p>${longLine}</p>`)).toBe(longLine);
  });

  describe('removeQuotedHistory', () => {
    it('keeps quoted markup by default, rendered as "> " lines like a text client would', () => {
      const html = '<div>New text</div><blockquote>old</blockquote>';
      expect(htmlToPlainText(html)).toBe('New text\n\n> old');
    });

    it('removes Gmail quote containers and blockquotes when asked', () => {
      const html =
        '<div>New text</div><div class="gmail_quote"><div class="gmail_attr">On Mon wrote:</div><blockquote>old</blockquote></div>';
      expect(htmlToPlainText(html, { removeQuotedHistory: true })).toBe('New text');
    });

    it('removes the Outlook reply header block and everything after it when asked', () => {
      const html =
        '<div>New text</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> x</div><div>old</div>';
      expect(htmlToPlainText(html, { removeQuotedHistory: true })).toBe('New text');
    });
  });
});
