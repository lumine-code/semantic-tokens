const { CompositeDisposable } = require("lumine");
const ProviderRegistry = require("./provider-registry");
const ViewportTracker = require("./viewport-tracker");
const { propertiesFor } = require("./semantic-scope-map");

// Budgets: past these, whole-document decoration is not worth the marker count.
// Fall back to viewport-only requests, or skip the feature when the provider
// cannot serve ranges either.
const MAX_BUFFER_LINES = 5000;
const MAX_TOKEN_COUNT = 20000;
// Markers created per batch before yielding, to avoid long main-thread tasks.
const MARKER_CHUNK = 2000;

// Overlays the registered providers' tokens as text decorations carrying
// conventional syntax--* classes, so themes color them like grammar scopes.
// The gate is the scoped config semantic-tokens.enabled.
module.exports = class SemanticTokensManager {
  constructor() {
    this.registry = new ProviderRegistry();
    this.tracker = new ViewportTracker();
    this.states = new Map();
    this.subscriptions = new CompositeDisposable(
      lumine.workspace.observeTextEditors((editor) => this.watchEditor(editor)),
      this.registry.onDidChange(() => this.fetchAll()),
      this.registry.onDidInvalidate(({ editor }) =>
        editor ? this.fetchEditor(editor) : this.fetchAll(),
      ),
      this.tracker.onDidBecomeStale(({ editor }) => this.viewportChanged(editor)),
      lumine.config.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("semantic-tokens.enabled")) this.fetchAll();
      }),
      lumine.commands.add("lumine-workspace", {
        "semantic-tokens:toggle": {
          description: "Turn the semantic highlighting layered over the grammar on or off.",
          didDispatch: () => this.toggle(),
        },
        "semantic-tokens:refresh": {
          description: "Ask the providers for this file's tokens again.",
          didDispatch: () => this.refresh(),
        },
      }),
    );
  }

  // The global value, which is what the settings page shows. A language with an
  // override of its own keeps it, and says so rather than appearing to ignore
  // the command.
  toggle() {
    const next = !lumine.config.get("semantic-tokens.enabled");
    lumine.config.set("semantic-tokens.enabled", next);
    const editor = lumine.workspace.getActiveTextEditor();
    if (!editor) return;
    const scoped = lumine.config.get("semantic-tokens.enabled", {
      scope: editor.getRootScopeDescriptor(),
    });
    if (scoped === next) return;
    lumine.notifications.addWarning(
      `Semantic tokens stay ${scoped ? "on" : "off"} for this language`,
      {
        description:
          "This language has a setting of its own, which wins over the one just changed. Change it on the Semantic Tokens settings page.",
      },
    );
  }

  refresh() {
    const editor = lumine.workspace.getActiveTextEditor();
    if (editor) this.fetchEditor(editor);
  }

  watchEditor(editor) {
    if (this.states.has(editor) || editor.isMini?.()) return;
    const state = {
      editor,
      layer: null,
      layerDecoration: null,
      markers: [],
      rangeMode: false,
      generation: 0,
      subscriptions: new CompositeDisposable(),
    };
    this.states.set(editor, state);
    state.subscriptions.add(
      editor.onDidStopChanging(() => this.fetch(state)),
      // A grammar change swaps which providers serve the editor.
      editor.onDidChangeGrammar(() => this.fetch(state)),
      editor.onDidDestroy(() => this.detachEditor(editor)),
    );
    this.fetch(state);
  }

  detachEditor(editor) {
    const state = this.states.get(editor);
    if (!state) return;
    state.generation++;
    state.subscriptions.dispose();
    this.clear(state);
    state.layerDecoration?.destroy();
    if (!editor.isDestroyed()) state.layer?.destroy();
    this.states.delete(editor);
  }

  enabledFor(editor) {
    return !!lumine.config.get("semantic-tokens.enabled", {
      scope: editor.getRootScopeDescriptor(),
    });
  }

  fetchAll() {
    for (const state of this.states.values()) this.fetch(state);
  }

  fetchEditor(editor) {
    const state = this.states.get(editor);
    if (state) this.fetch(state);
  }

  // Only viewport-only mode cares where the viewport is; a whole-document set
  // already covers every row.
  viewportChanged(editor) {
    const state = this.states.get(editor);
    if (state?.rangeMode) this.fetch(state);
  }

  // Only one provider may classify a buffer: two token sets over the same rows
  // would compound their classes into a classification neither one sent. So the
  // providers are tried in priority order and the first that does not decline
  // owns the editor.
  async fetch(state) {
    const { editor } = state;
    const generation = ++state.generation;
    if (!this.enabledFor(editor)) return this.clear(state);
    const providers = this.registry.getAllProvidersForEditor(editor);
    if (!providers.length) return this.clear(state);
    for (const provider of providers) {
      const outcome = await this.tryProvider(provider, state, generation);
      if (outcome !== "declined") return;
    }
    if (state.generation === generation && !editor.isDestroyed()) this.clear(state);
  }

  // "rendered" — the tokens are on screen. "declined" — this provider has
  // nothing for this editor, so ask the next one. "failed" — the request broke
  // transiently, and what is on screen stays until the next fetch. "stale" —
  // another fetch overtook this one and owns the editor now.
  async tryProvider(provider, state, generation) {
    const { editor } = state;
    // Viewport-only mode is sticky for the editor once a budget trips; the next
    // full fetch would only trip it again.
    if (state.rangeMode || editor.getLineCount() > MAX_BUFFER_LINES)
      return this.rangeFetch(provider, state, generation);
    let tokens;
    try {
      tokens = await provider.semanticTokens(editor);
    } catch {
      return "failed";
    }
    if (state.generation !== generation || editor.isDestroyed()) return "stale";
    if (!tokens) return this.rangeFetch(provider, state, generation);
    if (tokens.length > MAX_TOKEN_COUNT) return this.rangeFetch(provider, state, generation);
    await this.buildMarkers(state, tokens, generation);
    return "rendered";
  }

  async rangeFetch(provider, state, generation) {
    const { editor } = state;
    if (typeof provider.semanticTokensInRange !== "function") return "declined";
    let tokens;
    try {
      tokens = await provider.semanticTokensInRange(editor, this.tracker.rangeForEditor(editor));
    } catch {
      // The request was dispatched, so the editor is a viewport-only one from
      // here on however that request ended.
      state.rangeMode = true;
      return "failed";
    }
    if (state.generation !== generation || editor.isDestroyed()) return "stale";
    if (!tokens) return "declined";
    state.rangeMode = true;
    await this.buildMarkers(state, tokens, generation);
    return "rendered";
  }

  ensureLayer(state) {
    if (state.layer) return;
    state.layer = state.editor.addMarkerLayer({ maintainHistory: false });
    state.layerDecoration = state.editor.decorateMarkerLayer(state.layer, {
      type: "text",
      class: "semantic-tokens",
    });
  }

  async buildMarkers(state, tokens, generation) {
    this.clearMarkers(state);
    this.ensureLayer(state);
    const { layer, layerDecoration } = state;
    for (let offset = 0; offset < tokens.length; offset += MARKER_CHUNK) {
      if (state.generation !== generation || state.editor.isDestroyed()) return;
      const end = Math.min(offset + MARKER_CHUNK, tokens.length);
      for (let i = offset; i < end; i++) {
        const token = tokens[i];
        if (!token?.length) continue;
        const marker = layer.markBufferRange(
          [
            [token.row, token.column],
            [token.row, token.column + token.length],
          ],
          { invalidate: "touch" },
        );
        layerDecoration.setPropertiesForMarker(
          marker,
          propertiesFor(token.type, token.modifiers || []),
        );
        state.markers.push(marker);
      }
      if (end < tokens.length) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  clearMarkers(state) {
    if (!state.editor.isDestroyed()) {
      for (const marker of state.markers) {
        // Drop the override first so the LayerDecoration's per-marker map does
        // not accumulate destroyed markers across refetches.
        state.layerDecoration?.setPropertiesForMarker(marker, null);
        marker.destroy();
      }
    }
    state.markers.length = 0;
  }

  clear(state) {
    this.clearMarkers(state);
  }

  dispose() {
    for (const editor of [...this.states.keys()]) this.detachEditor(editor);
    this.subscriptions.dispose();
    this.tracker.dispose();
    this.registry.dispose();
  }
};
