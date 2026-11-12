import { sanitizeEmailImageCandidates } from './emailImageCandidates.js';
import { isEmailMediaHeightIndependent } from './emailMedia.js';

interface ResponsiveImageSource {
  srcset: string;
  sizes: string | null;
  media: string | null;
  type: string | null;
}

interface PreparedEmailImage {
  src: string;
  srcset: string;
  sizes: string | null;
  sources: ResponsiveImageSource[];
}

function stableImageSelection(value: string | null): string | null {
  return value && !isEmailMediaHeightIndependent(value) ? null : value;
}

/** Letter strips srcset/picture. Preserve only validated image metadata across that boundary. */
export function prepareEmailResponsiveImages(
  document: Document,
  resolveUrl: (url: string) => string,
  markerPrefix: string,
) {
  const images = new Map<string, PreparedEmailImage>();
  for (const image of document.querySelectorAll('img')) {
    const sources: ResponsiveImageSource[] = [];
    if (image.parentElement?.tagName === 'PICTURE') {
      for (const sibling of image.parentElement.children) {
        if (sibling === image) break;
        if (sibling.tagName !== 'SOURCE') continue;
        const media = sibling.getAttribute('media');
        if (media && !stableImageSelection(media)) continue;
        const srcset = sanitizeEmailImageCandidates(
          sibling.getAttribute('srcset') ?? '',
          resolveUrl,
        );
        if (srcset)
          sources.push({
            srcset,
            sizes: stableImageSelection(sibling.getAttribute('sizes')),
            media,
            type: sibling.getAttribute('type'),
          });
      }
    }
    const marker = `${markerPrefix}${images.size}`;
    images.set(marker, {
      src: resolveUrl(image.getAttribute('src') ?? ''),
      srcset: sanitizeEmailImageCandidates(image.getAttribute('srcset') ?? '', resolveUrl),
      sizes: stableImageSelection(image.getAttribute('sizes')),
      sources,
    });
    image.setAttribute('src', marker);
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
  }
  // Never carry source through Letter or allow it outside a reconstructed picture.
  for (const source of document.querySelectorAll('source')) source.remove();
  return {
    hasMarker: (value: string) => images.has(value),
    restore: (fragment: DocumentFragment) => {
      for (const image of fragment.querySelectorAll('img')) {
        const metadata = images.get(image.getAttribute('src') ?? '');
        image.removeAttribute('src');
        if (!metadata) continue;
        if (metadata.src) image.setAttribute('src', metadata.src);
        if (metadata.srcset) image.setAttribute('srcset', metadata.srcset);
        if (metadata.sizes) image.setAttribute('sizes', metadata.sizes);
        if (metadata.sources.length) {
          const picture = fragment.ownerDocument.createElement('picture');
          for (const source of metadata.sources) {
            const element = fragment.ownerDocument.createElement('source');
            element.setAttribute('srcset', source.srcset);
            if (source.sizes) element.setAttribute('sizes', source.sizes);
            if (source.media) element.setAttribute('media', source.media);
            if (source.type) element.setAttribute('type', source.type);
            picture.append(element);
          }
          image.replaceWith(picture);
          picture.append(image);
        }
      }
    },
  };
}
