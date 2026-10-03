const { CompositeDisposable } = require("lumine");
const ProviderRegistry = require("./provider-registry");
const ViewportTracker = require("./viewport-tracker");
const { propertiesFor } = require("./semantic-scope-map");

// Cache whole-document classifications, but keep large buffers' decorations
// near the viewport. Scrolling can then use the cache before the next paint.
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
      this.tracker.onDidChangeViewport(({ editor }) => this.cachedViewportChanged(editor)),
      lumine.config.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("semantic-tokens.enabled")) this.fetchAll();
      }),
      lumine.commands.add("lumine-workspace", {
        "semantic-tokens:toggle": {
          description: "Turn the semantic highlighting layered over the grammar on or off.",
          didDispatch: (event) => this.toggle(event),
        },
        "semantic-tokens:refresh": {
          description: "Ask the providers for this file's tokens again.",
          didDispatch: (event) => this.refresh(event),
        },
      }),
    );
  }

  editorForEvent(event) {
    const element = event?.target?.closest?.("lumine-text-editor:not([mini])");
    return element?.getModel?.() ?? lumine.workspace.getActiveTextEditor() ?? null;
  }

  // The global value, which is what the settings page shows. A language with an
  // override of its own keeps it, and says so rather than appearing to ignore
  // the command.
  toggle(event) {
    const next = !lumine.config.get("semantic-tokens.enabled");
    lumine.config.set("semantic-tokens.enabled", next);
    const editor = this.editorForEvent(event);
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

  refresh(event) {
    const editor = this.editorForEvent(event);
    if (editor) this.fetchEditor(editor);
  }

  watchEditor(editor) {
    if (this.states.has(editor) || editor.isMini?.()) return;
    const state = {
      editor,
      layer: null,
      layerDecoration: null,
      markers: [],
      provider: null,
      rangeMode: false,
      pendingRangeGeneration: null,
      generation: 0,
      markerGeneration: 0,
      cachedTokens: null,
      renderedRange: null,
      rendering: null,
      subscriptions: new CompositeDisposable(),
    };
    this.states.set(editor, state);
    const contextChanged = () => {
      this.clear(state);
      this.fetch(state);
    };
    state.subscriptions.add(
      // Invalidate in-flight answers immediately, but keep expensive requests
      // behind the buffer's stop-changing debounce.
      editor.getBuffer().onDidChange(() => {
        state.generation++;
        state.cachedTokens = null;
        state.renderedRange = null;
        state.rendering = null;
      }),
      editor.onDidStopChanging(() => this.fetch(state)),
      editor.onDidChangeGrammar(contextChanged),
      editor.onDidChangePath(contextChanged),
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

  // Debounced requests are only needed when the provider cannot supply a full
  // classification. Cached classifications are rendered by the immediate event.
  viewportChanged(editor) {
    const state = this.states.get(editor);
    if (state && (state.rangeMode || state.pendingRangeGeneration === state.generation))
      this.fetch(state);
  }

  cachedViewportChanged(editor) {
    const state = this.states.get(editor);
    if (state?.cachedTokens) this.renderCachedTokens(state);
  }

  renderCachedTokens(state) {
    const { editor, cachedTokens } = state;
    if (!cachedTokens || editor.isDestroyed()) return;
    const visible = this.tracker.visibleRangeForEditor(editor);
    if (
      state.renderedRange &&
      visible[0] >= state.renderedRange[0] &&
      visible[1] <= state.renderedRange[1]
    )
      return;
    const pending = state.rendering;
    if (
      pending?.tokens === cachedTokens &&
      pending.generation === state.generation &&
      pending.markerGeneration === state.markerGeneration &&
      visible[0] >= pending.range[0] &&
      visible[1] <= pending.range[1]
    )
      return pending.promise;
    const range = this.tracker.rangeForEditor(editor);
    state.renderedRange = null;
    const start = this.firstTokenAtRow(cachedTokens, range[0]);
    const end = this.firstTokenAtRow(cachedTokens, range[1] + 1);
    const generation = state.generation;
    const rendering = {
      tokens: cachedTokens,
      range,
      generation,
      markerGeneration: state.markerGeneration + 1,
      promise: null,
    };
    state.rendering = rendering;
    rendering.promise = this.buildMarkers(state, cachedTokens.slice(start, end), generation).then(
      (complete) => {
        if (
          complete &&
          state.generation === generation &&
          state.markerGeneration === rendering.markerGeneration
        )
          state.renderedRange = range;
        if (state.rendering === rendering) state.rendering = null;
      },
    );
    return rendering.promise;
  }

  firstTokenAtRow(tokens, row) {
    let first = 0;
    let last = tokens.length;
    while (first < last) {
      const middle = Math.floor((first + last) / 2);
      if (tokens[middle].row < row) first = middle + 1;
      else last = middle;
    }
    return first;
  }

  // Only one provider may classify a buffer: two token sets over the same rows
  // would compound their classes into a classification neither one sent. So the
  // providers are tried in priority order and the first that does not decline
  // owns the editor.
  async fetch(state) {
    const { editor } = state;
    const generation = ++state.generation;
    state.pendingRangeGeneration = null;
    if (!this.enabledFor(editor)) return this.clear(state);
    const providers = this.registry.getAllProvidersForEditor(editor);
    if (state.provider && !providers.includes(state.provider)) this.clear(state);
    if (!providers.length) return this.clear(state);
    for (const provider of providers) {
      if (state.generation !== generation || editor.isDestroyed()) return;
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
    // A provider that only serves ranges still uses debounced viewport requests.
    if (state.rangeMode) return this.rangeFetch(provider, state, generation);
    let tokens;
    try {
      tokens = await provider.semanticTokens(editor);
    } catch {
      return "failed";
    }
    if (state.generation !== generation || editor.isDestroyed()) return "stale";
    if (!tokens) return this.rangeFetch(provider, state, generation);
    state.provider = provider;
    state.cachedTokens = null;
    state.renderedRange = null;
    state.rendering = null;
    if (editor.getLineCount() > MAX_BUFFER_LINES || tokens.length > MAX_TOKEN_COUNT) {
      state.cachedTokens = tokens
        .filter((token) => token?.length)
        .sort((a, b) => a.row - b.row || a.column - b.column);
      await this.renderCachedTokens(state);
      return "rendered";
    }
    await this.buildMarkers(state, tokens, generation);
    return "rendered";
  }

  async rangeFetch(provider, state, generation) {
    const { editor } = state;
    if (typeof provider.semanticTokensInRange !== "function") return "declined";
    state.pendingRangeGeneration = generation;
    let tokens;
    try {
      tokens = await provider.semanticTokensInRange(editor, this.tracker.rangeForEditor(editor));
    } catch {
      if (state.generation !== generation || editor.isDestroyed()) return "stale";
      state.pendingRangeGeneration = null;
      // The request was dispatched, so the editor is a viewport-only one from
      // here on however that request ended.
      state.rangeMode = true;
      return "failed";
    }
    if (state.generation !== generation || editor.isDestroyed()) return "stale";
    state.pendingRangeGeneration = null;
    if (!tokens) return "declined";
    state.rangeMode = true;
    state.provider = provider;
    state.cachedTokens = null;
    state.renderedRange = null;
    state.rendering = null;
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
    if (state.generation !== generation || state.editor.isDestroyed()) return false;
    this.clearMarkers(state);
    const markerGeneration = state.markerGeneration;
    this.ensureLayer(state);
    const { layer, layerDecoration } = state;
    for (let offset = 0; offset < tokens.length; offset += MARKER_CHUNK) {
      if (
        state.generation !== generation ||
        state.markerGeneration !== markerGeneration ||
        state.editor.isDestroyed()
      )
        return false;
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
    return true;
  }

  clearMarkers(state) {
    state.markerGeneration++;
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
    state.provider = null;
    state.pendingRangeGeneration = null;
    state.cachedTokens = null;
    state.renderedRange = null;
    state.rendering = null;
  }

  dispose() {
    for (const editor of [...this.states.keys()]) this.detachEditor(editor);
    this.subscriptions.dispose();
    this.tracker.dispose();
    this.registry.dispose();
  }
};
