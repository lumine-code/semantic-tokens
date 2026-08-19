const { Emitter, Disposable } = require("lumine");

// Keeps the providers of one service. `grammarScopes` is read through on every
// call: hub providers expose it as a getter whose value changes as language
// server sessions come and go, so it must never be snapshotted.
module.exports = class ProviderRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.providers = [];
    this.invalidations = new Map();
  }

  addProvider(provider) {
    if (!provider || typeof provider.semanticTokens !== "function") return new Disposable(() => {});
    this.providers.push(provider);
    // A provider's own invalidation subscription is held here rather than
    // handed back, so a consumer that disposes only what it was given still
    // leaves nothing subscribed to a provider that is gone.
    const subscription = provider.onDidInvalidate?.((event) =>
      this.emitter.emit("invalidate", { provider, editor: event?.editor ?? null }),
    );
    if (subscription) this.invalidations.set(provider, subscription);
    this.emitter.emit("change");
    return new Disposable(() => this.removeProvider(provider));
  }

  removeProvider(provider) {
    const index = this.providers.indexOf(provider);
    if (index === -1) return;
    this.providers.splice(index, 1);
    this.invalidations.get(provider)?.dispose();
    this.invalidations.delete(provider);
    this.emitter.emit("change");
  }

  // All providers claiming the editor's grammar, highest priority first. The
  // sort is stable, so equal priorities keep registration order, which is what
  // decides who wins when two providers offer the same hint.
  getAllProvidersForEditor(editor) {
    const scopeName = editor.getGrammar()?.scopeName;
    return this.providers
      .filter((provider) => {
        const scopes = provider.grammarScopes;
        return !scopes || Array.from(scopes).includes(scopeName);
      })
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  // fn() — a provider was added or removed.
  onDidChange(fn) {
    return this.emitter.on("change", fn);
  }

  // fn({provider, editor}) — a provider says its hints went stale. A null
  // editor means every editor it serves.
  onDidInvalidate(fn) {
    return this.emitter.on("invalidate", fn);
  }

  dispose() {
    for (const subscription of this.invalidations.values()) subscription.dispose();
    this.invalidations.clear();
    this.providers = [];
    this.emitter.dispose();
  }
};
