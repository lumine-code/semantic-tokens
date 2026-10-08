const { updateTokenRanges } = require("./token-range-tracking");

const sourceToken = Symbol("sourceToken");

function position(value) {
  return Array.isArray(value) ? { row: value[0], column: value[1] } : value;
}

function compare(token, point) {
  return token.row - point.row || token.column - point.column;
}

function size(node) {
  return node?.size || 0;
}

function updateSize(node) {
  node.size = 1 + size(node.left) + size(node.right);
  return node;
}

// A uniform offset is held on the subtree, rather than rewriting every token
// below an edit. Column offsets are applied only to the edit's ending row.
function shift(node, rows, columns = 0) {
  if (!node || (!rows && !columns)) return;
  node.token.row += rows;
  node.token.column += columns;
  node.rows += rows;
  node.columns += columns;
}

function push(node) {
  if (!node.rows && !node.columns) return;
  shift(node.left, node.rows, node.columns);
  shift(node.right, node.rows, node.columns);
  node.rows = 0;
  node.columns = 0;
}

function visit(metrics) {
  if (metrics) metrics.visited++;
}

function split(node, point, metrics) {
  if (!node) return [null, null];
  visit(metrics);
  push(node);
  if (compare(node.token, point) < 0) {
    const [left, right] = split(node.right, point, metrics);
    node.right = left;
    return [updateSize(node), right];
  }
  const [left, right] = split(node.left, point, metrics);
  node.left = right;
  return [left, updateSize(node)];
}

function merge(left, right, metrics) {
  if (!left) return right;
  if (!right) return left;
  visit(metrics);
  if (left.priority < right.priority) {
    push(left);
    left.right = merge(left.right, right, metrics);
    return updateSize(left);
  }
  push(right);
  right.left = merge(left, right.left, metrics);
  return updateSize(right);
}

function removeEdge(node, side, metrics) {
  visit(metrics);
  push(node);
  if (!node[side]) {
    const rest = node[side === "left" ? "right" : "left"];
    node.left = null;
    node.right = null;
    node.size = 1;
    return [rest, node];
  }
  const [rest, edge] = removeEdge(node[side], side, metrics);
  node[side] = rest;
  return [updateSize(node), edge];
}

function collect(node, result, metrics) {
  if (!node) return;
  visit(metrics);
  push(node);
  collect(node.left, result, metrics);
  result.push(node);
  collect(node.right, result, metrics);
}

function collectRows(node, first, last, result, metrics) {
  if (!node) return;
  visit(metrics);
  push(node);
  const row = node.token.row;
  if (row >= first) collectRows(node.left, first, last, result, metrics);
  if (row >= first && row <= last) result.push(node.token);
  if (row <= last) collectRows(node.right, first, last, result, metrics);
}

function initializeSizes(node) {
  if (!node) return;
  initializeSizes(node.left);
  initializeSizes(node.right);
  updateSize(node);
}

// The provider's full-document answer stays indexed even when only the viewport
// has native markers. Edits touch O(log N + affected) nodes; scrolling visits
// O(log N + visible) nodes. Stable token objects retain their marker metadata.
module.exports = class TokenStore {
  constructor(tokens = [], { measure = false } = {}) {
    this.root = null;
    this.measure = measure;
    this.lastEditMetrics = null;
    this.lastQueryMetrics = null;
    const records = tokens
      .filter((token) => token?.length > 0)
      .map((token) => ({ ...token, marker: null }))
      .sort((a, b) => a.row - b.row || a.column - b.column);
    // Build the treap in linear time after sorting. Priorities use a fixed
    // pseudo-random sequence so correctness/performance fixtures reproduce.
    let seed = 0x6d2b79f5;
    const stack = [];
    for (const token of records) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const node = {
        token,
        priority: seed >>> 0,
        left: null,
        right: null,
        size: 1,
        rows: 0,
        columns: 0,
      };
      while (stack.length && stack[stack.length - 1].priority > node.priority)
        node.left = stack.pop();
      if (stack.length) stack[stack.length - 1].right = node;
      else this.root = node;
      stack.push(node);
    }
    initializeSizes(this.root);
  }

  get length() {
    return size(this.root);
  }

  applyChange(change) {
    const metrics = this.measure ? { visited: 0, affected: 0 } : null;
    this.lastEditMetrics = metrics;
    const start = position(change.oldRange.start || change.oldRange[0]);
    const end = position(change.oldRange.end || change.oldRange[1]);
    const lines = change.newText.split(/\r\n|\r|\n/);
    const rows = lines.length - 1;
    const columns = lines[rows].length;
    if (!compare(start, end) && !rows && !columns) return { removed: [], changed: [] };

    let [before, after] = split(this.root, start, metrics);
    const local = [];
    // A token straddling the start (or ending exactly there) belongs to the
    // local replacement. No earlier token can overlap this single-line one.
    if (before) {
      const [rest, candidate] = removeEdge(before, "right", metrics);
      const token = candidate.token;
      if (token.row === start.row && token.column + token.length >= start.column) {
        before = rest;
        local.push(candidate);
      } else before = merge(rest, candidate, metrics);
    }
    const [covered, remaining] = split(after, end, metrics);
    after = remaining;
    collect(covered, local, metrics);
    // The token beginning at the deletion's end can land at the insertion
    // point. Include it to resolve shared-boundary ownership with the prefix.
    if (after) {
      const [rest, candidate] = removeEdge(after, "left", metrics);
      if (compare(candidate.token, end) === 0) {
        after = rest;
        local.push(candidate);
      } else after = merge(candidate, rest, metrics);
    }
    if (metrics) metrics.affected = local.length;

    const updated = updateTokenRanges(
      local.map(({ token }) => ({ ...token, [sourceToken]: token })),
      change,
    );
    const survivors = new Set();
    for (const token of updated) {
      const original = token[sourceToken];
      original.row = token.row;
      original.column = token.column;
      original.length = token.length;
      survivors.add(original);
    }
    const removed = [];
    const changed = [];
    let middle = null;
    for (const node of local) {
      node.left = null;
      node.right = null;
      node.size = 1;
      if (survivors.has(node.token)) {
        changed.push(node.token);
        middle = merge(middle, node, metrics);
      } else removed.push(node.token);
    }

    // All untouched tokens to the right share a row shift; only those on the
    // old ending row also need the column shift that joins/splits that line.
    const [endingRow, laterRows] = split(after, { row: end.row + 1, column: 0 }, metrics);
    const rowDelta = start.row + rows - end.row;
    const columnDelta = (rows ? columns : start.column + columns) - end.column;
    shift(endingRow, rowDelta, columnDelta);
    shift(laterRows, rowDelta);
    after = merge(endingRow, laterRows, metrics);
    this.root = merge(merge(before, middle, metrics), after, metrics);
    return { removed, changed };
  }

  tokensInRows(first, last) {
    const result = [];
    const metrics = this.measure ? { visited: 0 } : null;
    this.lastQueryMetrics = metrics;
    if (first <= last) collectRows(this.root, first, last, result, metrics);
    return result;
  }

  values() {
    const nodes = [];
    collect(this.root, nodes);
    return nodes.map(({ token }) => token);
  }

  map(callback) {
    return this.values().map(callback);
  }

  [Symbol.iterator]() {
    return this.values()[Symbol.iterator]();
  }
};
