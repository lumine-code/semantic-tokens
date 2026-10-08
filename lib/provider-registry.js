const { Emitter, Disposable } = require("lumine");

// Keeps the providers of one service. `grammarScopes` is read through on every
// call: hub providers expose it as a getter whose value changes as language
// server sessions come and go, so it must never be snapshotted.
module.exports = class ProviderRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.providers = [];
    this.invalidations = new Map();
    this.disposed = false;
  }

  addProvider(provider) {
    if (this.disposed || !provider || typeof provider.semanticTokens !== "function") {
      return new Disposable();
    }
    let record = this.invalidations.get(provider);
    if (record) {
      record.references++;
      return new Disposable(() => this.releaseProvider(provider, record));
    }
    record = { references: 1, subscription: null };
    this.invalidations.set(provider, record);
    this.providers.push(provider);
    // A provider's own invalidation subscription is held here rather than
    // handed back, so a consumer that disposes only what it was given still
    // leaves nothing subscribed to a provider that is gone.
    try {
      const subscription = provider.onDidInvalidate?.((event) => {
        if (!this.disposed && this.invalidations.get(provider) === record) {
          this.emitter.emit("invalidate", { provider, editor: event?.editor ?? null });
        }
      });
      if (this.invalidations.get(provider) === record) record.subscription = subscription;
      else subscription?.dispose();
    } catch (error) {
      this.removeProvider(provider, record);
      throw error;
    }
    if (this.invalidations.get(provider) === record) this.emitter.emit("change");
    return new Disposable(() => this.releaseProvider(provider, record));
  }

  releaseProvider(provider, record) {
    if (this.invalidations.get(provider) !== record) return;
    if (--record.references === 0) this.removeProvider(provider, record);
  }

  removeProvider(provider, record = this.invalidations.get(provider)) {
    if (!record || this.invalidations.get(provider) !== record) return;
    const index = this.providers.indexOf(provider);
    this.providers.splice(index, 1);
    this.invalidations.delete(provider);
    record.subscription?.dispose();
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
    if (this.disposed) return;
    this.disposed = true;
    const records = [...this.invalidations.values()];
    this.invalidations.clear();
    this.providers = [];
    this.emitter.dispose();
    for (const record of records) record.subscription?.dispose();
  }
};
