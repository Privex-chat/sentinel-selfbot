/**
 * Escape `%` and `_` (and the escape character itself) inside a user-supplied
 * LIKE pattern so the search string is treated as a literal substring instead
 * of a wildcard expression.
 *
 * Parameter binding handles SQL injection — that risk doesn't exist here. The
 * concern is *pattern* injection: a client passing `%%%%%%%` forces a
 * full-table scan against a column that may be hundreds of megabytes (messages
 * content), and `_____foo` or `bar%baz` produces silently-incorrect matches
 * the operator never intended.
 *
 * Pair every escaped LIKE pattern with an explicit `ESCAPE '\\'` clause:
 *
 *     sql += " AND content LIKE ? ESCAPE '\\\\'";
 *     params.push(`%${escapeLikePattern(search)}%`);
 *
 * The escape char must be set per-statement; SQLite has no global default.
 */
export function escapeLikePattern(s: string): string {
    return s.replace(/[\\%_]/g, ch => "\\" + ch);
}
