import { useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Italic, Link2, Underline } from 'lucide-react';
import type { MailboxResponse, SessionResponse } from '@lc/contract';
import { errorMessage, frontendApi } from './frontendApi.js';

/**
 * The HTML signature appended to every reply and RFQ mail. Only what the server keeps is offered:
 * paragraphs, bold, italic, underline and links. Headings, lists and code would be stripped on
 * save, so their nodes are switched off instead of shown and then lost.
 */
export function SignatureEditor({
  session,
  mailbox,
}: {
  session: SessionResponse;
  mailbox: MailboxResponse;
}) {
  const queryClient = useQueryClient();
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        strike: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      }),
    ],
    content: mailbox.signatureHtml ?? '',
    editorProps: {
      attributes: { class: 'signatureEditorContent', 'aria-label': 'Email signature' },
    },
    onUpdate: () => setSaved(false),
  });
  // TipTap does not re-render on every transaction; read the bits the toolbar shows.
  const marks = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      underline: current.isActive('underline'),
      link: current.isActive('link'),
      linkHref: current.getAttributes('link')['href'] as unknown,
      isEmpty: current.isEmpty,
    }),
  });

  const save = useMutation({
    mutationFn: (signatureHtml: string | null) =>
      frontendApi.updateSignature(session, signatureHtml),
    onSuccess: (updated) => {
      queryClient.setQueryData(['mailbox', session.tenantId, session.mailboxId], updated);
      // What the server kept, not what was typed: the sanitiser may have dropped something.
      editor?.commands.setContent(updated.signatureHtml ?? '');
      setSaved(true);
    },
  });

  if (!editor || !marks) return null;
  function applyLink() {
    if (!editor) return;
    const url = linkUrl?.trim() ?? '';
    const chain = editor.chain().focus().extendMarkRange('link');
    if (url) chain.setLink({ href: url }).run();
    else chain.unsetLink().run();
    setLinkUrl(null);
  }
  return (
    <section className="signatureEditor" aria-labelledby="signature-title">
      <p className="eyebrow">Email signature</p>
      <h2 id="signature-title">Signature</h2>
      <p>Added to the end of every reply and vendor request sent from this mailbox.</p>
      <div className="signatureToolbar" role="toolbar" aria-label="Formatting">
        <ToolbarButton
          label="Bold"
          active={marks.bold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={16} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="Italic"
          active={marks.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={16} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="Underline"
          active={marks.underline}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <Underline size={16} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="Link"
          active={marks.link}
          onClick={() => {
            const current = typeof marks.linkHref === 'string' ? marks.linkHref : '';
            setLinkUrl(linkUrl === null ? current : null);
          }}
        >
          <Link2 size={16} aria-hidden="true" />
        </ToolbarButton>
      </div>
      {linkUrl !== null && (
        <form
          className="signatureLinkForm"
          onSubmit={(event) => {
            event.preventDefault();
            applyLink();
          }}
        >
          <label>
            Link address
            <input
              type="url"
              value={linkUrl}
              placeholder="https://"
              autoFocus
              onChange={(event) => setLinkUrl(event.target.value)}
            />
          </label>
          <button type="submit" className="button secondary">
            {linkUrl.trim() ? 'Apply link' : 'Remove link'}
          </button>
        </form>
      )}
      <EditorContent editor={editor} />
      {save.error && (
        <p className="formError" role="alert">
          {errorMessage(save.error)}
        </p>
      )}
      <div className="signatureActions">
        <button
          className="button primary"
          aria-disabled={save.isPending}
          onClick={() => {
            if (!save.isPending) save.mutate(marks.isEmpty ? null : editor.getHTML());
          }}
        >
          {save.isPending ? 'Saving…' : 'Save signature'}
        </button>
        <button
          className="button textButton"
          aria-disabled={save.isPending || marks.isEmpty}
          onClick={() => {
            if (!save.isPending && !marks.isEmpty) save.mutate(null);
          }}
        >
          Remove signature
        </button>
        {saved && !save.isPending && (
          <span className="finePrint" role="status">
            Saved
          </span>
        )}
      </div>
    </section>
  );
}

function ToolbarButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`toolbarButton ${active ? 'active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
      // Keep the caret in the editor: the click formats the selection, it must not steal focus.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
