const { Emitter, CompositeDisposable } = require("lumine");

// Emit only after viewport changes settle so a flick through a long file or
// a pane resize does not fire a request per frame.
const SCROLL_SETTLE_MS = 150;
// Rows fetched beyond the visible range, so small scrolls are already covered.
const MARGIN_ROWS = 50;

// Per-editor visible-row-range watcher driving the hint requests. Emits
// "stale" with the visible screen-row range converted to buffer rows, padded by
// MARGIN_ROWS and clamped to the buffer.
module.exports = class ViewportTracker {
  constructor() {
    this.emitter = new Emitter();
    this.states = new Map();
    this.subscriptions = new CompositeDisposable(
      lumine.workspace.observeTextEditors((editor) => this.watchEditor(editor)),
    );
  }
  // fn({editor, range: [startBufferRow, endBufferRow]})
  onDidBecomeStale(fn) {
    return this.emitter.on("stale", fn);
  }
  onDidChangeViewport(fn) {
    return this.emitter.on("viewport", fn);
  }
  watchEditor(editor) {
    if (this.states.has(editor) || editor.isMini?.()) return;
    const element = editor.getElement();
    const state = {
      editor,
      timer: null,
      visible: null,
      bufferChanging: false,
      requestedRange: null,
      subscriptions: new CompositeDisposable(),
    };
    this.states.set(editor, state);
    state.subscriptions.add(
      element.onDidChangeScrollTop(() => this.scheduleEmit(state)),
      // Folds and wrapping change the visible buffer rows without necessarily
      // changing scrollTop. Source edits also produce display changes, but the
      // manager already fetches them after the buffer stops changing.
      editor.onDidChange((changes) => {
        if (Array.isArray(changes) && changes.every((change) => change.origin === "highlight"))
          return;
        this.scheduleEmit(state);
      }),
      editor.getBuffer().onDidChange(() => {
        state.bufferChanging = true;
        if (state.timer != null) state.ownerWindow?.clearTimeout(state.timer);
        state.timer = null;
      }),
      editor.onDidStopChanging(() => {
        state.bufferChanging = false;
      }),
      editor.onDidDestroy(() => this.unwatchEditor(editor)),
    );
    for (const [event, callback] of [
      ["onDidAttach", () => this.bindEditorWindow(state)],
      ["onDidDetach", () => this.releaseEditorWindow(state)],
    ]) {
      const subscription = element[event]?.(callback);
      if (subscription) state.subscriptions.add(subscription);
    }
    this.bindEditorWindow(state);
  }
  bindEditorWindow(state) {
    if (this.states.get(state.editor) !== state) return;
    const element = state.editor.getElement();
    const ownerWindow = element.ownerDocument.defaultView;
    if (state.ownerWindow === ownerWindow) return;
    const initialBinding = state.presentationGeneration == null;
    this.releaseEditorWindow(state);
    state.ownerWindow = ownerWindow;
    if (initialBinding) state.visible = null;
    state.requestedRange = null;
    const generation = state.presentationGeneration;
    const current = () =>
      this.states.get(state.editor) === state &&
      state.ownerWindow === ownerWindow &&
      state.presentationGeneration === generation;
    // A background pane reports a meaningless viewport; emit when the editor
    // is revealed so rows scrolled to while hidden catch up. The
    // observer fires after the component's reveal update (didShow renders
    // synchronously), so the measurements read here are current.
    const observer = new ownerWindow.IntersectionObserver((entries) => {
      if (!current()) return;
      const { intersectionRect } = entries[entries.length - 1];
      const visible = intersectionRect.width > 0 || intersectionRect.height > 0;
      if (visible && state.visible !== true) {
        this.viewportChanged(state);
        this.emitStale(state);
      }
      state.visible = visible;
    });
    observer.observe(element);
    state.intersectionObserver = observer;
    const resizeObserver = new ownerWindow.ResizeObserver(() => {
      if (current()) this.scheduleEmit(state);
    });
    resizeObserver.observe(element);
    state.resizeObserver = resizeObserver;
  }
  releaseEditorWindow(state) {
    state.presentationGeneration = (state.presentationGeneration ?? 0) + 1;
    this.clearTimers(state);
    state.ownerWindow = null;
    state.intersectionObserver?.disconnect();
    state.resizeObserver?.disconnect();
    state.intersectionObserver = null;
    state.resizeObserver = null;
    state.visible = false;
  }
  clearTimers(state) {
    for (const key of ["timer"]) {
      if (state[key] != null) state.ownerWindow?.clearTimeout(state[key]);
      state[key] = null;
    }
  }

  unwatchEditor(editor) {
    const state = this.states.get(editor);
    if (!state) return;
    this.releaseEditorWindow(state);
    state.subscriptions.dispose();
    this.states.delete(editor);
  }
  scheduleEmit(state) {
    if (this.states.get(state.editor) !== state || !state.ownerWindow) return;
    const ownerWindow = state.ownerWindow;
    const generation = state.presentationGeneration;
    this.viewportChanged(state);
    if (state.bufferChanging) return;
    if (state.timer != null) state.ownerWindow?.clearTimeout(state.timer);
    const timer = ownerWindow.setTimeout(() => {
      if (
        state.ownerWindow !== ownerWindow ||
        state.presentationGeneration !== generation ||
        state.timer !== timer
      )
        return;
      state.timer = null;
      this.emitStale(state);
    }, SCROLL_SETTLE_MS);
    state.timer = timer;
  }
  viewportChanged(state) {
    if (this.states.get(state.editor) === state && !state.editor.isDestroyed())
      this.emitter.emit("viewport", { editor: state.editor });
  }
  emitStale(state) {
    if (this.states.get(state.editor) !== state || !state.ownerWindow) return;
    if (state.bufferChanging || state.editor.isDestroyed()) return;
    const range = this.measureRangeForEditor(state.editor);
    if (
      state.requestedRange &&
      range[0] === state.requestedRange[0] &&
      range[1] === state.requestedRange[1]
    )
      return;
    this.emitter.emit("stale", { editor: state.editor, range });
  }
  rangeForEditor(editor) {
    const range = this.measureRangeForEditor(editor);
    const state = this.states.get(editor);
    // Called when a provider request is actually dispatched, so an incidental
    // scroll/reflow after a source fetch cannot ask for those same rows again.
    if (state) state.requestedRange = range.slice();
    return range;
  }
  visibleRangeForEditor(editor) {
    return this.measureRangeForEditor(editor, 0);
  }
  measureRangeForEditor(editor, margin = MARGIN_ROWS) {
    const lastBufferRow = editor.getBuffer().getLastRow();
    // An editor that has never been rendered — one opened in a background tab,
    // or observed before its element is attached — reports no visible rows at
    // all. Treat it as showing the top of the buffer rather than converting
    // NaN into a screen position.
    const firstScreenRow = editor.getFirstVisibleScreenRow();
    const lastScreenRow = editor.getLastVisibleScreenRow();
    if (!Number.isFinite(firstScreenRow) || !Number.isFinite(lastScreenRow))
      return [0, Math.min(lastBufferRow, margin)];
    const first = editor.bufferRowForScreenRow(firstScreenRow);
    const last = editor.bufferRowForScreenRow(lastScreenRow);
    return [Math.max(0, first - margin), Math.min(lastBufferRow, last + margin)];
  }
  dispose() {
    for (const editor of [...this.states.keys()]) this.unwatchEditor(editor);
    this.subscriptions.dispose();
    this.emitter.dispose();
  }
};
