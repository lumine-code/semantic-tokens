const path = require("path");
const { CompositeDisposable, Disposable } = require("lumine");

const packageRoot = path.join(__dirname, "..");

describe("semantic token decoration styles", () => {
  let editor, mainModule, disposables;

  beforeEach(async () => {
    disposables = new CompositeDisposable();
    const workspaceElement = lumine.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    editor = await lumine.workspace.open();
    editor.setText("oldFunction();");
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);

    // Both decorations share one span, and packages of equal stylesheet
    // priority load in activation order. Reproduce linter activating first.
    disposables.add(
      lumine.styles.addStyleSheet(".linter-text { text-decoration: underline dashed; }", {
        priority: 0,
      }),
    );
    const pack = await lumine.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;
    lumine.config.set("semantic-tokens.enabled", true);
  });

  afterEach(async () => {
    disposables.dispose();
    await lumine.packages.deactivatePackage("semantic-tokens");
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
  });

  it("preserves a linter underline on the same span as a deprecated semantic token", async () => {
    const marker = editor.markBufferRange([
      [0, 0],
      [0, 11],
    ]);
    const decoration = editor.decorateMarker(marker, { type: "text", class: "linter-text" });
    disposables.add(
      new Disposable(() => {
        decoration.destroy();
        marker.destroy();
      }),
      mainModule.consumeSemanticTokens({
        semanticTokens: () => [
          { row: 0, column: 0, length: 11, type: "function", modifiers: ["deprecated"] },
        ],
      }),
    );
    for (let i = 0; i < 40; i++) await Promise.resolve();

    const span = editor.getElement().querySelector(".line .semantic-tokens-strike");
    expect(span).not.toBeNull();
    expect(span.classList.contains("linter-text")).toBe(true);
    const style = getComputedStyle(span);
    expect(style.textDecorationLine).toBe("underline");
    expect(style.textDecorationStyle).toBe("dashed");
    expect(style.backgroundImage).toContain("linear-gradient");
  });
});
