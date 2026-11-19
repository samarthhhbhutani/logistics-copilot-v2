import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import Image from '@tiptap/extension-image';
import StarterKit from '@tiptap/starter-kit';
import { Bold, ImagePlus, Italic, Link2, Trash2, Underline } from 'lucide-react';
import type { MailboxResponse, SessionResponse, SignatureImageResponse } from '@lc/contract';
import {
  SIGNATURE_IMAGE_CONTENT_TYPES,
  SIGNATURE_IMAGE_MAX_BYTES,
  SIGNATURE_IMAGES_MAX_PER_MAILBOX,
} from '@lc/contract';
import { errorMessage, frontendApi } from './frontendApi.js';
import {
  contentIdsToPreviewUrls,
  previewUrlsToContentIds,
  referencedContentIds,
} from './signatureImageReferences.js';

/**
 * The HTML signature appended to every reply and RFQ mail. Only what the server keeps is offered:
 * paragraphs, bold, italic, underline, links and the mailbox's own uploaded images. Headings,
 * lists and code would be stripped on save, so their nodes are switched off instead of shown and
 * then lost. The editor needs the image list before it can show a stored `cid:` image, so it is
 * mounted once both have loaded.
 */
export function SignatureEditor({
  session,
  mailbox,
}: {
  session: SessionResponse;
  mailbox: MailboxResponse;
}) {
  const images = useQuery({
    queryKey: signatureImagesQueryKey(session),
    queryFn: ({ signal }) => frontendApi.signatureImages(session, signal),
  });
  return (
    <section className="signatureEditor" aria-labelledby="signature-title">
      <p className="eyebrow">Email signature</p>
      <h2 id="signature-title">Signature</h2>
      <p>Added to the end of every reply and vendor request sent from this mailbox.</p>
      {images.data ? (
        <SignatureEditorForm session={session} mailbox={mailbox} images={images.data.images} />
      ) : images.isError ? (
        <>
          <p className="formError" role="alert">
            {errorMessage(images.error)}
          </p>
          <button className="button secondary" onClick={() => void images.refetch()}>
            Try again
          </button>
        </>
      ) : (
        <p className="finePrint" role="status">
          Loading signature…
        </p>
      )}
    </section>
  );
}

function signatureImagesQueryKey(session: SessionResponse) {
  return ['signatureImages', session.tenantId, session.mailboxId] as const;
}

function SignatureEditorForm({
  session,
  mailbox,
  images,
}: {
  session: SessionResponse;
  mailbox: MailboxResponse;
  images: readonly SignatureImageResponse[];
}) {
  const queryClient = useQueryClient();
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
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
      Image.configure({ inline: true, allowBase64: false }),
    ],
    content: contentIdsToPreviewUrls(mailbox.signatureHtml ?? '', images),
    editorProps: {
      attributes: { class: 'signatureEditorContent', 'aria-label': 'Email signature' },
      // A pasted image has no upload behind it and the server would drop it; take it out here.
      transformPastedHTML: (html) => html.replace(/<img\b[^>]*>/gi, ''),
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
      html: current.getHTML(),
    }),
  });

  const save = useMutation({
    mutationFn: (signatureHtml: string | null) =>
      frontendApi.updateSignature(session, signatureHtml),
    onSuccess: (updated) => {
      queryClient.setQueryData(['mailbox', session.tenantId, session.mailboxId], updated);
      // What the server kept, not what was typed: the sanitiser may have dropped something.
      editor?.commands.setContent(contentIdsToPreviewUrls(updated.signatureHtml ?? '', images));
      setSaved(true);
    },
  });
  const upload = useMutation({
    mutationFn: (file: File) => frontendApi.uploadSignatureImage(session, file),
    onSuccess: (image) => {
      queryClient.setQueryData(
        signatureImagesQueryKey(session),
        (current: { images: SignatureImageResponse[] } | undefined) => ({
          images: [...(current?.images ?? []), image],
        }),
      );
      editor?.chain().focus().setImage({ src: image.previewUrl, alt: image.fileName }).run();
    },
  });
  const remove = useMutation({
    mutationFn: (imageId: string) => frontendApi.deleteSignatureImage(session, imageId),
    onSuccess: (_, imageId) => {
      queryClient.setQueryData(
        signatureImagesQueryKey(session),
        (current: { images: SignatureImageResponse[] } | undefined) => ({
          images: (current?.images ?? []).filter((image) => image.id !== imageId),
        }),
      );
    },
  });

  if (!editor || !marks) return null;
  const referenced = referencedContentIds(marks.html, images);
  const atImageLimit = images.length >= SIGNATURE_IMAGES_MAX_PER_MAILBOX;
  function applyLink() {
    if (!editor) return;
    const url = linkUrl?.trim() ?? '';
    const chain = editor.chain().focus().extendMarkRange('link');
    if (url) chain.setLink({ href: url }).run();
    else chain.unsetLink().run();
    setLinkUrl(null);
  }
  return (
    <>
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
        <ToolbarButton
          label={upload.isPending ? 'Uploading image…' : 'Insert image'}
          active={false}
          disabled={upload.isPending || atImageLimit}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus size={16} aria-hidden="true" />
        </ToolbarButton>
        <input
          ref={fileInput}
          type="file"
          accept={SIGNATURE_IMAGE_CONTENT_TYPES.join(',')}
          hidden
          data-testid="signature-image-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) upload.mutate(file);
          }}
        />
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
      <p className="finePrint">
        Images: PNG, JPEG or GIF up to {SIGNATURE_IMAGE_MAX_BYTES / 1024} KB,{' '}
        {SIGNATURE_IMAGES_MAX_PER_MAILBOX} per mailbox. Pasted images are not kept; use Insert
        image.
      </p>
      {upload.error && (
        <p className="formError" role="alert">
          {errorMessage(upload.error)}
        </p>
      )}
      {images.length > 0 && (
        <ul className="signatureImageList" aria-label="Uploaded images">
          {images.map((image) => {
            const inUse = referenced.has(image.contentId);
            return (
              <li key={image.id}>
                <img src={image.previewUrl} alt="" />
                <span className="signatureImageName">{image.fileName}</span>
                {!inUse && (
                  <button
                    type="button"
                    className="button textButton"
                    onClick={() =>
                      editor
                        .chain()
                        .focus()
                        .setImage({ src: image.previewUrl, alt: image.fileName })
                        .run()
                    }
                  >
                    Insert
                  </button>
                )}
                <button
                  type="button"
                  className="button textButton"
                  aria-label={`Delete ${image.fileName}`}
                  title={inUse ? 'Remove it from the signature first' : 'Delete'}
                  aria-disabled={inUse || remove.isPending}
                  onClick={() => {
                    if (!inUse && !remove.isPending) remove.mutate(image.id);
                  }}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {remove.error && (
        <p className="formError" role="alert">
          {errorMessage(remove.error)}
        </p>
      )}
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
            if (save.isPending) return;
            save.mutate(marks.isEmpty ? null : previewUrlsToContentIds(marks.html, images));
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
    </>
  );
}

function ToolbarButton({
  label,
  active,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`toolbarButton ${active ? 'active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      aria-disabled={disabled}
      title={label}
      // Keep the caret in the editor: the click formats the selection, it must not steal focus.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {children}
    </button>
  );
}
