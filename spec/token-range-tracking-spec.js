const { updateTokenRanges } = require("../lib/token-range-tracking");

const token = (row = 0, column = 4, length = 4, type = "enum") => ({
  row,
  column,
  length,
  type,
  modifiers: ["readonly"],
});

const edit = (tokens, oldRange, newText) => updateTokenRanges(tokens, { oldRange, newText });
const insert = (tokens, at, text) => edit(tokens, [at, at], text);

describe("optimistic token range tracking", () => {
  for (const text of [" ", "\t", ".", ",", "\n", "\r\n"]) {
    it(`keeps ${JSON.stringify(text)} outside a token's end`, () => {
      expect(insert([token()], [0, 8], text)).toEqual([token()]);
    });

    it(`keeps ${JSON.stringify(text)} outside a token's start`, () => {
      const multiline = text.includes("\n");
      expect(insert([token()], [0, 4], text)).toEqual([
        token(multiline ? 1 : 0, multiline ? 0 : 4 + text.length),
      ]);
    });
  }

  for (const text of ["x", "_", "$", "9", "ż", "β", "中文", "e\u0301", "𐐀", "extra_123"]) {
    it(`extends a token's end with ${JSON.stringify(text)}`, () => {
      expect(insert([token()], [0, 8], text)).toEqual([token(0, 4, 4 + text.length)]);
    });

    it(`extends a token's start with ${JSON.stringify(text)}`, () => {
      expect(insert([token()], [0, 4], text)).toEqual([token(0, 4, 4 + text.length)]);
    });
  }

  it("absorbs only the adjacent identifier prefix pasted at the end", () => {
    expect(insert([token()], [0, 8], "_extra other")).toEqual([token(0, 4, 10)]);
  });

  it("absorbs only the adjacent identifier suffix pasted at the start", () => {
    expect(insert([token()], [0, 4], "other _extra")).toEqual([token(0, 10, 10)]);
  });

  it("keeps pasted identifiers across a separator outside a token", () => {
    expect(insert([token()], [0, 8], " other")).toEqual([token()]);
    expect(insert([token()], [0, 4], "other ")).toEqual([token(0, 10)]);
  });

  it("absorbs identifier fragments at multiline paste boundaries", () => {
    expect(insert([token()], [0, 8], "first\nlast")).toEqual([token(0, 4, 9)]);
    expect(insert([token()], [0, 4], "first\nlast")).toEqual([token(1, 0, 8)]);
  });

  it("keeps the classification while inserting letters inside a token", () => {
    expect(insert([token()], [0, 6], "extra")).toEqual([token(0, 4, 9)]);
  });

  it("keeps the classification while inserting spaces or punctuation inside a token", () => {
    expect(insert([token()], [0, 6], " . ")).toEqual([token(0, 4, 7)]);
  });

  it("truncates an internally split token to its original prefix", () => {
    expect(insert([token()], [0, 6], "\n")).toEqual([token(0, 4, 2)]);
    expect(insert([token()], [0, 6], "first\nlast")).toEqual([token(0, 4, 2)]);
    expect(insert([token()], [0, 6], "first\r\nlast\r\n")).toEqual([token(0, 4, 2)]);
  });

  it("moves tokens after a same-line insertion", () => {
    expect(insert([token(), token(0, 10), token(1, 3)], [0, 1], "foo ")).toEqual([
      token(0, 8),
      token(0, 14),
      token(1, 3),
    ]);
  });

  it("moves tokens after a multiline insertion by its UTF-16 extent", () => {
    expect(insert([token(), token(0, 10), token(2, 3)], [0, 1], "foo\n𐐀\nlast")).toEqual([
      token(2, 7),
      token(2, 13),
      token(4, 3),
    ]);
  });

  it("gives an insertion at adjacent token boundaries to the ending token", () => {
    expect(insert([token(), token(0, 8, 3, "variable")], [0, 8], "_ż")).toEqual([
      token(0, 4, 6),
      token(0, 10, 3, "variable"),
    ]);
  });

  it("does not give the starting token a suffix when another token ends there", () => {
    expect(insert([token(), token(0, 8, 3, "variable")], [0, 8], " foo")).toEqual([
      token(),
      token(0, 12, 3, "variable"),
    ]);
  });

  it("keeps adjacent classifications separate across a newline insertion", () => {
    expect(insert([token(), token(0, 8, 3, "variable")], [0, 8], "x\ny")).toEqual([
      token(0, 4, 5),
      token(1, 1, 3, "variable"),
    ]);
  });

  it("shortens a token when deleting from inside it", () => {
    expect(
      edit(
        [token()],
        [
          [0, 5],
          [0, 7],
        ],
        "",
      ),
    ).toEqual([token(0, 4, 2)]);
  });

  it("retains the prefix when a deletion crosses its end", () => {
    expect(
      edit(
        [token()],
        [
          [0, 6],
          [0, 10],
        ],
        "",
      ),
    ).toEqual([token(0, 4, 2)]);
  });

  it("retains and moves the suffix when a deletion crosses its start", () => {
    expect(
      edit(
        [token()],
        [
          [0, 2],
          [0, 6],
        ],
        "",
      ),
    ).toEqual([token(0, 2, 2)]);
  });

  it("removes tokens covered by a deletion", () => {
    expect(
      edit(
        [token()],
        [
          [0, 4],
          [0, 8],
        ],
        "",
      ),
    ).toEqual([]);
    expect(
      edit(
        [token()],
        [
          [0, 2],
          [0, 10],
        ],
        "",
      ),
    ).toEqual([]);
  });

  it("does not restore the classification of a fully replaced token", () => {
    expect(
      edit(
        [token()],
        [
          [0, 4],
          [0, 8],
        ],
        "other",
      ),
    ).toEqual([]);
  });

  it("moves later tokens after a same-line deletion", () => {
    expect(
      edit(
        [token(), token(0, 10), token(1, 3)],
        [
          [0, 1],
          [0, 3],
        ],
        "",
      ),
    ).toEqual([token(0, 2), token(0, 8), token(1, 3)]);
  });

  it("preserves both surviving fragments around a multiline deletion", () => {
    const tokens = [token(0, 1, 2), token(1, 2, 6), token(2, 1, 3), token(3, 3, 6), token(4, 5)];
    expect(
      edit(
        tokens,
        [
          [1, 4],
          [3, 6],
        ],
        "",
      ),
    ).toEqual([token(0, 1, 2), token(1, 2, 2), token(1, 4, 3), token(2, 5)]);
  });

  it("moves a partial token suffix onto an earlier line", () => {
    expect(
      edit(
        [token(3, 2, 6)],
        [
          [1, 5],
          [3, 4],
        ],
        "",
      ),
    ).toEqual([token(1, 5, 4)]);
  });

  it("joins rows without overlapping tokens on either side of the removed newline", () => {
    expect(
      edit(
        [token(0, 2, 3), token(1, 0, 4)],
        [
          [0, 5],
          [1, 0],
        ],
        "",
      ),
    ).toEqual([token(0, 2, 3), token(0, 5, 4)]);
  });

  it("applies replacement deletion before insertion", () => {
    expect(
      edit(
        [token()],
        [
          [0, 5],
          [0, 7],
        ],
        "new",
      ),
    ).toEqual([token(0, 4, 5)]);
    expect(
      edit(
        [token()],
        [
          [0, 5],
          [0, 7],
        ],
        "new\nline",
      ),
    ).toEqual([token(0, 4, 1)]);
  });

  it("uses old coordinates for edits whose transaction newRange has moved", () => {
    const changed = updateTokenRanges([token(2)], {
      oldRange: [
        [2, 6],
        [2, 6],
      ],
      newRange: [
        [3, 6],
        [3, 7],
      ],
      newText: "x",
    });
    expect(changed).toEqual([token(2, 4, 5)]);
    expect(insert(changed, [0, 0], "\n")).toEqual([token(3, 4, 5)]);
  });

  it("supports Point and Range-shaped change objects", () => {
    expect(
      updateTokenRanges([token()], {
        oldRange: { start: { row: 0, column: 6 }, end: { row: 0, column: 6 } },
        newRange: { start: { row: 0, column: 6 }, end: { row: 0, column: 7 } },
        newText: "x",
      }),
    ).toEqual([token(0, 4, 5)]);
  });

  it("keeps an empty edit unchanged", () => {
    const tokens = [token()];
    expect(insert(tokens, [0, 6], "")).toBe(tokens);
  });

  it("does not mutate tokens and preserves their renderer metadata", () => {
    const marker = {};
    const original = { ...token(), marker };
    const originalSnapshot = { ...original };
    const changed = insert([original], [0, 6], "x");
    expect(original).toEqual(originalSnapshot);
    expect(changed[0]).not.toBe(original);
    expect(changed[0].marker).toBe(marker);
    expect(changed[0].modifiers).toBe(original.modifiers);
  });
});
