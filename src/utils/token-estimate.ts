/**
 * Rough size of a tool response in model tokens: JSON characters / 4, rounded up. An estimate, not a
 * tokenizer count; callers must label any figure derived from it as "estimated".
 */
export function estimateToolJsonTokens(json: string): number {
  return Math.ceil(json.length / 4);
}
