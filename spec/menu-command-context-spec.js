const path = require("node:path");
const packageRoot = path.join(__dirname, "..");

describe("semantic-tokens menu commands in captured presentation contexts", () => {
  let first, second, firstPane, notebook, captured;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      if (!jasmine.isSpy(lumine.shell[method])) spyOn(lumine.shell, method).and.resolveTo();
    if (!jasmine.isSpy(lumine.application.openWindow))
      spyOn(lumine.application, "openWindow").and.resolveTo();
    jasmine.attachToDOM(lumine.workspace.getElement());
    first = await lumine.workspace.open();
    firstPane = lumine.workspace.paneForItem(first);
    second = lumine.workspace.buildTextEditor();
    await lumine.packages.activatePackage(packageRoot);
    const ScopeDescriptor = second.getRootScopeDescriptor().constructor;
    spyOn(second, "getRootScopeDescriptor").and.returnValue(
      new ScopeDescriptor({ scopes: ["source.menu-context"] }),
    );
    lumine.config.set("semantic-tokens.enabled", true);
    lumine.config.set("semantic-tokens.enabled", true, { scopeSelector: ".source.menu-context" });
    captured = spyOn(lumine.notifications, "addWarning").and.stub();
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("semantic-tokens");
    await lumine.workspace.discardEditorWindows();
    if (notebook) await lumine.workspace.paneForItem(notebook)?.destroyItem(notebook);
    first?.destroy();
    second?.destroy();
    first = second = firstPane = notebook = captured = null;
  });

  it("keeps the invoking window document when the global active editor is elsewhere", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    firstPane.activate();
    firstPane.activateItem(first);
    const button = extra.getDocument().createElement("button");
    extra.getElement().appendChild(button);
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);

    await lumine.commands.dispatch(button, "semantic-tokens:toggle");

    expect(lumine.config.get("semantic-tokens.enabled")).toBe(false);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.calls.argsFor(0)[0]).toContain("stay on for this language");
  });

  it("uses a captured notebook cell from a non-editor command target", async () => {
    const element = document.createElement("div");
    const button = document.createElement("button");
    element.appendChild(button);
    notebook = {
      element,
      getTitle: () => "Command Context Notebook",
      getActiveEmbeddedTextEditor: () => second,
    };
    const pane = firstPane.splitRight();
    pane.activateItem(notebook, { activatePane: true });
    firstPane.activate();
    firstPane.activateItem(first);
    const context = lumine.workspace.resolveCommandContext(button);
    expect(context.editor).toBeUndefined();
    expect(context.embeddedEditor).toBe(second);
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);

    await lumine.commands.dispatch(button, "semantic-tokens:toggle");

    expect(lumine.config.get("semantic-tokens.enabled")).toBe(false);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.calls.argsFor(0)[0]).toContain("stay on for this language");
  });

  it("does not select a shared main editor when the invoking presentation has no document", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    firstPane.activate();
    firstPane.activateItem(first);
    const button = extra.getDocument().createElement("button");
    extra.getElement().appendChild(button);
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);
    const ScopeDescriptor = first.getRootScopeDescriptor().constructor;
    spyOn(first, "getRootScopeDescriptor").and.returnValue(
      new ScopeDescriptor({ scopes: ["source.main-context"] }),
    );
    lumine.config.set("semantic-tokens.enabled", true, { scopeSelector: ".source.main-context" });

    await lumine.commands.dispatch(button, "semantic-tokens:toggle");

    expect(captured).not.toHaveBeenCalled();
  });
});
