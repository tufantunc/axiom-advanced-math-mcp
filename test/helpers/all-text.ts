/**
 * Every text part of a tool response, one per line — what a caller reads.
 *
 * Shared because the same three lines had been copied into a test file at a
 * time; the copies elsewhere are older than this helper and move to it as
 * their files are next touched.
 */
export function allText(response: { content: { text: string }[] }): string {
  return response.content.map((c) => c.text).join('\n');
}
