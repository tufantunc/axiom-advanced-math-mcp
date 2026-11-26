/**
 * Every text part of a tool response, one per line — what a caller reads.
 *
 * Shared because the same three lines had been copied into test file after
 * test file. Import it rather than writing another copy; the inline copies
 * that remain in older files move here as those files are next touched.
 */
export function allText(response: { content: { text: string }[] }): string {
  return response.content.map((c) => c.text).join('\n');
}
