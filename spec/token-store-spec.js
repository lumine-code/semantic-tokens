const TokenStore = require("../lib/token-store");
const { updateTokenRanges, updateTokenMarkerRanges } = require("../lib/token-range-tracking");

const token = (row, column, length = 4, type = "enum") => ({ row, column, length, type });
const geometry = (tokens) => tokens.map(({ row, column, length }) => [row, column, length]);
const insertion = (at, newText) => ({ oldRange: [at, at], newText });

describe("indexed semantic token cache", () => {
  it("owns sorted provider records without retaining provider markers", () => {
    const input = [token(2, 4), { ...token(0, 4), marker: {} }, token(1, 1, 0)];
    const store = new TokenStore(input);
    expect(geometry(store.values())).toEqual([
      [0, 4, 4],
      [2, 4, 4],
    ]);
    expect(store.values()[0]).not.toBe(input[1]);
    expect(store.values()[0].marker).toBeNull();
    expect(input[1].marker).not.toBeNull();
    expect(store.length).toBe(2);
  });

  it("keeps record identities and renderer metadata through lazy row shifts", () => {
    const modifiers = ["readonly"];
    const store = new TokenStore([{ ...token(20, 4), modifiers }]);
    const record = store.values()[0];
    const marker = (record.marker = {});
    store.applyChange(insertion([0, 0], "\n\n"));
    expect(store.tokensInRows(22, 22)[0]).toBe(record);
    expect(record.marker).toBe(marker);
    expect(record.modifiers).toBe(modifiers);
    expect(record.row).toBe(22);
  });

  it("handles Unicode boundary fragments, internal splits and complete removal", () => {
    const store = new TokenStore([token(0, 4), token(1, 4)]);
    store.applyChange(insertion([0, 8], "_ż𐐀 other"));
    expect(geometry(store.values())).toEqual([
      [0, 4, 8],
      [1, 4, 4],
    ]);
    store.applyChange(insertion([0, 6], "a\nb"));
    expect(geometry(store.values())).toEqual([
      [0, 4, 2],
      [2, 4, 4],
    ]);
    const record = store.tokensInRows(2, 2)[0];
    const { removed } = store.applyChange({
      oldRange: [
        [2, 4],
        [2, 8],
      ],
      newText: "other",
    });
    expect(removed).toEqual([record]);
    expect(geometry(store.values())).toEqual([[0, 4, 2]]);
  });

  it("resolves adjacency after deleting a newline before inserting an identifier", () => {
    const store = new TokenStore([token(0, 2, 3), token(1, 0, 4, "variable")]);
    store.applyChange({
      oldRange: [
        [0, 5],
        [1, 0],
      ],
      newText: "_ż",
    });
    expect(geometry(store.values())).toEqual([
      [0, 2, 5],
      [0, 7, 4],
    ]);
  });

  it("applies multiple edits in their individual coordinate spaces", () => {
    const store = new TokenStore([token(1, 4), token(2, 4)]);
    store.applyChange(insertion([0, 0], "\n"));
    store.applyChange(insertion([2, 6], "\n"));
    store.applyChange({
      oldRange: [
        [2, 6],
        [3, 0],
      ],
      newText: "",
    });
    expect(geometry(store.values())).toEqual([
      [2, 4, 2],
      [3, 4, 4],
    ]);
  });

  it("matches the direct reference through replacements without materializing distant rows", () => {
    let seed = 0x781129;
    const random = (limit) => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % limit;
    };
    let expected = Array.from({ length: 1000 }, (_, index) =>
      token(Math.floor(index / 5), (index % 5) * 7, 4, String(index)),
    );
    const store = new TokenStore(expected);
    const text = ["", "x", "_ż", "a b", "\n", "a\r\nb", "𐐀", "first\nlast"];
    for (let index = 0; index < 400; index++) {
      const firstRow = random(210);
      const firstColumn = random(35);
      const lastRow = firstRow + random(4);
      const lastColumn = lastRow === firstRow ? firstColumn + random(4) : random(35);
      const change = {
        oldRange: [
          [firstRow, firstColumn],
          [lastRow, lastColumn],
        ],
        newText: text[random(text.length)],
      };
      expected = updateTokenRanges(expected, change);
      store.applyChange(change);
      // Leave most of the tree's pending offsets lazy between edits.
      const row = random(210);
      expect(store.tokensInRows(row, row + 3).map(({ type }) => type)).toEqual(
        expected
          .filter((record) => record.row >= row && record.row <= row + 3)
          .map(({ type }) => type),
      );
      if (index % 31 === 0) expect(geometry(store.values())).toEqual(geometry(expected));
    }
    expect(geometry(store.values())).toEqual(geometry(expected));
  });

  it("bounds edit and viewport work by tree paths rather than whole-document size", () => {
    const count = 100000;
    const store = new TokenStore(
      Array.from({ length: count }, (_, row) => token(row, 4)),
      { measure: true },
    );
    for (const row of [0, count / 2, count - 1]) {
      store.applyChange(insertion([row, 6], "x"));
      expect(store.lastEditMetrics.affected).toBe(1);
      expect(store.lastEditMetrics.visited).toBeLessThan(250);
    }
    store.applyChange(insertion([0, 0], "\n"));
    expect(store.lastEditMetrics.affected).toBe(0);
    expect(store.lastEditMetrics.visited).toBeLessThan(250);
    expect(store.tokensInRows(50000, 50039).length).toBe(40);
    expect(store.lastQueryMetrics.visited).toBeLessThan(100);
  });
});

describe("semantic token marker policy", () => {
  it("does not resurrect empty or multiline marker ranges", () => {
    expect(
      updateTokenMarkerRanges(
        [
          {
            id: 1,
            range: [
              [0, 4],
              [0, 4],
            ],
          },
          {
            id: 2,
            range: [
              [0, 4],
              [1, 8],
            ],
          },
        ],
        insertion([0, 4], "x"),
      ),
    ).toEqual([
      { id: 1, range: null },
      { id: 2, range: null },
    ]);
  });

  it("returns explicit removals and preserves marker ids", () => {
    const entries = [
      {
        id: 1,
        range: [
          [0, 4],
          [0, 8],
        ],
      },
      {
        id: 2,
        range: [
          [0, 8],
          [0, 12],
        ],
      },
    ];
    expect(
      updateTokenMarkerRanges(entries, {
        oldRange: [
          [0, 4],
          [0, 8],
        ],
        newText: "",
      }),
    ).toEqual([
      { id: 1, range: null },
      {
        id: 2,
        range: [
          [0, 4],
          [0, 8],
        ],
      },
    ]);
  });

  it("supports core Range-shaped callback entries", () => {
    expect(
      updateTokenMarkerRanges(
        [{ id: "enum", range: { start: { row: 0, column: 4 }, end: { row: 0, column: 8 } } }],
        insertion([0, 6], "\n"),
      ),
    ).toEqual([
      {
        id: "enum",
        range: [
          [0, 4],
          [0, 6],
        ],
      },
    ]);
  });
});
