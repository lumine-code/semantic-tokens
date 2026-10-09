describe("semantic provider range mode ownership", () => {
  let main, editor, providers;
  const tokens = (type) => [{ row: 0, column: 0, length: 4, type }];
  async function flush() {
    for (let index = 0; index < 50; index++) await Promise.resolve();
  }
  function provide(provider) {
    const lease = lumine.packages.serviceHub.provide("semantic-tokens.provider", "1.0.0", provider);
    providers.push(lease);
    return lease;
  }
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    editor = await lumine.workspace.open();
    editor.setText("word");
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    main = (await lumine.packages.activatePackage("semantic-tokens")).mainModule;
    providers = [];
  });
  afterEach(async () => {
    for (const provider of providers) provider.dispose();
    await lumine.packages.deactivatePackage("semantic-tokens");
    editor.destroy();
  });
  it("asks a new higher-priority full provider after a range provider classified the editor", async () => {
    const ranged = {
      priority: 1,
      semanticTokens: () => null,
      semanticTokensInRange: () => tokens("string"),
    };
    provide(ranged);
    await flush();
    expect(main.manager.states.get(editor).provider).toBe(ranged);
    const full = {
      priority: 2,
      semanticTokens: jasmine.createSpy("full").and.returnValue(tokens("keyword")),
    };
    provide(full);
    await flush();
    expect(full.semanticTokens).toHaveBeenCalled();
    expect(main.manager.states.get(editor).provider).toBe(full);
    expect(
      editor
        .getElement()
        .querySelector(".line .semantic-tokens")
        ?.classList.contains("syntax--keyword"),
    ).toBe(true);
  });
  it("uses a full-only fallback after the active range provider is withdrawn", async () => {
    const full = {
      priority: 1,
      semanticTokens: jasmine.createSpy("full").and.returnValue(tokens("keyword")),
    };
    const ranged = {
      priority: 2,
      semanticTokens: () => null,
      semanticTokensInRange: () => tokens("string"),
    };
    provide(full);
    const lease = provide(ranged);
    await flush();
    expect(main.manager.states.get(editor).provider).toBe(ranged);
    full.semanticTokens.calls.reset();
    lease.dispose();
    await flush();
    expect(full.semanticTokens).toHaveBeenCalled();
    expect(main.manager.states.get(editor).provider).toBe(full);
    expect(
      editor
        .getElement()
        .querySelector(".line .semantic-tokens")
        ?.classList.contains("syntax--keyword"),
    ).toBe(true);
  });
});
