// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRuntimeEvents } from "./useRuntimeEvents.js";

afterEach(cleanup);

test("a queued older peer edit cannot roll back a newer catalog revision", () => {
  const setProjectFiles=vi.fn();
  const options={versionRef:{current:7},filesRef:{current:[]},setProjectFiles,
    monacoRef:{current:undefined},entryRef:{current:"main.py"},pinnedLogLocationRef:{current:undefined},
    logSourceDecorationsRef:{current:undefined},setStatus:vi.fn()};
  const {result}=renderHook(()=>useRuntimeEvents(options));
  const files=[{path:"main.py",uri:"file:///main.py",source:"newest"}];
  act(()=>result.current.handleRuntimeEvent({type:"project.changed",revision:5,files}));
  act(()=>result.current.handleRuntimeEvent({type:"document.changed",revision:4,path:"main.py",source:"older"}));
  act(()=>result.current.handleRuntimeEvent({type:"project.changed",revision:3,files:[]}));
  expect(result.current.revisionRef.current).toBe(5);
  expect(result.current.remoteEdit).toBeUndefined();
  expect(setProjectFiles).toHaveBeenCalledTimes(1);
  expect(setProjectFiles).toHaveBeenCalledWith(files);
});
