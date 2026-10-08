const { CompositeDisposable, Disposable, Emitter } = require("lumine");

describe("semantic-tokens provider ownership", () => {
  let registry, disposables, emitter, provider;

  beforeEach(async () => {
    const pack = await lumine.packages.activatePackage("semantic-tokens");
    registry = pack.mainModule.manager.registry;
    disposables = new CompositeDisposable();
    emitter = new Emitter();
    provider = {
      semanticTokens: () => [],
      onDidInvalidate: jasmine
        .createSpy("subscribe")
        .and.callFake((callback) => emitter.on("invalidate", callback)),
    };
  });

  afterEach(async () => {
    disposables.dispose();
    emitter.dispose();
    await lumine.packages.deactivatePackage("semantic-tokens");
  });

  function publish(value = provider) {
    const edge = lumine.packages.serviceHub.provide("semantic-tokens.provider", "1.0.0", value);
    disposables.add(edge);
    return edge;
  }

  it("keeps one provider and one invalidation subscription for duplicate hub payloads", () => {
    const first = publish();
    const second = publish();
    const invalidate = jasmine.createSpy("invalidate");
    disposables.add(registry.onDidInvalidate(invalidate));
    const editor = { getGrammar: () => ({ scopeName: "source.js" }) };
    expect(registry.getAllProvidersForEditor(editor)).toEqual([provider]);
    expect(provider.onDidInvalidate).toHaveBeenCalledTimes(1);
    emitter.emit("invalidate", { editor });
    expect(invalidate).toHaveBeenCalledOnceWith({ provider, editor });
    first.dispose();
    invalidate.calls.reset();
    emitter.emit("invalidate");
    expect(invalidate).toHaveBeenCalledOnceWith({ provider, editor: null });
    second.dispose();
    invalidate.calls.reset();
    emitter.emit("invalidate");
    expect(invalidate).not.toHaveBeenCalled();
    expect(registry.getAllProvidersForEditor(editor)).toEqual([]);
  });

  it("ignores an old lease after explicit removal and registration of the same payload", () => {
    const old = registry.addProvider(provider);
    disposables.add(old);
    registry.removeProvider(provider);
    disposables.add(registry.addProvider(provider));
    old.dispose();
    const invalidate = jasmine.createSpy("invalidate");
    disposables.add(registry.onDidInvalidate(invalidate));
    emitter.emit("invalidate");
    expect(invalidate).toHaveBeenCalledOnceWith({ provider, editor: null });
  });

  it("releases every duplicate lease's listener when the registry is disposed", () => {
    disposables.add(registry.addProvider(provider), registry.addProvider(provider));
    registry.dispose();
    expect(emitter.listenerCountForEventName("invalidate")).toBe(0);
  });

  it("disposes a subscription returned after the registry retires reentrantly", () => {
    const disposed = jasmine.createSpy("subscription disposed");
    provider.onDidInvalidate.and.callFake(() => {
      registry.dispose();
      return new Disposable(disposed);
    });
    disposables.add(registry.addProvider(provider));
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(registry.providers).toEqual([]);
  });

  it("reads changing grammar scopes and preserves equal-priority registration order", () => {
    let scopes = ["source.js"];
    Object.defineProperty(provider, "grammarScopes", { get: () => scopes });
    const second = { semanticTokens: () => [], priority: 0 };
    publish();
    publish(second);
    const editor = { getGrammar: () => ({ scopeName: "source.js" }) };
    expect(registry.getAllProvidersForEditor(editor)).toEqual([provider, second]);
    scopes = ["source.python"];
    expect(registry.getAllProvidersForEditor(editor)).toEqual([second]);
  });
});
