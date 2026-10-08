const identifierPrefix = /^[\p{ID_Continue}_$]+/u;
const identifierSuffix = /[\p{ID_Continue}_$]+$/u;

function point(value) {
  return Array.isArray(value) ? { row: value[0], column: value[1] } : value;
}

function range(value) {
  return Array.isArray(value)
    ? { start: point(value[0]), end: point(value[1]) }
    : { start: point(value.start), end: point(value.end) };
}

function compare(a, b) {
  return a.row - b.row || a.column - b.column;
}

function moveAfterDeletion(token, start, end) {
  return {
    ...token,
    row: token.row - (end.row - start.row),
    column: token.row === end.row ? start.column + token.column - end.column : token.column,
  };
}

function deleteRange(token, start, end) {
  const tokenStart = { row: token.row, column: token.column };
  const tokenEnd = { row: token.row, column: token.column + token.length };
  if (compare(tokenEnd, start) <= 0) return token;
  if (compare(tokenStart, end) >= 0) return moveAfterDeletion(token, start, end);

  const prefix = compare(tokenStart, start) < 0 ? start.column - token.column : 0;
  const suffix = compare(tokenEnd, end) > 0 ? tokenEnd.column - end.column : 0;
  if (prefix) return { ...token, length: prefix + suffix };
  if (suffix) return { ...token, row: start.row, column: start.column, length: suffix };
  return null;
}

function insertionFor(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  return {
    rows: lines.length - 1,
    columns: lastLine.length,
    prefix: firstLine.match(identifierPrefix)?.[0].length || 0,
    suffix: lastLine.match(identifierSuffix)?.[0].length || 0,
  };
}

function insertText(token, at, insertion, ownsEnd) {
  const { rows, columns, prefix, suffix } = insertion;
  if (token.row < at.row) return token;
  if (token.row > at.row) return rows ? { ...token, row: token.row + rows } : token;
  const end = token.column + token.length;
  if (end < at.column) return token;
  if (end === at.column) return prefix ? { ...token, length: token.length + prefix } : token;
  if (token.column < at.column) {
    // A split token stays on its original line. The suffix needs a fresh
    // classification instead of inheriting the prefix's class on another row.
    return {
      ...token,
      length: rows ? at.column - token.column : token.length + columns,
    };
  }
  const extension = token.column === at.column && !ownsEnd ? suffix : 0;
  return {
    ...token,
    row: token.row + rows,
    column: (rows ? columns + token.column - at.column : token.column + columns) - extension,
    length: token.length + extension,
  };
}

/**
 * Update token ranges optimistically after one buffer replacement. Single-line
 * edits retain classifications; splitting a token retains its original prefix.
 * Boundary insertions extend only the adjoining Unicode identifier fragment.
 *
 * Records contain `row`, `column` and `length`, plus arbitrary metadata that is
 * preserved on surviving tokens. Columns and lengths use UTF-16 code units.
 * The input records are not mutated, and unchanged records may be reused.
 *
 * Prefer TextBuffer.onDidApplyChanges when tracking a token cache.
 * Apply its changes in the reported order, including intermediate edits that
 * cancel each other, to follow the same sequence as token-tracking markers.
 * Each change uses the coordinates immediately before that individual edit.
 *
 * Consolidated TextBuffer.onDidChange transaction changes report old
 * ranges in the original coordinate space. Apply those in descending order,
 * using each `oldRange.start` even when its `newRange.start` has moved because
 * of another change in that transaction.
 *
 * @param {Array<Object>} tokens - Sorted, nonoverlapping, nonempty single-line token records.
 * @param {Object} change - One edit in the current token coordinate space.
 * @param {Range|Array} change.oldRange - Range of the replaced text.
 * @param {String} change.newText - Text inserted in place of the old range.
 * @returns {Array<Object>} Updated token records, excluding fully deleted tokens.
 */
function updateTokenRanges(tokens, change) {
  const { start, end } = range(change.oldRange);
  const insertion = insertionFor(change.newText);
  const deletion = compare(start, end) !== 0;
  const survivors = deletion
    ? tokens.map((token) => deleteRange(token, start, end)).filter(Boolean)
    : tokens;
  if (insertion.rows === 0 && insertion.columns === 0) return survivors;

  // Only one token owns an insertion at a shared boundary. The ending token
  // takes any identifier prefix; the starting token moves past the insertion.
  const ownsEnd = survivors.some(
    (token) => token.row === start.row && token.column + token.length === start.column,
  );
  return survivors.map((token) => insertText(token, start, insertion, ownsEnd));
}

// The layer supplies only markers touching this edit. Other markers use the
// native index's ordinary shifts, so custom token policy costs no full scan.
function updateTokenMarkerRanges(entries, change) {
  const records = entries.flatMap(({ id, range: value }) => {
    const { start, end } = range(value);
    // A vanished marker can be touched again before the transaction finishes.
    // Its former classification must never grow back from a later insertion.
    if (start.row !== end.row || end.column <= start.column) return [];
    return [{ id, row: start.row, column: start.column, length: end.column - start.column }];
  });
  const updated = new Map(updateTokenRanges(records, change).map((token) => [token.id, token]));
  return entries.map(({ id }) => {
    const token = updated.get(id);
    return {
      id,
      range: token
        ? [
            [token.row, token.column],
            [token.row, token.column + token.length],
          ]
        : null,
    };
  });
}

module.exports = { updateTokenRanges, updateTokenMarkerRanges };
