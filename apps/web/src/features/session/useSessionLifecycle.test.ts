// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CreateSessionResponse, Language } from "@atomis/protocol";
import { useSessionLifecycle } from "./useSessionLifecycle.js";
import type { Settings } from "../../shared/stores/settings.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function mount(persistent = false) {
  const old = { sessionId: "old", language: "py", documentUri: "file:///old/main.py", initialSource: "original",
    ...(persistent ? {workspace: {id: "original-workspace", name: "My work"}} : {}),
  } as CreateSessionResponse;
  const filesRef = {current: [
    {path: "main.py", uri: "file:///old/main.py", source: "local edits"},
    {path: "lib/helper.py", uri: "file:///old/lib/helper.py", source: "helper edits"},
    {path: "input.txt", uri: "file:///old/input.txt", source: "my data"},
  ]};
  const sessionRef = {current: old as CreateSessionResponse | undefined};
  const options = {sessionRef, filesRef, setSession: vi.fn(), entryRef: {current:"main.py"},
    activeLanguageRef:{current:"py" as Language}, versionRef:{current:9}, settingsRef:{current:{} as Settings},
    lspClientsRef:{current:{}}, setProjectFiles: vi.fn(), setSettings: vi.fn(),setStartupError:vi.fn(),
    onSwitchFailed:vi.fn(),setSwitching:vi.fn(),setCapabilities:vi.fn(),setStatus:vi.fn(),setPeek:vi.fn(),
    resetToEntry:vi.fn(),closeRuntime:vi.fn(),resetRuntime:vi.fn(),closePicker:vi.fn(),
  };
  const rendered=renderHook(()=>useSessionLifecycle(options));
  return {rendered, options, old};
}

test("scratch recovery restores every file and resets the runtime version", async()=>{
  const {rendered, options}=mount();
  const created={sessionId:"new",language:"py",files:options.filesRef.current,initialSource:"local edits",documentUri:"file:///new/main.py"};
  const fetch=vi.fn().mockResolvedValue({ok:true,json:()=>Promise.resolve(created)});vi.stubGlobal("fetch",fetch);
  await act(()=>rendered.result.current.recoverSession(true));
  const body=JSON.parse(fetch.mock.calls[0]?.[1].body ?? "{}");
  expect(body.files.map((file: {path:string})=>file.path)).toEqual(["main.py","lib/helper.py","input.txt"]);
  expect(body.files[0].source).toBe("local edits");
  expect(options.setProjectFiles).toHaveBeenCalledWith(created.files);
  expect(options.versionRef.current).toBe(1);
});

test("dirty persistent recovery creates a separate workspace before reopening",async()=>{
  const {rendered, options}=mount(true);
  const created={sessionId:"new",language:"py",files:options.filesRef.current,workspace:{id:"recovery-copy"}};
  const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:()=>Promise.resolve({workspace:{id:"recovery-copy"}})})
    .mockResolvedValueOnce({ok:true,json:()=>Promise.resolve(created)});vi.stubGlobal("fetch",fetch);
  await act(()=>rendered.result.current.recoverSession(true));
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/workspaces");
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body).name).toBe("My work (recovered)");
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual({language:"py",workspace:"recovery-copy"});
});

test("a clean persistent session reopens the existing workspace",async()=>{
  const {rendered, options}=mount(true);
  const fetch=vi.fn().mockResolvedValue({ok:true,json:()=>Promise.resolve({sessionId:"new",language:"py",files:options.filesRef.current})});
  vi.stubGlobal("fetch",fetch);
  await act(()=>rendered.result.current.recoverSession(false));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({language:"py",workspace:"original-workspace"});
});

test("a failed recovery preserves the local files and old session for retry",async()=>{
  const {rendered, options, old}=mount();
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:false,status:503}));
  await act(async()=>{await expect(rendered.result.current.recoverSession(true)).rejects.toThrow("503")});
  expect(options.sessionRef.current).toBe(old);
  expect(options.setProjectFiles).not.toHaveBeenCalled();
  expect(options.closeRuntime).not.toHaveBeenCalled();
  expect(options.setSwitching).toHaveBeenLastCalledWith(false);
});
