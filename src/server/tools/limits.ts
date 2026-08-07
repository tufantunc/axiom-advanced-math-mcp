/**
 * Shared input bounds for the MCP tool surface.
 *
 * Every tool takes a free-text mathematical expression and feeds it to an
 * evaluator. The transport's 1 MB body cap is far too generous for that: the
 * Giac path is bounded by a 10 s worker timeout, but the mathjs path runs
 * synchronously on the event loop with no timeout at all, so an oversized
 * expression there stalls every concurrent request.
 *
 * 8 KB is generous for real CAS input — the largest legitimate case is a
 * regression dataset written inline — while keeping the worst case bounded.
 */
export const MAX_EXPRESSION_LENGTH = 8192;
