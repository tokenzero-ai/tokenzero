// Dependency-free token estimate for the CLI bundle. The analyzer only uses
// counts as thresholds ("is this prompt big enough to matter"), so a calibrated
// character heuristic is enough and keeps the CLI a single small file.
// The build swaps this in for src/tokens.ts.
import type { Provider } from '../../src/pricing.ts';

export function countTokens(text: string, _provider: Provider = 'openai'): number {
  if (!text) return 0;
  const symbols = (text.match(/[{}[\]<>=;:(),"'`]/g) ?? []).length;
  const cpt = symbols / text.length > 0.04 ? 3.2 : 4; // code/JSON tokenizes denser than prose
  return Math.ceil(text.length / cpt);
}
