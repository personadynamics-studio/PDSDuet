/** Keep each reply intact; Markdown handles paragraphs inside the same bubble. */
export function splitBubbles(text: string): string[] {
  return [text];
}
