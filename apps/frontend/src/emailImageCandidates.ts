export interface EmailImageCandidate {
  url: string;
  descriptor: string;
}

const asciiWhitespace = /[\t\n\f\r ]/;

/** Tokenize HTML srcset, whose URL tokens can contain commas (so split(',') is unsafe). */
export function parseEmailImageCandidates(value: string): EmailImageCandidate[] {
  const candidates: EmailImageCandidate[] = [];
  let position = 0;
  while (position < value.length) {
    while (
      position < value.length &&
      (asciiWhitespace.test(value[position]!) || value[position] === ',')
    )
      position += 1;
    const urlStart = position;
    while (position < value.length && !asciiWhitespace.test(value[position]!)) position += 1;
    let url = value.slice(urlStart, position);
    if (!url) break;
    const descriptors: string[] = [];
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      let descriptor = '';
      let parentheses = 0;
      while (position < value.length) {
        const character = value[position++]!;
        if (character === '(') parentheses += 1;
        if (character === ')') parentheses = Math.max(0, parentheses - 1);
        if (character === ',' && !parentheses) break;
        if (asciiWhitespace.test(character) && !parentheses) {
          if (descriptor) descriptors.push(descriptor);
          descriptor = '';
        } else descriptor += character;
      }
      if (descriptor) descriptors.push(descriptor);
    }
    if (!url || descriptors.length > 1) continue;
    const descriptor = descriptors[0] ?? '1x';
    const width = /^(\d+)w$/.exec(descriptor);
    const density = /^((?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)x$/.exec(descriptor);
    const amount = Number(width?.[1] ?? density?.[1]);
    if (
      (!width && !density) ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      (width && !Number.isSafeInteger(amount))
    )
      continue;
    candidates.push({ url, descriptor: `${amount}${width ? 'w' : 'x'}` });
  }
  return candidates;
}

/** Each candidate uses the same URL/CID policy as img.src. Serialize only validated descriptors. */
export function sanitizeEmailImageCandidates(
  value: string,
  resolveUrl: (url: string) => string | undefined,
): string {
  const parsed = parseEmailImageCandidates(value);
  // Check the whole list before resolving URLs: discarded lists must not sign unused CIDs.
  const descriptorKinds = new Set(parsed.map((candidate) => candidate.descriptor.slice(-1)));
  if (descriptorKinds.size > 1) return '';
  const descriptors = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of parsed) {
    if (descriptors.has(candidate.descriptor)) continue;
    descriptors.add(candidate.descriptor);
    const url = resolveUrl(candidate.url);
    // A resolved URL ending with a comma cannot be represented faithfully as a srcset token.
    if (!url || /[\t\n\f\r ]|,$/.test(url)) continue;
    candidates.push(`${url} ${candidate.descriptor}`);
  }
  return candidates.join(', ');
}
