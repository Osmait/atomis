import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { CreateSessionResponse, RuntimeServerEvent } from "../../packages/protocol/src/index.js";

interface ClientWindow { reliabilitySocket?: WebSocket; reliabilityEvents: RuntimeServerEvent[] }
interface RecoveryWindow { recoverySockets: WebSocket[] }

async function session(request: APIRequestContext, origin: string, workspaceId?: string, files?: {path:string;source:string}[]) {
  const response=await request.post("/api/sessions", {headers:{origin},data:{language:"py",scaffold:"minimal",...(workspaceId?{workspace:workspaceId}:{}),...(files?{files}:{})}});
  expect(response.ok()).toBe(true);
  return await response.json() as CreateSessionResponse;
}

async function workspace(request: APIRequestContext, origin: string) {
  const response=await request.post("/api/workspaces",{headers:{origin},data:{name:`reliability-${Date.now()}`,language:"py",scaffold:"minimal"}});
  expect(response.ok()).toBe(true);
  return ((await response.json()) as {workspace:{id:string}}).workspace.id;
}

async function connect(page: Page, created: CreateSessionResponse) {
  await page.goto("/api/health");
  await page.evaluate(async attached=>{
    const state=window as object as ClientWindow;
    state.reliabilityEvents=[];
    const url=new URL("/ws/runtime",location.href);url.protocol="ws:";
    url.searchParams.set("sessionId",attached.sessionId);url.searchParams.set("token",attached.authToken);
    const socket=new WebSocket(url);state.reliabilitySocket=socket;
    socket.addEventListener("message",event=>state.reliabilityEvents.push(JSON.parse(String(event.data)) as RuntimeServerEvent));
    await new Promise<void>((resolve,reject)=>{socket.addEventListener("open",()=>resolve(),{once:true});socket.addEventListener("error",()=>reject(new Error("WebSocket failed")),{once:true})});
    socket.send(JSON.stringify({type:"settings.update",sessionId:attached.sessionId,autoRun:false,autoInspect:false,debounceMs:400,timeoutMs:2000,manualProbeIds:[],sandbox:true,network:false}));
    socket.send(JSON.stringify({type:"run.cancel",sessionId:attached.sessionId}));
  },created);
  await expect.poll(async()=> (await events(page)).some(event=>event.type==="run.state"&&event.state==="cancelled")).toBe(true);
}

function events(page: Page) {return page.evaluate(()=>(window as object as ClientWindow).reliabilityEvents)}
async function send(page: Page, created: CreateSessionResponse, messages: object[]) {
  await page.evaluate(({id,messages: outgoing})=>{
    const socket=(window as object as ClientWindow).reliabilitySocket;
    for(const message of outgoing)socket?.send(JSON.stringify({sessionId:id,...message}));
  },{id:created.sessionId,messages});
}
async function saved(page:Page,version:number) {
  await expect.poll(async()=>(await events(page)).some(event=>event.type==="document.saved"&&event.documentVersion===version)).toBe(true);
}
async function revision(page:Page) {
  return (await events(page)).reduce((last,event)=>"revision" in event?Math.max(last,event.revision):last,0);
}

test("rapid same-device edits persist the newest source and keep Run usable",async({page,request,baseURL})=>{
  const id=await workspace(request,baseURL!);
  const created=await session(request,baseURL!,id);await connect(page,created);
  const baseRevision=await revision(page);
  await send(page,created,[
    {type:"document.update",version:2,path:"main.py",source:'print("first")\n',baseRevision},
    {type:"document.update",version:3,path:"main.py",source:'print("latest")\n',baseRevision},
    {type:"run.request",version:3,reason:"manual",language:"py"},
  ]);
  await saved(page,3);
  expect((await session(request,baseURL!,id)).initialSource).toBe('print("latest")\n');
  await expect.poll(async()=>(await events(page)).some(event=>event.type==="output"&&event.chunk.includes("latest"))).toBe(true);
  expect((await events(page)).some(event=>event.type==="document.conflict")).toBe(false);
});

