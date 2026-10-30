const { CompositeDisposable } = require("lumine");
const ProviderRegistry = require("./provider-registry");
const ViewportTracker = require("./viewport-tracker");
let TokenStore;
let propertiesFor;
const EMPTY_TOKENS = Object.freeze({
  length: 0,
  values: () => [],
  tokensInRows: () => [],
  tokensInRange: () => [],
  map: () => [],
  applyChange: () => ({ removed: [] }),
});

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
          checked: () => Boolean(lumine.config.get("semantic-tokens.enabled")),
          didDispatch: (event) => this.toggle(event),
        },
      }),
      lumine.commands.add("lumine-text-editor:not([mini])", {
        "semantic-tokens:refresh": {
          description: "Ask the providers for this file's tokens again.",
          isAvailable: (event) => {
            const editor = this.editorForEvent(event);
            return Boolean(editor && editor.getGrammar?.() !== lumine.grammars.nullGrammar);
          },
          didDispatch: (event) => this.refresh(event),
        },
      }),
    );
  }

  editorForEvent(event) {
    const direct = lumine.workspace.getTextEditorForElement(event?.target, { includeMini: false });
    if (direct) return direct;
    const context = event?.context;
    if (context)
      return (
        context.embeddedEditor ??
        context.editor ??
        context.window?.getEditorContainer?.()?.getActiveEmbeddedTextEditor?.() ??
        null
      );
    return (
      lumine.workspace.getActiveEmbeddedTextEditor() ??
      lumine.workspace.getActiveTextEditor() ??
      null
    );
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
    const editor = event
      ? lumine.workspace.getTextEditorForElement(event.target, { includeMini: false })
      : this.editorForEvent();
    if (editor) this.fetchEditor(editor);
  }

  watchEditor(editor) {
    if (this.states.has(editor) || editor.isMini?.()) return;
    const state = {
      editor,
      layer: null,
      layerDecoration: null,
      get markers() {
        return [...this.markerTokens.keys()];
      },
      markerTokens: new Map(),
      tokens: EMPTY_TOKENS,
      editPending: false,
      provider: null,
      rangeMode: false,
      rangeProvider: null,
      pendingRangeGeneration: null,
      generation: 0,
      markerGeneration: 0,
      cachedTokens: null,
      renderedRange: null,
      rendering: null,
      building: null,
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
      editor.getBuffer().onWillChange(() => {
        state.editPending = true;
      }),
      editor.getBuffer().onDidApplyChanges((event) => this.bufferChanged(state, event)),
      editor.onDidStopChanging(() => this.fetch(state)),
      editor.onDidChangeGrammar(contextChanged),
      editor.onDidChangePath(contextChanged),
      editor.onDidDestroy(() => this.detachEditor(editor)),
    );
    this.fetch(state);
  }

  bufferChanged(state, { changes, isCurrent }) {
    state.generation++;
    state.pendingRangeGeneration = null;
    if (
      changes.some(
        ({ oldRange, newRange }) =>
          oldRange.start.row !== oldRange.end.row || newRange.start.row !== newRange.end.row,
      )
    )
      state.renderedRange = null;
    state.rendering = null;
    // The index shifts distant token subtrees lazily. Only deleted records need
    // marker cleanup; the layer's custom rule already updated surviving markers.
    for (const change of changes) {
      const { removed } = state.tokens.applyChange(change);
      for (const token of removed) {
        if (token.marker) this.destroyMarker(state, token.marker);
      }
    }
    state.editPending = !isCurrent();
    if (state.editPending || !state.tokens.length) return;
    if (state.cachedTokens) this.renderCachedTokens(state);
    else if (state.building) this.buildMarkers(state, state.tokens.values(), state.generation);
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
    if (editor.getGrammar?.() === lumine.grammars.nullGrammar) return false;
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
    if (state?.cachedTokens && !state.editPending) this.renderCachedTokens(state);
  }

  renderCachedTokens(state) {
    const { editor, cachedTokens } = state;
    if (!cachedTokens || editor.isDestroyed()) return;
    const visible = this.tracker.visibleRangeForEditor(editor);
    const columns = this.tracker.columnRangesForEditor(editor);
    const covered = (ranges) =>
      columns
        ? ranges?.length === columns.length &&
          columns.every((range, index) => ranges[index].isEqual(range))
        : !ranges;
    if (
      state.renderedRange &&
      covered(state.renderedColumns) &&
      visible[0] >= state.renderedRange[0] &&
      visible[1] <= state.renderedRange[1]
    )
      return;
    const pending = state.rendering;
    if (
      pending?.tokens === cachedTokens &&
      pending.generation === state.generation &&
      pending.markerGeneration === state.markerGeneration &&
      covered(pending.columns) &&
      visible[0] >= pending.range[0] &&
      visible[1] <= pending.range[1]
    )
      return pending.promise;
    const range = this.tracker.measureRangeForEditor(editor);
    state.renderedRange = null;
    const generation = state.generation;
    const rendering = {
      tokens: cachedTokens,
      columns,
      range,
      generation,
      markerGeneration: state.markerGeneration + 1,
      promise: null,
    };
    state.rendering = rendering;
    rendering.promise = this.buildMarkers(
      state,
      columns
        ? [...new Set(columns.flatMap(({ start, end }) => cachedTokens.tokensInRange(start, end)))]
        : cachedTokens.tokensInRows(range[0], range[1]),
      generation,
    ).then((complete) => {
      if (
        complete &&
        state.generation === generation &&
        state.markerGeneration === rendering.markerGeneration
      ) {
        state.renderedRange = range;
        state.renderedColumns = columns;
      }
      if (state.rendering === rendering) state.rendering = null;
    });
    return rendering.promise;
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
    if (state.rangeMode && state.rangeProvider === provider)
      return this.rangeFetch(provider, state, generation);
    let tokens;
    try {
      tokens = await provider.semanticTokens(editor);
    } catch {
      return "failed";
    }
    if (state.generation !== generation || editor.isDestroyed()) return "stale";
    if (!tokens) return this.rangeFetch(provider, state, generation);
    state.rangeMode = false;
    state.rangeProvider = null;
    state.provider = provider;
    const changed = await this.acceptTokens(state, tokens, generation);
    if (state.generation !== generation || editor.isDestroyed()) return "stale";
    if (editor.getLineCount() > MAX_BUFFER_LINES || tokens.length > MAX_TOKEN_COUNT) {
      state.cachedTokens = state.tokens;
      await this.renderCachedTokens(state);
      return "rendered";
    }
    if (changed || state.building)
      await this.buildMarkers(state, state.tokens.values(), generation);
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
      state.rangeProvider = provider;
      return "failed";
    }
    if (state.generation !== generation || editor.isDestroyed()) return "stale";
    state.pendingRangeGeneration = null;
    if (!tokens) return "declined";
    state.rangeMode = true;
    state.rangeProvider = provider;
    state.provider = provider;
    const changed = await this.acceptTokens(state, tokens, generation);
    if (state.generation !== generation || editor.isDestroyed()) return "stale";
    if (tokens.length > MAX_TOKEN_COUNT) {
      state.cachedTokens = state.tokens;
      await this.renderCachedTokens(state);
      return "rendered";
    }
    state.cachedTokens = null;
    state.renderedRange = null;
    state.rendering = null;
    if (changed || state.building)
      await this.buildMarkers(state, state.tokens.values(), generation);
    return "rendered";
  }

  async acceptTokens(state, tokens, generation) {
    const isCurrent = () => state.generation === generation && !state.editor.isDestroyed();
    if (await state.tokens.matchesAsync?.(tokens, isCurrent)) return false;
    if (!isCurrent()) return false;
    // Providers own their objects; edit tracking and marker references belong
    // to this generation's independent, ordered snapshot.
    if (tokens.length) {
      TokenStore ||= require("./token-store");
      // Rewalking a huge cache to retain a few viewport markers costs more
      // than rebuilding those markers. Reuse records where decoration work
      // dominates; the equivalent-answer path above still retains any size.
      const reuse = state.markerTokens.size * 2 >= state.tokens.length ? state.tokens : null;
      state.tokens = new TokenStore(tokens, { reuse });
    } else {
      state.tokens = EMPTY_TOKENS;
    }
    state.cachedTokens = null;
    state.renderedRange = null;
    state.rendering = null;
    return true;
  }

  ensureLayer(state) {
    if (state.layer) return;
    state.layer = state.editor.addMarkerLayer({
      maintainHistory: false,
      trackRanges: require("./token-range-tracking").updateTokenMarkerRanges,
    });
    state.layerDecoration = state.editor.decorateMarkerLayer(state.layer, {
      type: "text",
      class: "semantic-tokens",
    });
  }

  batchDecorations(state, callback) {
    // A dev-reloaded package can briefly run in a window whose core has not
    // reloaded yet. The optimization is optional; token publication is not.
    return state.editor.batchDecorations ? state.editor.batchDecorations(callback) : callback();
  }

  async buildMarkers(state, tokens, generation) {
    if (state.generation !== generation || state.editor.isDestroyed()) return false;
    const markerGeneration = ++state.markerGeneration;
    const building = { generation, markerGeneration };
    state.building = building;
    const current = () =>
      state.generation === generation &&
      state.markerGeneration === markerGeneration &&
      !state.editor.isDestroyed();
    const retained = new Set(
      tokens.map((token) => token.marker).filter((marker) => marker && !marker.isDestroyed()),
    );
    const obsolete = state.markers.filter((marker) => !retained.has(marker));
    const recycle =
      state.cachedTokens &&
      state.markerStore === state.tokens &&
      state.markerSourceGeneration === generation &&
      tokens.every(
        (token, index) =>
          index === 0 ||
          token.row !== tokens[index - 1].row ||
          token.column >= tokens[index - 1].column + tokens[index - 1].length,
      );
    const pool = recycle ? obsolete.filter((marker) => !marker.isDestroyed()) : [];
    const missing = tokens.filter((token) => !token.marker || token.marker.isDestroyed());
    if (missing.length) propertiesFor ||= require("./semantic-scope-map").propertiesFor;
    for (let offset = 0; offset < Math.max(1, missing.length); offset += MARKER_CHUNK) {
      if (!current()) return false;
      const end = Math.min(offset + MARKER_CHUNK, missing.length);
      this.batchDecorations(state, () => {
        this.ensureLayer(state);
        const { layer, layerDecoration } = state;
        if (offset === 0 && !recycle)
          for (const marker of obsolete) this.destroyMarker(state, marker);
        for (let i = offset; i < end; i++) {
          const token = missing[i];
          const range = [
            [token.row, token.column],
            [token.row, token.column + token.length],
          ];
          let marker = pool.pop();
          const reused = Boolean(marker);
          if (marker) {
            const previous = state.markerTokens.get(marker);
            if (previous) previous.marker = null;
            state.markerTokens.delete(marker);
          } else marker = layer.markBufferRange(range, { invalidate: "never", exclusive: true });
          const properties = propertiesFor(token.type, token.modifiers || []);
          if (layerDecoration.getPropertiesForMarker(marker)?.class !== properties.class)
            layerDecoration.setPropertiesForMarker(marker, properties);
          token.marker = marker;
          state.markerTokens.set(marker, token);
          if (reused) marker.setBufferRange(range);
        }
        // Never carry old classifications across a yield. Normal viewport
        // shifts fit in one chunk; a dense initial result remains bounded.
        if (offset === 0 && recycle) {
          for (const marker of pool) this.destroyMarker(state, marker);
          pool.length = 0;
        }
      });
      if (!current()) return false;
      if (end < missing.length) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    state.markerStore = state.tokens;
    state.markerSourceGeneration = generation;
    state.markerTokens = new Map(
      tokens.filter((token) => token.marker).map((token) => [token.marker, token]),
    );
    if (state.building === building) state.building = null;
    return true;
  }

  destroyMarker(state, marker) {
    const token = state.markerTokens.get(marker);
    if (token) token.marker = null;
    state.markerTokens.delete(marker);
    // Drop the override first so the LayerDecoration's per-marker map does
    // not accumulate destroyed markers across refetches or source edits.
    state.layerDecoration?.setPropertiesForMarker(marker, null);
    marker.destroy();
  }

  clearMarkers(state) {
    state.markerGeneration++;
    if (!state.editor.isDestroyed()) {
      this.batchDecorations(state, () => {
        for (const marker of state.markers) this.destroyMarker(state, marker);
      });
    }
    state.markerTokens.clear();
    state.markerStore = null;
    state.markerSourceGeneration = null;
    state.building = null;
  }

  clear(state) {
    // Observers of the final removal must not revive the cache being retired.
    state.cachedTokens = null;
    state.renderedRange = null;
    state.rendering = null;
    this.clearMarkers(state);
    state.provider = null;
    state.rangeMode = false;
    state.rangeProvider = null;
    state.tokens = EMPTY_TOKENS;
    state.editPending = false;
    state.pendingRangeGeneration = null;
  }

  dispose() {
    for (const editor of [...this.states.keys()]) this.detachEditor(editor);
    this.subscriptions.dispose();
    this.tracker.dispose();
    this.registry.dispose();
  }
};
