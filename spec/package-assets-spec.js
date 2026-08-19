const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

// This package was extracted from ide-client, which used to render semantic
// tokens itself against its own sessions. The rendering is here now and reaches
// its tokens only through the `semantic-tokens.provider` service, so the guards
// below are mostly about that boundary: no protocol vocabulary, and no config
// or class name left in the ide-client namespace.
describe("semantic-tokens package assets", () => {
  it("ships plain CommonJS with no build step", () => {
    expect(exists("lib/main.js")).toBe(true);
    expect(exists("tsconfig.json")).toBe(false);
    expect(exists("dist")).toBe(false);
    expect(fs.readdirSync(path.join(root, "lib")).every((file) => /\.js$/.test(file))).toBe(true);
  });

  // Unlike every other package's stylesheet this one names no theme variable,
  // and that is the point: a token wears the syntax--* classes a grammar scope
  // would, so the theme colors it and the strike follows in currentColor.
  it("ships a CSS stylesheet, not Less, and leaves the colors to the theme", () => {
    expect(exists("styles/main.css")).toBe(true);
    expect(exists("styles/semantic-tokens.less")).toBe(false);
    const css = read("styles/main.css");
    expect(css).toContain(".semantic-tokens");
    expect(css).not.toContain("ide-client");
    expect(css).not.toContain("@import");
    expect(css).not.toMatch(/\bfade\(|\bcontrast\(|\blighten\(|\bdarken\(|@[a-z-]+:/);
  });

  it("is named `semantic-tokens` and carries the lumine-code metadata", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("semantic-tokens");
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toBe("https://github.com/lumine-code/semantic-tokens");
    expect(pkg.bugs.url).toBe("https://github.com/lumine-code/semantic-tokens/issues");
    expect(pkg.main).toBe("./lib/main");
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.scripts.test).toBe("lumine --test spec");
    expect(pkg.engines.lumine).toBe("^1.0.0");
  });

  it("consumes semantic-tokens.provider and provides nothing", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.consumedServices["semantic-tokens.provider"].versions["^1.0.0"]).toBe(
      "consumeSemanticTokens",
    );
    expect(pkg.providedServices).toBeUndefined();
  });

  it("keeps a keyword list that never repeats the package name", () => {
    const { keywords } = JSON.parse(read("package.json"));
    expect(keywords.length).toBeGreaterThan(2);
    expect(keywords.length).toBeLessThan(9);
    for (const keyword of keywords) {
      expect(keyword).toBe(keyword.toLowerCase());
      expect(keyword).not.toContain(" ");
      // A query matching the name already wins on the name score, so a keyword
      // that is part of it is a wasted slot.
      expect("semantic-tokens".includes(keyword)).toBe(false);
    }
  });

  it("defines a flat config schema under the semantic-tokens namespace without order keys", () => {
    const schema = JSON.parse(read("package.json")).configSchema;
    expect(Object.keys(schema)).toEqual(["enabled"]);
    for (const entry of Object.values(schema)) {
      expect(entry.order).toBeUndefined();
      expect(entry.title).toBeDefined();
      expect(entry.description).toBeDefined();
      expect(entry.type).toBeDefined();
      // `default` must be the last key of every entry.
      const keys = Object.keys(entry);
      expect(keys[keys.length - 1]).toBe("default");
    }
  });

  it("places its commands in one Packages submenu named for the package", () => {
    const menu = JSON.parse(read("menus/main.json"));
    expect(menu["context-menu"]).toBeUndefined();
    const packages = menu.menu.find((item) => item.label === "Packages");
    const submenu = packages.submenu.find((item) => item.label === "Semantic Tokens");
    expect(submenu.submenu.map((item) => item.command)).toEqual([
      "semantic-tokens:toggle",
      "semantic-tokens:refresh",
    ]);
    // Nothing normalizes separators in the application menu, and a submenu this
    // short has no group to separate.
    expect(submenu.submenu.every((item) => item.label && !item.type)).toBe(true);
  });

  it("ships the contract document for the service it owns", () => {
    expect(exists("docs/semantic-tokens.provider.md")).toBe(true);
    const doc = read("docs/semantic-tokens.provider.md");
    expect(doc.split(/\r?\n/)[0]).toBe("# semantic-tokens.provider");
    expect(doc).toContain("provideSemanticTokens");
    expect(doc).toContain("consumeSemanticTokens");
  });

  it("keeps the README description in sync with package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    const lines = read("README.md").split(/\r?\n/);
    expect(lines[0]).toBe("# semantic-tokens");
    const sentence = lines.find((line, index) => index > 0 && line.trim().length > 0);
    expect(sentence).toBe(pkg.description);
  });

  it("holds no language-server vocabulary, so the renderer stays source-agnostic", () => {
    for (const file of fs.readdirSync(path.join(root, "lib"))) {
      const src = read(path.join("lib", file));
      expect(src.toLowerCase()).not.toContain("pulsar");
      expect(src).not.toContain("textDocument/");
      expect(src).not.toContain("ide-client");
    }
  });
});
