/** Height-dependent conditions can oscillate when the email frame resizes to fit its content. */
export function isEmailMediaHeightIndependent(value: string): boolean {
  return !/\\|height|aspect-ratio|orientation|(?:\d|\.)\s*(?:[sld]?v|cq)(?:h|b|min|max)\b/i.test(
    value,
  );
}
