import { useLayoutEffect, useRef, useState } from 'react';
import { parseEmailFrameLayout } from './emailFrameDocument.js';

/** Remount with each document so layout messages from an old document cannot resize its replacement. */
export function EmailHtmlFrame({
  document,
  onImageFailure,
}: {
  document: string;
  onImageFailure: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(1);
  useLayoutEffect(() => {
    const receiveLayout = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const layout = parseEmailFrameLayout(event.data);
      if (!layout) return;
      setHeight(layout.height);
      if (layout.failedImageCount > 0) onImageFailure();
    };
    window.addEventListener('message', receiveLayout);
    return () => window.removeEventListener('message', receiveLayout);
  }, [onImageFailure]);
  return (
    <iframe
      ref={frame}
      title="Email message body"
      className="emailHtmlFrame"
      style={{ height }}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={document}
    />
  );
}
