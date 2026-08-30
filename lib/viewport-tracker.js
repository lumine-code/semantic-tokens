const { Emitter, CompositeDisposable } = require("lumine");

// Emit only after scrolling settles so a flick through a long file does not
// fire a request per frame.
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
  watchEditor(editor) {
    if (this.states.has(editor) || editor.isMini?.()) return;
    const element = editor.getElement();
    const state = {
      editor,
      observer: null,
      timer: null,
      visible: null,
      subscriptions: new CompositeDisposable(),
    };
    this.states.set(editor, state);
    state.subscriptions.add(
      element.onDidChangeScrollTop(() => this.scheduleEmit(state)),
      // The buffer already debounces this event (~300 ms after typing stops),
      // so no extra timer is layered on top.
      editor.onDidStopChanging(() => this.emitStale(state)),
      editor.onDidDestroy(() => this.unwatchEditor(editor)),
    );
    const observeSurface = lumine.workspace.observePaneItemSurface;
    if (typeof observeSurface === "function") {
      state.subscriptions.add(
        observeSurface.call(lumine.workspace, editor, () => this.rebindIntersectionObserver(state)),
      );
    } else {
      this.rebindIntersectionObserver(state);
    }
  }
  rebindIntersectionObserver(state) {
    const replacingObserver = state.observer != null;
    this.disconnectIntersectionObserver(state);
    state.visible = replacingObserver ? false : null;
    if (!this.states.has(state.editor) || state.editor.isDestroyed()) return;

    const element = state.editor.getElement();
    const Observer = element.ownerDocument.defaultView?.IntersectionObserver;
    if (typeof Observer !== "function") return;

    // A background pane reports a meaningless viewport; emit when the editor
    // is revealed so rows scrolled to while hidden catch up. The
    // observer fires after the component's reveal update (didShow renders
    // synchronously), so the measurements read here are current.
    const observer = new Observer((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry || state.observer !== observer) return;
      const { intersectionRect } = entry;
      const visible = intersectionRect.width > 0 || intersectionRect.height > 0;
      if (visible && state.visible === false) this.emitStale(state);
      state.visible = visible;
    });
    state.observer = observer;
    observer.observe(element);
  }
  disconnectIntersectionObserver(state) {
    const observer = state.observer;
    state.observer = null;
    if (!observer) return;
    try {
      observer.disconnect();
    } catch {
      // Recovery can rebind after the native Window owning this observer died.
    }
  }
  unwatchEditor(editor) {
    const state = this.states.get(editor);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.disconnectIntersectionObserver(state);
    state.subscriptions.dispose();
    this.states.delete(editor);
  }
  scheduleEmit(state) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      this.emitStale(state);
    }, SCROLL_SETTLE_MS);
  }
  emitStale(state) {
    if (state.editor.isDestroyed()) return;
    this.emitter.emit("stale", { editor: state.editor, range: this.rangeForEditor(state.editor) });
  }
  rangeForEditor(editor) {
    const lastBufferRow = editor.getBuffer().getLastRow();
    // An editor that has never been rendered — one opened in a background tab,
    // or observed before its element is attached — reports no visible rows at
    // all. Treat it as showing the top of the buffer rather than converting
    // NaN into a screen position.
    const firstScreenRow = editor.getFirstVisibleScreenRow();
    const lastScreenRow = editor.getLastVisibleScreenRow();
    if (!Number.isFinite(firstScreenRow) || !Number.isFinite(lastScreenRow))
      return [0, Math.min(lastBufferRow, MARGIN_ROWS)];
    const first = editor.bufferRowForScreenRow(firstScreenRow);
    const last = editor.bufferRowForScreenRow(lastScreenRow);
    return [Math.max(0, first - MARGIN_ROWS), Math.min(lastBufferRow, last + MARGIN_ROWS)];
  }
  dispose() {
    for (const editor of [...this.states.keys()]) this.unwatchEditor(editor);
    this.subscriptions.dispose();
    this.emitter.dispose();
  }
};
