/**
 * Shared input bounds for the MCP tool surface.
 *
 * Every tool takes a free-text mathematical expression and feeds it to an
 * evaluator. The transport's 1 MB body cap is far too generous for that.
 *
 * Both evaluators are now bounded out of process, so this cap is no longer what
 * stands between a caller and a stalled event loop. It still earns its place:
 * the preprocessing in quick-calc-preprocessor.ts is regex work on the main
 * thread, which no worker timeout reaches, and parse cost grows with input size
 * before any of the out-of-process bounds apply.
 *
 * 8 KB is generous for real CAS input — the largest legitimate case is a
 * regression dataset written inline — while keeping the worst case bounded.
 */
export const MAX_EXPRESSION_LENGTH = 8192;
