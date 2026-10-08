const os = require("os");
const path = require("path");
const { CompositeDisposable, Emitter } = require("lumine");

const packageRoot = path.join(__dirname, "..");
const token = (row, column = 0) => ({ row, column, length: 4, type: "enum" });

async function microtasks(count = 40) {
  for (let index = 0; index < count; index++) await Promise.resolve();
}

describe("semantic token manager performance boundaries", () => {
  let mainModule, manager, editor, disposables;

  beforeEach(async () => {
    const workspaceElement = lumine.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    disposables = new CompositeDisposable();
    editor = await lumine.workspace.open(path.join(os.tmpdir(), "semantic-token-performance.txt"));
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

  async function classify(source, tokens) {
    editor.setText(source);
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    const emitter = new Emitter();
    const fullFetch = jasmine.createSpy("fullFetch").and.returnValue(tokens);
    disposables.add(
      mainModule.consumeSemanticTokens({
        grammarScopes: [editor.getGrammar().scopeName],
        semanticTokens: fullFetch,
        onDidInvalidate: (callback) => emitter.on("invalidate", callback),
      }),
      emitter,
    );
    await microtasks();
    const state = manager.states.get(editor);
    // The small-document fixture deliberately spans all ten marker batches.
    for (let batch = 0; batch < 20 && state.building; batch++) {
      advanceClock(0);
      await microtasks();
    }
    expect(state.building).toBeNull();
    expect(fullFetch).toHaveBeenCalledTimes(1);
    return { state, fullFetch };
  }

  function trackWork(state) {
    state.tokens.measure = true;
    const values = spyOn(state.tokens, "values").and.callThrough();
    const map = spyOn(state.tokens, "map").and.callThrough();
    const queries = spyOn(state.tokens, "tokensInRows").and.callThrough();
    const builds = spyOn(manager, "buildMarkers").and.callThrough();
    const policy = jasmine.createSpy("token policy").and.callFake(state.layer.getRangeTracker());
    state.layer.setRangeTracker(policy);
    return { values, map, queries, builds, policy };
  }

  it("edits and scrolls a 100k-token document without enumerating the full cache", async () => {
    const count = 100000;
    const { state, fullFetch } = await classify(
      "spri\n".repeat(count),
      Array.from({ length: count }, (_, row) => token(row)),
    );
    expect(state.cachedTokens).toBe(state.tokens);
    expect(state.markerTokens.size).toBeLessThan(250);
    const work = trackWork(state);
    const firstMarker = state.markerTokens.keys().next().value;

    editor.getBuffer().insert([0, 2], "x");
    await microtasks();
    expect(work.values).not.toHaveBeenCalled();
    expect(work.map).not.toHaveBeenCalled();
    expect(work.queries).not.toHaveBeenCalled();
    expect(work.builds).not.toHaveBeenCalled();
    expect(state.tokens.lastEditMetrics.affected).toBe(1);
    expect(state.tokens.lastEditMetrics.visited).toBeLessThan(250);
    expect(work.policy).toHaveBeenCalledTimes(1);
    expect(work.policy.calls.mostRecent().args[0].length).toBe(1);
    expect(firstMarker.getBufferRange()).toEqual([
      [0, 0],
      [0, 5],
    ]);

    const element = editor.getElement();
    element.setScrollTop(50000 * element.component.getLineHeight());
    await microtasks();
    expect(work.queries).toHaveBeenCalled();
    expect(state.tokens.lastQueryMetrics.visited).toBeLessThan(250);
    expect(state.markerTokens.size).toBeGreaterThan(0);
    expect(state.markerTokens.size).toBeLessThan(250);
    expect(state.markerTokens.keys().next().value.getBufferRange().start.row).toBeGreaterThan(
      49000,
    );
    expect(work.values).not.toHaveBeenCalled();
    expect(work.map).not.toHaveBeenCalled();
    expect(fullFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a warm 20k-marker document out of marker reconstruction on each keystroke", async () => {
    const count = 20000;
    const { state, fullFetch } = await classify(
      Array(4000).fill("spri spri spri spri spri").join("\n"),
      Array.from({ length: count }, (_, index) => token(Math.floor(index / 5), (index % 5) * 5)),
    );
    expect(state.cachedTokens).toBeNull();
    expect(state.markerTokens.size).toBe(count);
    const firstMarker = state.markerTokens.keys().next().value;
    const work = trackWork(state);

    editor.getBuffer().insert([0, 2], "x");
    await microtasks();
    expect(state.markerTokens.size).toBe(count);
    expect(firstMarker.getBufferRange()).toEqual([
      [0, 0],
      [0, 5],
    ]);
    expect(work.values).not.toHaveBeenCalled();
    expect(work.map).not.toHaveBeenCalled();
    expect(work.queries).not.toHaveBeenCalled();
    expect(work.builds).not.toHaveBeenCalled();
    expect(state.tokens.lastEditMetrics.affected).toBe(1);
    expect(state.tokens.lastEditMetrics.visited).toBeLessThan(250);
    expect(work.policy).toHaveBeenCalledTimes(1);
    expect(work.policy.calls.mostRecent().args[0].length).toBe(1);
    expect(fullFetch).toHaveBeenCalledTimes(1);
  });
});