test("shared file create, rename and delete synchronize; stale edits cannot resurrect files",async({page,context,request,baseURL})=>{
  const id=await workspace(request,baseURL!);
  const a=await session(request,baseURL!,id),b=await session(request,baseURL!,id);
  const peer=await context.newPage();await connect(page,a);await connect(peer,b);
  await send(page,a,[{type:"file.create",version:2,path:"helper.py",source:"value = 1",baseRevision:await revision(page)}]);
  await saved(page,2);
  await expect.poll(async()=>(await events(peer)).some(event=>event.type==="project.changed"&&event.files.some(file=>file.path==="helper.py"))).toBe(true);
  await send(page,a,[{type:"file.rename",version:3,path:"helper.py",newPath:"renamed.py",baseRevision:await revision(page)}]);
  await saved(page,3);
  await expect.poll(async()=>(await events(peer)).some(event=>event.type==="project.changed"&&event.files.some(file=>file.path==="renamed.py"))).toBe(true);
  const staleBase=await revision(peer);
  await send(page,a,[{type:"file.delete",version:4,path:"renamed.py",baseRevision:await revision(page)}]);
  await saved(page,4);
  await expect.poll(async()=>(await events(peer)).findLast(event=>event.type==="project.changed")?.files.map(file=>file.path)).toEqual(["main.py"]);
  await send(peer,b,[{type:"document.update",version:2,path:"renamed.py",source:"resurrected",baseRevision:staleBase}]);
  await expect.poll(async()=>(await events(peer)).some(event=>event.type==="document.conflict")).toBe(true);
  // Even legacy clients without revisions must not recreate a deleted path.
  await send(peer,b,[{type:"document.update",version:3,path:"renamed.py",source:"resurrected"}]);
  await expect.poll(async()=>(await events(peer)).some(event=>event.type==="server.error"&&event.message.includes("File does not exist"))).toBe(true);
  expect((await session(request,baseURL!,id)).files.map(file=>file.path)).toEqual(["main.py"]);
  await peer.close();
});

test("persistent reset replaces sources and synchronizes the new catalog",async({page,context,request,baseURL})=>{
  const id=await workspace(request,baseURL!);
  const a=await session(request,baseURL!,id),b=await session(request,baseURL!,id);
  const peer=await context.newPage();await connect(page,a);await connect(peer,b);
  await send(page,a,[{type:"document.update",version:2,path:"main.py",source:'print("custom")',baseRevision:await revision(page)}]);await saved(page,2);
  await send(page,a,[{type:"file.create",version:3,path:"notes.txt",source:"notes",baseRevision:await revision(page)}]);await saved(page,3);
  await send(page,a,[{type:"workspace.reset",version:4,scaffold:"minimal",baseRevision:await revision(page)}]);await saved(page,4);
  const reopened=await session(request,baseURL!,id);
  expect(reopened.files.map(file=>file.path)).toEqual(["main.py"]);
  expect(reopened.initialSource).not.toContain("custom");
  await expect.poll(async()=>(await events(peer)).findLast(event=>event.type==="project.changed")?.files.map(file=>file.path)).toEqual(["main.py"]);
  await send(page,a,[{type:"workspace.reset",version:5,scaffold:"demo",baseRevision:await revision(page)}]);await saved(page,5);
  expect((await session(request,baseURL!,id)).files.length).toBeGreaterThan(1);
  await peer.close();
});

test("full project recovery validates paths and never overwrites an existing workspace",async({request,baseURL})=>{
  const files=[{path:"main.py",source:'print("restored")\n'},{path:"nested/helper.py",source:"value = 42"},{path:"input.txt",source:"á 🧪"}];
  const restored=await session(request,baseURL!,undefined,files);
  expect(restored.files.map(({path,source})=>({path,source})).toSorted((a,b)=>a.path.localeCompare(b.path))).toEqual(files.toSorted((a,b)=>a.path.localeCompare(b.path)));
  const id=await workspace(request,baseURL!);
  for(const data of [
    {language:"py",files:[{path:"../escape.py",source:"bad"}]},
    {language:"py",files:[...files,files[0]]},
    {language:"py",workspace:id,files},
  ]) {
    const response=await request.post("/api/sessions",{headers:{origin:baseURL!},data});expect(response.status()).toBe(400);
  }
  expect((await session(request,baseURL!,id)).initialSource).not.toContain("restored");
});

test("the app resets a persistent workspace in place and closes removed tabs",async({page,request,baseURL})=>{
  const id=await workspace(request,baseURL!);
  await page.addInitScript(workspaceId=>localStorage.setItem("atomis.workspace.v1",workspaceId),id);
  await page.goto("/");
  await expect(page.locator(".tree-file")).toHaveCount(1);
  page.on("dialog",dialog=>void dialog.accept());
  await page.locator(".tree-menu-btn").click();
  await page.getByRole("menuitem",{name:"Load demo workspace"}).click();
  await expect.poll(()=>page.locator(".tree-file").count()).toBeGreaterThan(1);
  await page.getByRole("button",{name:"main.zig",exact:true}).click();
  await expect(page.locator(".global-status")).toContainText("main.zig");
  await page.locator(".tree-menu-btn").click();
  await page.getByRole("menuitem",{name:"Clear workspace"}).click();
  await expect(page.locator(".tree-file")).toHaveCount(1);
  await expect(page.locator(".global-status")).toContainText("main.py");
  expect((await session(request,baseURL!,id)).files.map(file=>file.path)).toEqual(["main.py"]);
  await page.reload();
  await expect(page.locator(".tree-file")).toHaveCount(1);
  await expect(page.locator(".global-status")).toContainText("main.py");
});

