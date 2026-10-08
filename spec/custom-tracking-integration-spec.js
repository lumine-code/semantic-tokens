const path = require("path");
const { CompositeDisposable } = require("lumine");

const packageRoot = path.join(__dirname, "..");

async function microtasks() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe("semantic token range tracking integration", () => {
  let editor, mainModule, manager, disposables;

  beforeEach(async () => {
    const element = lumine.workspace.getElement();
    element.style.width = "800px";
    element.style.height = "400px";
    jasmine.attachToDOM(element);
    editor = await lumine.workspace.open();
    editor.setText("spri\nfunc\n");
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    disposables = new CompositeDisposable();
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

  async function classify(tokens) {
    let initial = true;
    disposables.add(
      mainModule.consumeSemanticTokens({
        grammarScopes: [editor.getGrammar().scopeName],
        semanticTokens() {
          if (!initial) return new Promise(() => {});
          initial = false;
          return tokens;
        },
      }),
    );
    await microtasks();
    return manager.states.get(editor);
  }

  it("uses ordinary markers with a package-owned layer policy", async () => {
    const state = await classify([{ row: 0, column: 0, length: 4, type: "enum" }]);
    expect(typeof state.layer.getRangeTracker()).toBe("function");
    const [marker] = state.markers;
    expect(marker.getInvalidationStrategy()).toBe("never");
    expect(marker.isExclusive()).toBe(true);
    editor.getBuffer().insert([0, 4], "_");
    await microtasks();
    expect(state.markers).toEqual([marker]);
    expect(marker.getBufferRange()).toEqual([
      [0, 0],
      [0, 5],
    ]);
    expect(marker.isValid()).toBe(true);
  });

  it("keeps cached and visible ranges equal through splits and temporary deletion", async () => {
    editor.setText("spri\nfunc\n" + "\n".repeat(6000));
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    const state = await classify([
      { row: 0, column: 0, length: 4, type: "enum" },
      { row: 1, column: 0, length: 4, type: "function" },
    ]);
    const [first, removed] = state.markers;
    const buffer = editor.getBuffer();
    buffer.transact(() => {
      buffer.delete([
        [1, 0],
        [1, 4],
      ]);
      buffer.insert([1, 0], "func");
      buffer.insert([0, 2], "\n");
    });
    await microtasks();
    expect(removed.isDestroyed()).toBe(true);
    expect(state.markers).toEqual([first]);
    expect(state.cachedTokens.map(({ row, column, length }) => [row, column, length])).toEqual([
      [0, 0, 2],
    ]);
    expect(first.getBufferRange()).toEqual([
      [0, 0],
      [0, 2],
    ]);
    expect(buffer.getTextInRange(first.getBufferRange())).toBe("sp");
    expect(state.layerDecoration.overridePropertiesByMarker.size).toBe(1);
  });

  it("releases the runtime callback and creates one for the current package generation", async () => {
    const state = await classify([{ row: 0, column: 0, length: 4, type: "enum" }]);
    const previousLayer = state.layer;
    const previousTracker = previousLayer.getRangeTracker();
    const previousManager = manager;
    await lumine.packages.unloadPackage("semantic-tokens");
    expect(previousLayer.isDestroyed()).toBe(true);
    expect(previousLayer.getRangeTracker()).toBeNull();
    expect(previousManager.states.size).toBe(0);
    const pack = await lumine.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;
    manager = mainModule.manager;
    const current = await classify([{ row: 0, column: 0, length: 4, type: "enum" }]);
    expect(current.layer.getRangeTracker()).not.toBe(previousTracker);
    editor.getBuffer().insert([0, 2], "\n");
    await microtasks();
    expect(current.markers[0].getBufferRange()).toEqual([
      [0, 0],
      [0, 2],
    ]);
  });
});
