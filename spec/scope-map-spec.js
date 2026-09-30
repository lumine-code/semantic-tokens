const { propertiesFor } = require("../lib/semantic-scope-map");

describe("semantic scope names outside the standard legend", () => {
  it("keeps Object prototype names unclassified when used as token types", () => {
    for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"])
      expect(propertiesFor(type).class).toBe("semantic-tokens");
  });

  it("ignores Object prototype names when used as unknown modifiers", () => {
    expect(propertiesFor("variable", ["constructor", "toString", "__proto__"]).class).toBe(
      "semantic-tokens syntax--variable",
    );
  });
});