test("the app automatically restores a lost scratch session including offline edits and assets",async({page})=>{
  const initialFiles=[{path:"main.py",source:'print("restored")\n'},{path:"helper.txt",source:"original asset"}];
  let first=true;
  await page.route("**/api/sessions",async route=>{
    if (first) { first=false; await route.continue({postData:JSON.stringify({language:"py",files:initialFiles})}); }
    else await route.continue();
  });
  let allowRecovery: (() => void) | undefined;
  const recoveryGate = new Promise<void>(resolve => { allowRecovery = resolve; });
  // The separate real-time test below verifies the backend's 120s expiry.
  // Here we force its confirmed-expired response to exercise the app flow.
  await page.route("**/api/sessions/*?token=*",async route=>{
    await recoveryGate;
    await route.fulfill({status:404,body:""});
  });
  await page.addInitScript(()=>{
    const state=window as object as RecoveryWindow;
    state.recoverySockets=[];
    const NativeWebSocket=window.WebSocket;
    window.WebSocket=class extends NativeWebSocket {
      constructor(url:string|URL,protocols?:string|string[]) {
        super(url,protocols);
        if(String(url).includes("/ws/runtime"))state.recoverySockets.push(this);
      }
    };
  });
  const initialResponse=page.waitForResponse(response=>response.url().endsWith("/api/sessions")&&response.request().method()==="POST");
  await page.goto("/");
  const original=await (await initialResponse).json() as CreateSessionResponse;
  await expect(page.locator(".tree-file")).toHaveCount(2);
  await page.getByRole("button",{name:"helper.txt",exact:true}).click();
  await expect(page.locator(".global-status")).toContainText("helper.txt");
  await page.context().grantPermissions(["clipboard-read","clipboard-write"], {origin:new URL(page.url()).origin});
  await page.evaluate(async()=>{await navigator.clipboard.writeText("offline asset changes")});
  await page.evaluate(()=> (window as object as RecoveryWindow).recoverySockets.at(-1)?.close());
  await page.getByRole("textbox",{name:"Editor content"}).focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.locator(".view-lines")).toContainText("offline asset changes");
  const recoveredResponse=page.waitForResponse(response=>response.url().endsWith("/api/sessions")&&response.request().method()==="POST");
  allowRecovery?.();
  const restored=await (await recoveredResponse).json() as CreateSessionResponse;
  expect(restored.sessionId).not.toBe(original.sessionId);
  expect(restored.files.find(file=>file.path==="helper.txt")?.source).toBe("offline asset changes");
  expect(restored.files.find(file=>file.path==="main.py")?.source).toBe(initialFiles[0]?.source);
  await expect(page.locator(".app-shell")).not.toHaveClass(/switching/);
  await expect(page.locator(".tree-file")).toHaveCount(2);
});

test("a session really expires after disconnect and its complete mirror can be recovered",async({page,request,baseURL})=>{
  test.slow();
  const files=[{path:"main.py",source:'print("after sleep")\n'},{path:"helper.txt",source:"keep this too"}];
  const old=await session(request,baseURL!,undefined,files);await connect(page,old);
  await page.evaluate(()=>(window as object as ClientWindow).reliabilitySocket?.close());
  await expect.poll(async()=>(await request.get(`/api/sessions/${old.sessionId}?token=${encodeURIComponent(old.authToken)}`)).status(),{timeout:135000,intervals:[1000,5000]}).toBe(404);
  const restored=await session(request,baseURL!,undefined,files);
  expect(restored.sessionId).not.toBe(old.sessionId);
  expect(restored.files.find(file=>file.path==="helper.txt")?.source).toBe("keep this too");
  await connect(page,restored);
  await send(page,restored,[{type:"run.request",version:1,reason:"manual",language:"py"}]);
  await expect.poll(async()=>(await events(page)).some(event=>event.type==="output"&&event.chunk.includes("after sleep"))).toBe(true);
});
