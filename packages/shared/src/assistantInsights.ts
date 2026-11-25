export const ASSISTANT_INSIGHT_OPENING = /^( {0,3})(`?)★ Insight[ \t]+─{3,}\2[ \t]*$/u;

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  if (!text.includes("★ Insight")) return false;
  return (
    /^★ Insight(?:\s|─)|(?<![^\r\n])`★ Insight[ \t]+─{3,}`[ \t]*(?![^\r\n])/mu.test(text) ||
    text.split(/\r\n|\r|\n/u).some((line) => ASSISTANT_INSIGHT_OPENING.test(line))
  );
}
