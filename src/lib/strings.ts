export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function splitClaimAndReasoning(text: string): { claim: string; reasoning: string } | null {
  const match = /\bbecause\b/i.exec(text);
  if (!match || match.index === undefined) {
    return null;
  }

  const claim = normalizeWhitespace(text.slice(0, match.index));
  const reasoning = normalizeWhitespace(text.slice(match.index + match[0].length));

  if (!claim || !reasoning) {
    return null;
  }

  return { claim, reasoning };
}

export function normalizeClaimKey(claim: string): string {
  return normalizeWhitespace(claim)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

export function slugify(value: string, maxLength = 60): string {
  const slug = value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug.slice(0, maxLength) || "item";
}
