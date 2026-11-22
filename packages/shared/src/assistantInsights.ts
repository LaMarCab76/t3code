export const ASSISTANT_INSIGHT_OPENING = /^( {0,3})(`?)★ Insight[ \t]+─{3,}\2[ \t]*$/u;

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return (
    text.includes("★ Insight") &&
    text.split(/\r\n|\r|\n/u).some((line) => ASSISTANT_INSIGHT_OPENING.test(line))
  );
}
