export interface GiacEngine {
  initialize(): Promise<void>;
  evaluate(expression: string): Promise<string>;
  /**
   * Clears Giac's global session state (`sto` assignments, `assume`
   * hypotheses, `purge`d/redefined symbols) so the next evaluation starts
   * from a pristine engine. Call at the MCP tool-call boundary, never
   * per-evaluate: one tool call legitimately makes several Giac calls
   * (result + latex + verification pass) that must share one session.
   */
  reset(): Promise<void>;
  isReady(): boolean;
}
