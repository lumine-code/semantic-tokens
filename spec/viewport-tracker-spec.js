describe("semantic token viewport tracking", () => {
  let editor, tracker, requests, intersectionObservers, resizeObservers;

  const intersect = (observer, width, height) =>
    observer.callback([{ intersectionRect: { width, height } }]);

  function observerFor(callback, observers) {
    const observer = {
      callback,
      observe: jasmine.createSpy("observe"),
      disconnect: jasmine.createSpy("disconnect"),
    };
    observers.push(observer);
    return observer;
  }

  beforeEach(async () => {
    const workspaceElement = lumine.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    editor = await lumine.workspace.open();
    editor.setText("x\n".repeat(2000));
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    spyOn(editor, "getFirstVisibleScreenRow").and.returnValue(0);
    spyOn(editor, "getLastVisibleScreenRow").and.returnValue(20);

    // Deliver layout observers explicitly so the fake clock does not depend
    // on Chromium deciding when an offscreen test window should render.
    intersectionObservers = [];
    resizeObservers = [];
    spyOn(window, "IntersectionObserver").and.callFake(function (callback) {
      return observerFor(callback, intersectionObservers);
    });
    spyOn(window, "ResizeObserver").and.callFake(function (callback) {
      return observerFor(callback, resizeObservers);
    });
    const ViewportTracker = require("../lib/viewport-tracker");
    tracker = new ViewportTracker();
    requests = [];
    tracker.onDidBecomeStale(({ editor: target, range }) => {
      requests.push(range);
      // The manager calls this when it dispatches the provider request.
      tracker.rangeForEditor(target);
    });
    tracker.rangeForEditor(editor);
  });

  afterEach(() => {
    tracker.dispose();
    for (const open of lumine.workspace.getTextEditors()) open.destroy();
  });

  it("requests rows newly revealed by folding without a scroll or source edit", () => {
    editor.foldBufferRowRange(0, 1000);
    advanceClock(150);
    expect(requests.length).toBe(1);
    expect(requests[0][1]).toBeGreaterThan(1000);
  });

  it("requests rows newly revealed by a taller viewport", () => {
    editor.getLastVisibleScreenRow.and.returnValue(200);
    resizeObservers[0].callback();
    advanceClock(150);
    expect(requests).toEqual([[0, 250]]);
  });

  it("coalesces successive layout changes and skips a range already requested", () => {
    editor.getLastVisibleScreenRow.and.returnValue(200);
    resizeObservers[0].callback();
    advanceClock(100);
    editor.getLastVisibleScreenRow.and.returnValue(250);
    resizeObservers[0].callback();
    advanceClock(150);
    expect(requests).toEqual([[0, 300]]);

    resizeObservers[0].callback();
    tracker.scheduleEmit(tracker.states.get(editor));
    advanceClock(150);
    expect(requests).toEqual([[0, 300]]);
  });

  it("requests the first measured viewport after an unrendered editor is revealed", () => {
    editor.getFirstVisibleScreenRow.and.returnValue(NaN);
    editor.getLastVisibleScreenRow.and.returnValue(NaN);
    expect(tracker.rangeForEditor(editor)).toEqual([0, 50]);
    editor.getFirstVisibleScreenRow.and.returnValue(300);
    editor.getLastVisibleScreenRow.and.returnValue(320);
    intersect(intersectionObservers[0], 800, 400);
    expect(requests).toEqual([[250, 370]]);
  });

  it("lets the manager's source fetch handle edits and skips the resulting viewport events", () => {
    editor.setText("x\n".repeat(2100));
    editor.getLastVisibleScreenRow.and.returnValue(200);
    resizeObservers[0].callback();
    advanceClock(150);
    expect(requests).toEqual([]);

    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    tracker.rangeForEditor(editor);
    resizeObservers[0].callback();
    tracker.scheduleEmit(tracker.states.get(editor));
    advanceClock(150);
    expect(requests).toEqual([]);
  });

  it("disconnects observers and ignores queued callbacks after disposal", () => {
    editor.getLastVisibleScreenRow.and.returnValue(200);
    resizeObservers[0].callback();
    tracker.dispose();
    expect(resizeObservers[0].disconnect).toHaveBeenCalled();
    expect(intersectionObservers[0].disconnect).toHaveBeenCalled();
    resizeObservers[0].callback();
    intersect(intersectionObservers[0], 800, 400);
    advanceClock(150);
    expect(requests).toEqual([]);
  });
});
