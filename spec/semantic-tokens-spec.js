const os = require("os");
const path = require("path");
const { CompositeDisposable, Emitter } = require("lumine");
const { propertiesFor } = require("../lib/semantic-scope-map");

const packageRoot = path.join(__dirname, "..");

// Flushes pending microtasks so the fetch chains settle without advancing the
// fake clock. The marker batches yield through setTimeout(0), so a build that
// spans several chunks needs the clock too.
async function microtasks(count = 40) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

const token = (row, column, length, type, modifiers = []) => ({
  row,
  column,
  length,
  type,
  modifiers,
});

describe("semantic-tokens", () => {
  let mainModule, manager, editor, disposables;

  const stateFor = () => manager.states.get(editor);
  const spans = () => [...editor.getElement().querySelectorAll(".line .semantic-tokens")];
  const classes = () => spans().map((span) => span.className);

  beforeEach(async () => {
    const workspaceElement = lumine.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    disposables = new CompositeDisposable();
    lumine.notifications.clear();

    editor = await lumine.workspace.open(path.join(os.tmpdir(), "semantic-tokens-example.js"));
    editor.setText("const sum = add(first, second);\nlet x = 5;\n");
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);

    const pack = await lumine.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;
    manager = mainModule.manager;
    lumine.config.set("semantic-tokens.enabled", true);
    await microtasks();
  });

  afterEach(async () => {
    disposables.dispose();
    await lumine.packages.deactivatePackage("semantic-tokens");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
  });

  // A provider following the semantic-tokens.provider contract: `grammarScopes`
  // is a getter, `semanticTokens` answers for the whole buffer, and
  // `semanticTokensInRange` only exists when the provider can serve ranges.
  function addProvider({ semanticTokens, semanticTokensInRange, priority } = {}) {
    const emitter = new Emitter();
    const provider = {
      get grammarScopes() {
        return [editor.getGrammar().scopeName];
      },
      priority,
      semanticTokens,
      onDidInvalidate: (fn) => emitter.on("invalidate", fn),
      invalidate: (event) => emitter.emit("invalidate", event),
    };
    if (semanticTokensInRange) provider.semanticTokensInRange = semanticTokensInRange;
    disposables.add(mainModule.consumeSemanticTokens(provider));
    return provider;
  }

  it("asks nothing while the setting is off", async () => {
    lumine.config.set("semantic-tokens.enabled", false);
    const calls = [];
    addProvider({
      semanticTokens: () => {
        calls.push(true);
        return [token(0, 0, 5, "keyword")];
      },
    });
    await microtasks();
    expect(calls.length).toBe(0);
    expect(spans().length).toBe(0);
  });

  it("decorates each token with the scope classes a grammar would use", async () => {
    addProvider({
      semanticTokens: () => [
        token(0, 0, 5, "keyword"),
        token(0, 6, 3, "variable", ["deprecated"]),
        token(1, 4, 1, "parameter", ["defaultLibrary"]),
      ],
    });
    await microtasks();
    expect(classes()).toEqual([
      "semantic-tokens syntax--keyword",
      "semantic-tokens syntax--variable semantic-tokens-strike",
      "semantic-tokens syntax--variable syntax--parameter syntax--support",
    ]);
  });

  it("skips a zero-length token and leaves an unknown type unclassified", async () => {
    addProvider({
      semanticTokens: () => [token(0, 0, 0, "keyword"), token(0, 6, 3, "somethingElse")],
    });
    await microtasks();
    expect(classes()).toEqual(["semantic-tokens"]);
  });

  it("rebuilds the markers on every answer, dropping the ones it replaces", async () => {
    let tokens = [token(0, 0, 5, "keyword")];
    const provider = addProvider({ semanticTokens: () => tokens });
    await microtasks();
    const [before] = stateFor().markers;
    tokens = [token(0, 0, 5, "string")];
    provider.invalidate();
    await microtasks();
    expect(before.isDestroyed()).toBe(true);
    expect(classes()).toEqual(["semantic-tokens syntax--string"]);
  });

  it("keeps the tokens on screen when a provider fails transiently", async () => {
    let fail = false;
    const provider = addProvider({
      semanticTokens: () => {
        if (fail) return Promise.reject(new Error("reindexing"));
        return [token(0, 0, 5, "keyword")];
      },
    });
    await microtasks();
    fail = true;
    provider.invalidate();
    await microtasks();
    expect(classes()).toEqual(["semantic-tokens syntax--keyword"]);
  });

  it("ignores an answer for text that changed while the request was pending", async () => {
    let resolve;
    addProvider({
      semanticTokens: () => new Promise((done) => (resolve = done)),
    });
    editor.setText("let value = 1;");
    resolve([token(0, 0, 5, "keyword")]);
    await microtasks();
    expect(spans().length).toBe(0);
  });

  describe("editing around a semantic token", () => {
    for (const { name, position, text, range } of [
      {
        name: "a trailing space",
        position: [2, 19],
        text: " ",
        range: [
          [2, 15],
          [2, 19],
        ],
      },
      {
        name: "a trailing newline",
        position: [2, 19],
        text: "\n",
        range: [
          [2, 15],
          [2, 19],
        ],
      },
      {
        name: "a leading space",
        position: [2, 15],
        text: " ",
        range: [
          [2, 16],
          [2, 20],
        ],
      },
      {
        name: "a leading newline",
        position: [2, 15],
        text: "\n",
        range: [
          [3, 0],
          [3, 4],
        ],
      },
    ]) {
      it(`keeps the token visible after inserting ${name} while its refresh is pending`, async () => {
        editor.setText("+prog maxima\nhead trace\ntrac 2345,2346 spri\nend");
        advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
        let resolve;
        const fresh = [token(range[0][0], range[0][1], 4, "enum")];
        const provider = addProvider({ semanticTokens: () => [token(2, 15, 4, "enum")] });
        await microtasks();
        const [marker] = stateFor().markers;
        provider.semanticTokens = () => new Promise((done) => (resolve = done));
        editor.setCursorBufferPosition(position);
        editor.insertText(text);

        const expectUnchangedToken = () => {
          expect(marker.isValid()).toBe(true);
          expect(marker.getBufferRange()).toEqual(range);
          expect(editor.getTextInBufferRange(marker.getBufferRange())).toBe("spri");
          expect(spans().map((span) => span.textContent)).toEqual(["spri"]);
          expect(classes()).toEqual([propertiesFor("enum", []).class]);
        };
        await microtasks();
        expectUnchangedToken();
        advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
        await microtasks();
        expectUnchangedToken();

        resolve(fresh);
        await microtasks();
        expect(marker.isDestroyed()).toBe(true);
        expect(classes()).toEqual([propertiesFor("enum", []).class]);
        expect(spans().map((span) => span.textContent)).toEqual(["spri"]);
      });
    }

    it("removes an edited token's stale classification until the provider answers", async () => {
      editor.setText("+prog maxima\nhead trace\ntrac 2345,2346 spri\nend");
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      let resolve;
      const provider = addProvider({ semanticTokens: () => [token(2, 15, 4, "enum")] });
      await microtasks();
      const [marker] = stateFor().markers;
      provider.semanticTokens = () => new Promise((done) => (resolve = done));
      editor.setCursorBufferPosition([2, 17]);
      editor.insertText("x");
      await microtasks();
      expect(marker.isValid()).toBe(false);
      expect(spans().length).toBe(0);
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      await microtasks();
      expect(spans().length).toBe(0);
      resolve([]);
      await microtasks();
      expect(stateFor().markers.length).toBe(0);
    });
  });

  it("refetches after a path change even when the grammar stays the same", async () => {
    const paths = [];
    addProvider({
      semanticTokens: (target) => {
        paths.push(target.getPath());
        return [];
      },
    });
    await microtasks();
    const renamed = path.join(os.tmpdir(), "semantic-tokens-renamed.js");
    editor.getBuffer().setPath(renamed);
    await microtasks();
    expect(paths[paths.length - 1]).toBe(renamed);
  });

  it("clears when the only provider declines", async () => {
    let tokens = [token(0, 0, 5, "keyword")];
    const provider = addProvider({ semanticTokens: () => tokens });
    await microtasks();
    expect(spans().length).toBe(1);
    tokens = null;
    provider.invalidate();
    await microtasks();
    expect(spans().length).toBe(0);
  });

  describe("choosing one provider", () => {
    it("lets the highest-priority provider that answers classify the buffer", async () => {
      const asked = [];
      addProvider({
        priority: 1,
        semanticTokens: () => {
          asked.push("low");
          return [token(0, 0, 5, "string")];
        },
      });
      addProvider({
        priority: 2,
        semanticTokens: () => {
          asked.push("high");
          return [token(0, 0, 5, "keyword")];
        },
      });
      await microtasks();
      // Registering each one fetched with whoever was registered then; this is
      // about a fetch that sees both.
      asked.length = 0;
      manager.fetchAll();
      await microtasks();
      // Two token sets over one buffer would merge their classes, so the second
      // provider is never asked.
      expect(asked).toEqual(["high"]);
      expect(classes()).toEqual(["semantic-tokens syntax--keyword"]);
    });

    it("falls through to the next provider when the first declines", async () => {
      addProvider({ priority: 2, semanticTokens: () => null });
      addProvider({ priority: 1, semanticTokens: () => [token(0, 0, 5, "string")] });
      await microtasks();
      expect(classes()).toEqual(["semantic-tokens syntax--string"]);
    });

    it("does not ask a fallback provider after its pending range request was superseded", async () => {
      let resolveRange;
      const rangeAnswer = new Promise((resolve) => (resolveRange = resolve));
      const fallback = jasmine.createSpy("fallback").and.returnValue([]);
      addProvider({
        priority: 2,
        semanticTokens: () => null,
        semanticTokensInRange: () => rangeAnswer,
      });
      addProvider({ priority: 1, semanticTokens: fallback });
      await microtasks();
      lumine.config.set("semantic-tokens.enabled", false);
      resolveRange(null);
      await microtasks();
      expect(fallback).not.toHaveBeenCalled();
    });

    it("drops a removed provider's tokens even when its replacement fails", async () => {
      const subscription = mainModule.consumeSemanticTokens({
        priority: 2,
        semanticTokens: () => [token(0, 0, 5, "keyword")],
      });
      addProvider({
        priority: 1,
        semanticTokens: () => Promise.reject(new Error("unavailable")),
      });
      await microtasks();
      expect(spans().length).toBe(1);
      subscription.dispose();
      await microtasks();
      expect(spans().length).toBe(0);
    });
  });

  describe("the viewport budget", () => {
    it("updates the viewport even while its first range answer is pending", async () => {
      editor.setText("x\n".repeat(6000));
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      const requests = [];
      addProvider({
        semanticTokens: () => null,
        semanticTokensInRange: (target, range) =>
          new Promise((resolve) => requests.push({ range, resolve })),
      });
      await microtasks();
      const element = editor.getElement();
      element.setScrollTop(2000 * element.component.getLineHeight());
      advanceClock(150);
      await microtasks();
      expect(requests.length).toBeGreaterThan(1);
      const lastRequest = requests[requests.length - 1];
      expect(lastRequest.range[0]).toBeGreaterThan(0);
      for (const request of requests) request.resolve([]);
      await microtasks();
    });

    it("does not enter range mode when a superseded range request rejects", async () => {
      let rejectRange;
      const provider = addProvider({
        semanticTokens: () => null,
        semanticTokensInRange: () => new Promise((resolve, reject) => (rejectRange = reject)),
      });
      await microtasks();
      provider.semanticTokens = () => [token(0, 0, 5, "keyword")];
      provider.invalidate();
      await microtasks();
      rejectRange(new Error("old request failed"));
      await microtasks();
      expect(stateFor().rangeMode).toBe(false);
      expect(classes()).toEqual(["semantic-tokens syntax--keyword"]);
    });

    it("caches a large answer and decorates newly visible rows before the scroll handler returns", async () => {
      editor.setText("x\n".repeat(20001));
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      let fullCalls = 0;
      const rangeFetch = jasmine.createSpy("rangeFetch").and.returnValue([]);
      // Providers may return tokens in any order. The rows are real buffer
      // positions, so bounded rendering cannot hide behind overlapping tokens.
      const huge = Array.from({ length: 20001 }, (_, row) => token(row, 0, 1, "variable"));
      const provider = addProvider({
        semanticTokens: () => {
          fullCalls++;
          return huge.slice().reverse();
        },
        semanticTokensInRange: rangeFetch,
      });
      await microtasks();
      expect(fullCalls).toBe(1);
      expect(rangeFetch).not.toHaveBeenCalled();
      expect(stateFor().markers.length).toBeGreaterThan(0);
      expect(stateFor().markers.length).toBeLessThan(20000);

      const element = editor.getElement();
      const before = stateFor().markers.slice();
      element.setScrollTop(5 * element.component.getLineHeight());
      expect(stateFor().markers).toEqual(before);
      element.setScrollTop(2000 * element.component.getLineHeight());
      // No clock advance or promise flush: cache decoration belongs to the
      // scroll update that reveals these rows.
      expect(stateFor().markers.some((marker) => marker.getBufferRange().start.row === 2000)).toBe(
        true,
      );
      expect(stateFor().markers.length).toBeLessThan(20000);
      expect(fullCalls).toBe(1);
      expect(rangeFetch).not.toHaveBeenCalled();

      element.setScrollTop(0);
      expect(stateFor().markers.some((marker) => marker.getBufferRange().start.row === 0)).toBe(
        true,
      );
      advanceClock(150);
      await microtasks();
      expect(fullCalls).toBe(1);
      expect(rangeFetch).not.toHaveBeenCalled();

      // A provider invalidation refreshes the cached classification itself.
      provider.invalidate();
      await microtasks();
      expect(fullCalls).toBe(2);
      expect(rangeFetch).not.toHaveBeenCalled();
    });

    it("uses a full answer with bounded decoration in a file past the line budget", async () => {
      editor.setText("x\n".repeat(6000));
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      let fullCalls = 0;
      const rangeFetch = jasmine.createSpy("rangeFetch").and.returnValue([]);
      addProvider({
        semanticTokens: () => {
          fullCalls++;
          return [token(0, 0, 1, "keyword"), token(2000, 0, 1, "variable")];
        },
        semanticTokensInRange: rangeFetch,
      });
      await microtasks();
      expect(fullCalls).toBe(1);
      expect(rangeFetch).not.toHaveBeenCalled();
      expect(stateFor().markers.map((marker) => marker.getBufferRange().start.row)).toEqual([0]);
      const element = editor.getElement();
      element.setScrollTop(2000 * element.component.getLineHeight());
      expect(stateFor().markers.map((marker) => marker.getBufferRange().start.row)).toEqual([2000]);
      expect(fullCalls).toBe(1);
    });

    it("renders a large full-only provider without making a marker for every token", async () => {
      editor.setText("x\n".repeat(20001));
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      const huge = Array.from({ length: 20001 }, (_, row) => token(row, 0, 1, "variable"));
      addProvider({ semanticTokens: () => huge });
      await microtasks();
      expect(spans().length).toBeGreaterThan(0);
      expect(stateFor().markers.length).toBeLessThan(20000);
      const element = editor.getElement();
      element.setScrollTop(2000 * element.component.getLineHeight());
      expect(stateFor().markers.some((marker) => marker.getBufferRange().start.row === 2000)).toBe(
        true,
      );
    });

    it("renders the latest viewport when a full answer arrives after scrolling", async () => {
      editor.setText("x\n".repeat(6000));
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      let resolve;
      const fullFetch = jasmine
        .createSpy("fullFetch")
        .and.callFake(() => new Promise((done) => (resolve = done)));
      addProvider({ semanticTokens: fullFetch });
      await microtasks();
      const element = editor.getElement();
      element.setScrollTop(2000 * element.component.getLineHeight());
      resolve([token(0, 0, 1, "keyword"), token(2000, 0, 1, "variable")]);
      await microtasks();
      expect(stateFor().markers.map((marker) => marker.getBufferRange().start.row)).toEqual([2000]);
      expect(fullFetch).toHaveBeenCalledTimes(1);
    });

    it("does not render old cached positions after the source changes", async () => {
      editor.setText("x\n".repeat(6000));
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      let tokens = [token(0, 0, 1, "keyword"), token(2000, 0, 1, "variable")];
      const fullFetch = jasmine.createSpy("fullFetch").and.callFake(() => tokens);
      addProvider({ semanticTokens: fullFetch });
      await microtasks();
      editor.insertText("y");
      tokens = [token(2000, 0, 1, "keyword")];
      const element = editor.getElement();
      element.setScrollTop(2000 * element.component.getLineHeight());
      expect(stateFor().markers.some((marker) => marker.getBufferRange().start.row === 2000)).toBe(
        false,
      );
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      await microtasks();
      expect(stateFor().markers.map((marker) => marker.getBufferRange().start.row)).toEqual([2000]);
      expect(fullFetch).toHaveBeenCalledTimes(2);
    });

    it("keeps cached scrolling available when a provider refresh fails", async () => {
      editor.setText("x\n".repeat(6000));
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      let fail = false;
      const fullFetch = jasmine.createSpy("fullFetch").and.callFake(() => {
        if (fail) return Promise.reject(new Error("reindexing"));
        return [token(0, 0, 1, "keyword"), token(2000, 0, 1, "variable")];
      });
      const rangeFetch = jasmine.createSpy("rangeFetch").and.returnValue([]);
      const provider = addProvider({
        semanticTokens: fullFetch,
        semanticTokensInRange: rangeFetch,
      });
      await microtasks();
      fail = true;
      provider.invalidate();
      await microtasks();
      const element = editor.getElement();
      element.setScrollTop(2000 * element.component.getLineHeight());
      expect(stateFor().markers.map((marker) => marker.getBufferRange().start.row)).toEqual([2000]);
      advanceClock(150);
      await microtasks();
      expect(fullFetch).toHaveBeenCalledTimes(2);
      expect(rangeFetch).not.toHaveBeenCalled();
    });

    it("finishes a cancelled cache slice after a failed refresh instead of treating it as rendered", async () => {
      editor.setText("x\n".repeat(6000));
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      // Measure a tall viewport so the cache slice spans several batches,
      // while keeping the test DOM small enough for fast marker rendering.
      spyOn(editor, "getLastVisibleScreenRow").and.callFake(
        () => editor.getFirstVisibleScreenRow() + 3000,
      );
      const tokens = Array.from({ length: 3001 }, (_, row) => token(row, 0, 1, "variable"));
      let fail = false;
      const fullFetch = jasmine.createSpy("fullFetch").and.callFake(() => {
        if (fail) return Promise.reject(new Error("reindexing"));
        return tokens;
      });
      const provider = addProvider({ semanticTokens: fullFetch });
      await microtasks();
      expect(stateFor().markers.length).toBe(2000);
      fail = true;
      provider.invalidate();
      await microtasks();
      advanceClock(0);
      await microtasks();
      expect(stateFor().markers.length).toBe(2000);
      const element = editor.getElement();
      element.setScrollTop(5 * element.component.getLineHeight());
      advanceClock(0);
      await microtasks();
      expect(stateFor().markers.length).toBe(tokens.length);
      expect(stateFor().markers.some((marker) => marker.getBufferRange().start.row === 3000)).toBe(
        true,
      );
      expect(fullFetch).toHaveBeenCalledTimes(2);
    });

    it("replaces the previous cache when a refresh returns an empty classification", async () => {
      editor.setText("x\n".repeat(6000));
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      let tokens = [token(0, 0, 1, "keyword"), token(2000, 0, 1, "variable")];
      const provider = addProvider({ semanticTokens: () => tokens });
      await microtasks();
      tokens = [];
      provider.invalidate();
      await microtasks();
      expect(stateFor().markers.length).toBe(0);
      const element = editor.getElement();
      element.setScrollTop(2000 * element.component.getLineHeight());
      expect(stateFor().markers.length).toBe(0);
    });

    it("refetches the newly visible rows once scrolling settles", async () => {
      editor.setText("x\n".repeat(6000));
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      const ranges = [];
      addProvider({
        semanticTokens: () => null,
        semanticTokensInRange: (target, range) => {
          ranges.push(range);
          return [];
        },
      });
      await microtasks();
      const before = ranges.length;
      const element = editor.getElement();
      element.setScrollTop(2000 * element.component.getLineHeight());
      advanceClock(150);
      await microtasks();
      expect(ranges.length).toBeGreaterThan(before);
      expect(ranges[ranges.length - 1][0]).toBeGreaterThan(0);
    });

    it("requests a range only once after the buffer stops changing", async () => {
      editor.setText("x\n".repeat(6000));
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      const rangeFetch = jasmine.createSpy("rangeFetch").and.returnValue([]);
      addProvider({ semanticTokens: () => null, semanticTokensInRange: rangeFetch });
      await microtasks();
      rangeFetch.calls.reset();
      editor.insertText("y");
      advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
      await microtasks();
      expect(rangeFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("the commands", () => {
    it("toggles the global setting and refetches", async () => {
      addProvider({ semanticTokens: () => [token(0, 0, 5, "keyword")] });
      await microtasks();
      expect(spans().length).toBe(1);
      lumine.commands.dispatch(lumine.workspace.getElement(), "semantic-tokens:toggle");
      await microtasks();
      expect(lumine.config.get("semantic-tokens.enabled")).toBe(false);
      expect(spans().length).toBe(0);
    });

    it("warns when the language keeps a setting of its own", async () => {
      const rootScope = editor.getRootScopeDescriptor().getScopesArray()[0];
      lumine.config.set("semantic-tokens.enabled", true, { scopeSelector: `.${rootScope}` });
      lumine.commands.dispatch(lumine.workspace.getElement(), "semantic-tokens:toggle");
      await microtasks();
      const [notification] = lumine.notifications.getNotifications();
      expect(notification.getType()).toBe("warning");
      expect(notification.getMessage()).toContain("stay on for this language");
    });

    it("refreshes the active editor", async () => {
      const calls = [];
      addProvider({
        semanticTokens: () => {
          calls.push(true);
          return [];
        },
      });
      await microtasks();
      const before = calls.length;
      lumine.commands.dispatch(lumine.workspace.getElement(), "semantic-tokens:refresh");
      await microtasks();
      expect(calls.length).toBe(before + 1);
    });

    it("refreshes the editor that dispatched the command when another pane is active", async () => {
      const calls = [];
      addProvider({
        semanticTokens: (target) => {
          calls.push(target);
          return [];
        },
      });
      const other = await lumine.workspace.open();
      await microtasks();
      expect(lumine.workspace.getActiveTextEditor()).toBe(other);
      calls.length = 0;
      lumine.commands.dispatch(editor.getElement(), "semantic-tokens:refresh");
      await microtasks();
      expect(calls).toEqual([editor]);
    });
  });

  it("honors a per-language scoped disable without asking the provider", async () => {
    const rootScope = editor.getRootScopeDescriptor().getScopesArray()[0];
    lumine.config.set("semantic-tokens.enabled", false, { scopeSelector: `.${rootScope}` });
    const calls = [];
    addProvider({
      semanticTokens: () => {
        calls.push(true);
        return [token(0, 0, 5, "keyword")];
      },
    });
    await microtasks();
    expect(calls.length).toBe(0);
    expect(spans().length).toBe(0);
  });

  it("reacts immediately to a scoped-only setting change", async () => {
    addProvider({ semanticTokens: () => [token(0, 0, 5, "keyword")] });
    await microtasks();
    expect(spans().length).toBe(1);

    const rootScope = editor.getRootScopeDescriptor().getScopesArray()[0];
    lumine.config.set("semantic-tokens.enabled", false, { scopeSelector: `.${rootScope}` });
    await microtasks();
    expect(spans().length).toBe(0);
  });

  it("drops the tokens of a provider whose subscription is disposed", async () => {
    const subscription = mainModule.consumeSemanticTokens({
      get grammarScopes() {
        return [editor.getGrammar().scopeName];
      },
      semanticTokens: () => [token(0, 0, 5, "keyword")],
    });
    await microtasks();
    expect(spans().length).toBe(1);
    subscription.dispose();
    await microtasks();
    expect(spans().length).toBe(0);
  });

  it("stops a batched marker build when highlighting is switched off", async () => {
    editor.setText("x\n".repeat(4001));
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    const tokens = Array.from({ length: 4001 }, (_, row) => token(row, 0, 1, "variable"));
    addProvider({ semanticTokens: () => tokens });
    await microtasks();
    const state = stateFor();
    expect(state.markers.length).toBe(2000);
    lumine.config.set("semantic-tokens.enabled", false);
    advanceClock(0);
    await microtasks();
    expect(state.markers.length).toBe(0);
    expect(state.layer.getMarkerCount()).toBe(0);
    expect(state.layerDecoration.overridePropertiesByMarker.size).toBe(0);
  });

  it("disposes pending work and restores one working manager after reactivation", async () => {
    jasmine.useRealClock();
    let resolve;
    addProvider({ semanticTokens: () => new Promise((done) => (resolve = done)) });
    const previousManager = manager;
    await lumine.packages.deactivatePackage("semantic-tokens");
    const pack = await lumine.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;
    manager = mainModule.manager;
    resolve([token(0, 0, 5, "string")]);
    addProvider({ semanticTokens: () => [token(0, 0, 5, "keyword")] });
    await microtasks();
    expect(previousManager.states.size).toBe(0);
    expect(classes()).toEqual(["semantic-tokens syntax--keyword"]);
    lumine.commands.dispatch(lumine.workspace.getElement(), "semantic-tokens:toggle");
    expect(lumine.config.get("semantic-tokens.enabled")).toBe(false);
  });
});

describe("semantic scope map", () => {
  it("names the syntax classes a grammar would give the same construct", () => {
    expect(propertiesFor("keyword", []).class).toBe("semantic-tokens syntax--keyword");
    expect(propertiesFor("parameter", []).class).toBe(
      "semantic-tokens syntax--variable syntax--parameter",
    );
    expect(propertiesFor("method", ["deprecated"]).class).toBe(
      "semantic-tokens syntax--entity syntax--name syntax--function syntax--method semantic-tokens-strike",
    );
  });

  it("leaves a token it has no name for on the base class alone", () => {
    expect(propertiesFor("somethingElse", []).class).toBe("semantic-tokens");
    expect(propertiesFor(null, ["static"]).class).toBe("semantic-tokens");
  });

  // The properties are decoration overrides, and the renderer compares them by
  // identity before rebuilding a line.
  it("returns the same object for the same classification", () => {
    expect(propertiesFor("keyword", [])).toBe(propertiesFor("keyword", []));
    expect(propertiesFor("variable", ["deprecated"])).toBe(
      propertiesFor("variable", ["deprecated"]),
    );
    expect(propertiesFor("keyword", [])).not.toBe(propertiesFor("string", []));
  });
});
