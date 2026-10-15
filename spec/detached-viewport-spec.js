describe("Viewport tracking across editor windows", () => {
  let editor, tracker, extra, mainObservers;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    editor = await lumine.workspace.open();
    editor.setText("x\n".repeat(300));
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    spyOn(editor, "getFirstVisibleScreenRow").and.returnValue(0);
    spyOn(editor, "getLastVisibleScreenRow").and.returnValue(20);
    extra = await lumine.workspace.openEditorWindow({ show: false });
    mainObservers = [];
    spyOn(window, "IntersectionObserver").and.callFake(function (callback) {
      const observer = { callback, observe() {}, disconnect: jasmine.createSpy("disconnect") };
      mainObservers.push(observer);
      return observer;
    });
    const ViewportTracker = require("../lib/viewport-tracker");
    tracker = new ViewportTracker();
  });

  afterEach(async () => {
    tracker.dispose();
    await lumine.workspace.discardEditorWindows();
  });

  it("rebinds viewport observers and scroll timers to the editor's new window", async () => {
    const target = extra.getDOMWindow();
    const observe = jasmine.createSpy("observe in destination");
    const intersection = spyOn(target, "IntersectionObserver").and.callFake(function () {
      return { observe, disconnect() {} };
    });
    const resize = spyOn(target, "ResizeObserver").and.callThrough();
    await lumine.workspace.movePaneItem(editor, {
      targetPane: extra.getEditorContainer().getActivePane(),
    });
    expect(mainObservers[0].disconnect).toHaveBeenCalled();
    expect(intersection).toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(editor.getElement());
    expect(resize).toHaveBeenCalled();
    const timer = spyOn(target, "setTimeout").and.callThrough();
    tracker.scheduleEmit(tracker.states.get(editor));
    expect(timer).toHaveBeenCalled();
  });

  it("retires scroll callbacks queued in the source window before transfer", async () => {
    const timer = spyOn(window, "setTimeout").and.callThrough();
    const state = tracker.states.get(editor);
    tracker.rangeForEditor(editor);
    tracker.scheduleEmit(state);
    const callback = timer.calls.mostRecent().args[0];
    await lumine.workspace.movePaneItem(editor, {
      targetPane: extra.getEditorContainer().getActivePane(),
    });
    editor.getLastVisibleScreenRow.and.returnValue(100);
    const stale = jasmine.createSpy("stale viewport");
    tracker.onDidBecomeStale(stale);
    callback();
    expect(stale).not.toHaveBeenCalled();
  });

  it("ignores a source-window observer after a round trip back to that window", async () => {
    const originalPane = lumine.workspace.paneForItem(editor);
    const obsoleteObserver = mainObservers[0];
    await lumine.workspace.movePaneItem(editor, {
      targetPane: extra.getEditorContainer().getActivePane(),
    });
    await lumine.workspace.movePaneItem(editor, { targetPane: originalPane });
    advanceClock(200);
    editor.getLastVisibleScreenRow.and.returnValue(100);
    const stale = jasmine.createSpy("stale from retired observer");
    tracker.onDidBecomeStale(stale);
    obsoleteObserver.callback([{ intersectionRect: { width: 800, height: 400 } }]);
    advanceClock(200);
    expect(stale).not.toHaveBeenCalled();
  });
});
