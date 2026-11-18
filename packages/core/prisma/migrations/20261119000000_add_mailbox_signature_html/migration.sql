-- The HTML signature; the plain-text "signature" column is derived from it on save and stays the text part.
ALTER TABLE "mailboxes" ADD COLUMN "signature_html" TEXT;
