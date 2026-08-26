import { describe, expect, it } from "vitest";
import { ProcessSupervisor } from "./ProcessSupervisor.js";

describe("ProcessSupervisor", () => {
	it("times out an infinite process and remains reusable", async () => {
		const supervisor = new ProcessSupervisor();
		const timed = await supervisor.run(
			process.execPath,
			["-e", "while(true){}"],
			{
				cwd: process.cwd(),
				limits: { timeoutMs: 100, stdoutBytes: 1024, stderrBytes: 1024 },
			},
		);
		expect(timed.timedOut).toBe(true);
		const next = await supervisor.run(
			process.execPath,
			["-e", 'console.log("ok")'],
			{
				cwd: process.cwd(),
				limits: { timeoutMs: 1000, stdoutBytes: 1024, stderrBytes: 1024 },
			},
		);
		expect(next.stdout).toContain("ok");
	});

	it("enforces output caps", async () => {
		const supervisor = new ProcessSupervisor();
		const result = await supervisor.run(
			process.execPath,
			[
				"-e",
				'process.stdout.write("x".repeat(10000)); setInterval(()=>{},1000)',
			],
			{
				cwd: process.cwd(),
				limits: { timeoutMs: 2000, stdoutBytes: 100, stderrBytes: 100 },
			},
		);
		expect(result.limit).toBe("stdout");
	});

	it("kills the entire process group", async () => {
		const supervisor = new ProcessSupervisor();
		const controller = new AbortController();
		let resolvePid!: (pid: number) => void;
		const childPid = new Promise<number>((resolve) => {
			resolvePid = resolve;
		});
		const script = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); console.log(c.pid); setInterval(()=>{},1000);`;
		const running = supervisor.run(process.execPath, ["-e", script], {
			cwd: process.cwd(),
			signal: controller.signal,
			limits: { timeoutMs: 3000, stdoutBytes: 1024, stderrBytes: 1024 },
			callbacks: { stdout: (chunk) => resolvePid(Number(chunk.trim())) },
		});
		const pid = await childPid;
		controller.abort();
		await running;
		expect(() => process.kill(pid, 0)).toThrow(
			expect.objectContaining({ code: "ESRCH" }),
		);
	});

	it("cancels on AbortSignal", async () => {
		const supervisor = new ProcessSupervisor();
		const controller = new AbortController();
		const running = supervisor.run(
			process.execPath,
			["-e", "setInterval(()=>{},1000)"],
			{
				cwd: process.cwd(),
				signal: controller.signal,
				limits: { timeoutMs: 2000, stdoutBytes: 100, stderrBytes: 100 },
			},
		);
		controller.abort();
		expect((await running).cancelled).toBe(true);
	});
});
