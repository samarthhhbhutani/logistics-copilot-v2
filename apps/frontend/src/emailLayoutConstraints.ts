/** Normalize only sanitized CSS, retaining the sender cascade and preferred cell widths. */
const constrainedElements = 'table,div,p,pre,blockquote,center,ul,ol,li,h1,h2,h3,h4,h5,h6,img';
const constrainedSelector = `:where(${constrainedElements})`;
const cellSelector = ':where(td,th,col,colgroup)';

function boundedWidth(value: string): string | undefined {
  // Keywords (including auto/inherit) are not valid arguments to min().
  return /^(?:\d*\.?\d+(?:px|pt|pc|in|cm|mm|q|em|rem|ex|ch|vw|%)?$|(?:calc|min|max|clamp)\()/i.test(
    value,
  )
    ? `min(100%, ${value})`
    : undefined;
}

/** Keep selector-list specificity: :is(a, #b) would incorrectly promote a to ID specificity. */
function splitSelectors(selectorText: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let index = 0; index < selectorText.length; index += 1) {
    const character = selectorText[index];
    if (character === '\\') {
      index += 1;
    } else if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(' || character === '[') {
      depth += 1;
    } else if (character === ')' || character === ']') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      selectors.push(selectorText.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(selectorText.slice(start).trim());
  return selectors;
}

function normalizeStyle(style: CSSStyleDeclaration, constrainWidth: boolean) {
  for (const property of ['width', 'min-width', 'max-width']) {
    if (property !== 'min-width' && !constrainWidth) continue;
    const bounded = boundedWidth(style.getPropertyValue(property));
    if (bounded) style.setProperty(property, bounded, style.getPropertyPriority(property));
  }
}

function normalizeRules(rules: CSSRuleList): string {
  return Array.from(rules)
    .flatMap((rule) => {
      if (rule.type === 4) {
        const media = rule as CSSMediaRule;
        return [`@media ${media.conditionText} { ${normalizeRules(media.cssRules)} }`];
      }
      if (rule.type !== 1) return [rule.cssText];
      const styleRule = rule as CSSStyleRule;
      const original = styleRule.cssText;
      const declarations = ['width', 'min-width', 'max-width']
        .flatMap((property) => {
          const bounded = boundedWidth(styleRule.style.getPropertyValue(property));
          if (!bounded) return [];
          const priority = styleRule.style.getPropertyPriority(property) ? ' !important' : '';
          return [`${property}: ${bounded}${priority};`];
        })
        .join(' ');
      if (!declarations) return [original];
      // Generated after Letter's selector scoping, which cannot parse commas inside :where().
      const selectors = splitSelectors(styleRule.selectorText)
        .filter((selector) => !selector.includes('::'))
        .map((selector) => `:is(${selector})${constrainedSelector}`);
      const minimum = boundedWidth(styleRule.style.getPropertyValue('min-width'));
      const cellRules = minimum
        ? splitSelectors(styleRule.selectorText)
            .filter((selector) => !selector.includes('::'))
            .map(
              (selector) =>
                `:is(${selector})${cellSelector} { min-width: ${minimum}${styleRule.style.getPropertyPriority('min-width') ? ' !important' : ''}; }`,
            )
        : [];
      return selectors.length
        ? [original, `${selectors.join(',')} { ${declarations} }`, ...cellRules]
        : [original];
    })
    .join('\n');
}

/** Run after the security sanitizers. Adds only width constraints, never resources or executable code. */
export function constrainEmailLayout(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const element of document.querySelectorAll('style')) {
    if (element.sheet)
      // CSSOM can decode CSS escapes. Never serialize a literal HTML end tag into style text.
      element.textContent = normalizeRules(element.sheet.cssRules).replace(/</g, '\\3c ');
  }
  for (const cell of document.querySelectorAll<HTMLElement>('td,th,col,colgroup'))
    normalizeStyle(cell.style, false);
  const attributeRules: string[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(constrainedElements)) {
    normalizeStyle(element.style, true);
    const width = element.getAttribute('width')?.trim();
    if (width && /^(?:\d*\.?\d+)(?:%|px)?$/i.test(width)) {
      // Presentational width attributes rank below author CSS, unlike inline styles.
      const marker = String(attributeRules.length);
      element.setAttribute('data-email-layout-width', marker);
      const preferredWidth = /(?:%|px)$/i.test(width) ? width : `${width}px`;
      attributeRules.push(
        `:where([data-email-layout-width="${marker}"]) { width: min(100%, ${preferredWidth}); }`,
      );
    }
    if (element.tagName === 'IMG') element.style.setProperty('height', 'auto', 'important');
    // Fixed layout treats absolute column widths as minimums even after the table contracts.
    if (element.tagName === 'TABLE') element.style.setProperty('table-layout', 'auto', 'important');
  }
  if (attributeRules.length) {
    const style = document.createElement('style');
    style.textContent = attributeRules.join('\n');
    document.body.prepend(style);
  }
  // Letter's wrapper means its sender style elements are in body, not in the discarded head.
  return document.body.innerHTML;
}
