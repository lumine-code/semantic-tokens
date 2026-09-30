const { Emitter, CompositeDisposable, Disposable } = require("lumine");

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
      editor.onDidChange(() => this.scheduleEmit(state)),
      editor.getBuffer().onDidChange(() => {
        state.bufferChanging = true;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
      }),
      editor.onDidStopChanging(() => {
        state.bufferChanging = false;
      }),
      editor.onDidDestroy(() => this.unwatchEditor(editor)),
    );
    // A background pane reports a meaningless viewport; emit when the editor
    // is revealed so rows scrolled to while hidden catch up. The
    // observer fires after the component's reveal update (didShow renders
    // synchronously), so the measurements read here are current.
    const observer = new IntersectionObserver((entries) => {
      const { intersectionRect } = entries[entries.length - 1];
      const visible = intersectionRect.width > 0 || intersectionRect.height > 0;
      if (visible && state.visible !== true) this.emitStale(state);
      state.visible = visible;
    });
    observer.observe(element);
    state.subscriptions.add(new Disposable(() => observer.disconnect()));
    const resizeObserver = new ResizeObserver(() => this.scheduleEmit(state));
    resizeObserver.observe(element);
    state.subscriptions.add(new Disposable(() => resizeObserver.disconnect()));
  }
  unwatchEditor(editor) {
    const state = this.states.get(editor);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.subscriptions.dispose();
    this.states.delete(editor);
  }
  scheduleEmit(state) {
    if (this.states.get(state.editor) !== state || state.bufferChanging) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      this.emitStale(state);
    }, SCROLL_SETTLE_MS);
  }
  emitStale(state) {
    if (
      this.states.get(state.editor) !== state ||
      state.bufferChanging ||
      state.editor.isDestroyed()
    )
      return;
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
  measureRangeForEditor(editor) {
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
