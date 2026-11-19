import { describe, expect, it } from 'vitest';
import { listSignatureImageContentIds, sanitizeSignatureHtml } from './sanitizeSignatureHtml.js';

describe('sanitizeSignatureHtml', () => {
  it('keeps formatting, links, table layout, allowed styles and cid images, and derives the text part', () => {
    const sanitized = sanitizeSignatureHtml(
      '<table cellpadding="0"><tbody><tr><td valign="top"><img src="cid:logo" alt="Bhatia" width="80"></td>' +
        '<td style="color:#1a1a1a;font-size:13px"><p><b>Ops Desk</b><br>Bhatia Logistics<br>' +
        '<a href="https://bhatia.example">bhatia.example</a> · <a href="mailto:ops@bhatia.example">ops@bhatia.example</a></p></td></tr></tbody></table>',
      ['logo'],
    );
    expect(sanitized.signatureHtml).toBe(
      '<table cellpadding="0"><tbody><tr><td valign="top"><img src="cid:logo" alt="Bhatia" width="80" /></td>' +
        '<td style="color:#1a1a1a;font-size:13px"><p><b>Ops Desk</b><br />Bhatia Logistics<br />' +
        '<a href="https://bhatia.example">bhatia.example</a> · <a href="mailto:ops@bhatia.example">ops@bhatia.example</a></p></td></tr></tbody></table>',
    );
    expect(sanitized.signature).toContain('Ops Desk');
    expect(sanitized.signature).toContain('Bhatia Logistics');
    expect(sanitized.signature).toContain('bhatia.example');
    expect(sanitized.signature).not.toContain('<');
  });

  it('drops scripts, event handlers, javascript: links, remote images and unknown styles', () => {
    const sanitized = sanitizeSignatureHtml(
      '<p onclick="steal()" style="position:absolute;color:red">Ops Desk</p>' +
        '<script>steal()</script>' +
        '<a href="javascript:steal()">site</a>' +
        '<img src="https://tracker.example/pixel.gif">' +
        '<img src="cid:logo">' +
        '<iframe src="https://evil.example"></iframe>',
      ['logo'],
    );
    expect(sanitized.signatureHtml).toBe(
      '<p style="color:red">Ops Desk</p><a>site</a><img src="cid:logo" />',
    );
    expect(sanitized.signature).toBe('Ops Desk\n\nsite');
  });

  it('clears the signature when nothing visible survives, and keeps an image-only signature', () => {
    expect(sanitizeSignatureHtml(null, [])).toEqual({ signatureHtml: null, signature: null });
    expect(sanitizeSignatureHtml('', [])).toEqual({ signatureHtml: null, signature: null });
    expect(sanitizeSignatureHtml('<p>  </p><script>x()</script>', [])).toEqual({
      signatureHtml: null,
      signature: null,
    });
    expect(sanitizeSignatureHtml('<img src="cid:logo" alt="">', ['logo'])).toEqual({
      signatureHtml: '<img src="cid:logo" alt="" />',
      signature: null,
    });
  });

  it('drops a cid image the mailbox does not own, whole', () => {
    expect(
      sanitizeSignatureHtml('<p>Ops</p><img src="cid:logo"><img src="cid:badge">', ['badge']),
    ).toEqual({
      signatureHtml: '<p>Ops</p><img src="cid:badge" />',
      signature: 'Ops',
    });
    expect(sanitizeSignatureHtml('<img src="cid:logo">', [])).toEqual({
      signatureHtml: null,
      signature: null,
    });
  });

  it('lists the cid references in document order', () => {
    expect(
      listSignatureImageContentIds(
        '<img src="cid:logo"><p>x</p><img alt="b" src="cid:badge"><img src="https://x.example/a.png">',
      ),
    ).toEqual(['logo', 'badge']);
    expect(listSignatureImageContentIds('<p>no images</p>')).toEqual([]);
  });
});
