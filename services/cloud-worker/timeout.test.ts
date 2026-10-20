import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 真实 Worker HTTP 和子进程；CLI fixture 卡在指定步骤并留下持有 stdout 的孙进程。
test("step timeouts kill the whole process group and keep the serial queue moving", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzp-step-timeout-"));
  const runner = join(root, "cli-fixture"); const headers = { Authorization: "Bearer timeout-test" };
  await writeFile(runner, `#!${process.execPath}
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args=process.argv.slice(2), command=args[1], workspace=process.env.ZZHUB_PIPELINE_WORKSPACE_ROOT;
const state=join(workspace,"fixture-state.json");
const hang=async()=>{
  const grandchild=Bun.spawn(["sleep","300"],{stdout:"inherit",stderr:"inherit"});
  await writeFile(join(workspace,"grandchild.pid"),String(grandchild.pid));
  await Bun.sleep(300_000);
};
if(command==="init") {
  const scenario=args[args.indexOf("--intent-text")+1];
  await writeFile(state,JSON.stringify({scenario}));
  console.log(JSON.stringify({state_path:state,run_id:"run-"+scenario}));
} else {
  const { scenario }=JSON.parse(await readFile(state,"utf8"));
  if(command==="status") {
    console.log(JSON.stringify({summary:{state_path:state,mode:"active",phase:{current:"prepare"},publish:{results:[]}},next_action:{action:scenario==="publish-hang"?"publish":"prepare"}}));
  } else if(command==="prepare"&&scenario==="hang") await hang();
  else if(command==="publish"&&scenario==="publish-hang") await hang();
  else { console.error("fixture step failed"); process.exit(1); }
}
`, { mode: 0o700 });
  const environment = { ...process.env, PIPELINE_WORKER_HOST: "127.0.0.1", PIPELINE_WORKER_PORT: "0", PIPELINE_WORKER_TOKEN: "timeout-test",
    PIPELINE_WORKSPACE_ROOT: root, PIPELINE_WORKER_STATE_FILE: join(root, "jobs.json"), PIPELINE_WORKER_ACCOUNT_STATE_FILE: join(root, "accounts.json"),
    PIPELINE_WORKER_FREE_BYTES: "1", PIPELINE_WORKER_JOB_RESERVE_BYTES: "1", BUN_BIN: runner,
    PIPELINE_WORKER_STEP_TIMEOUT_MS: "500", PIPELINE_WORKER_PUBLISH_STEP_TIMEOUT_MS: "500" };
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], { env: environment, stdout: "pipe", stderr: "inherit" });
  try {
    const reader = child.stdout.getReader(); const { value } = await reader.read(); reader.releaseLock();
    const address = new TextDecoder().decode(value).match(/listening on (127\.0\.0\.1:\d+)/)?.[1];
    if (!address) throw new Error("Worker did not start");
    const url = `http://${address}`;
    expect((await fetch(`${url}/v1/accounts/test`, { method: "PUT", headers, body: JSON.stringify({ appId: "FAKE", appSecret: "FAKE", pat: "FAKE" }) })).status).toBe(200);
    // 三个任务一次性入队：前两个卡住，第三个必须仍能执行到终态。
    const ids: Record<string, string> = {};
    for (const scenario of ["hang", "publish-hang", "after"]) {
      const response = await fetch(`${url}/v1/jobs`, { method: "POST", headers, body: JSON.stringify({
        idempotencyKey: scenario, title: "test", body: "body", account: "test", contentForm: "article", intentText: scenario,
      }) });
      expect(response.status).toBe(202);
      ids[scenario] = (await response.json()).id;
    }
    const jobs: Record<string, any> = {};
    for (const [scenario, id] of Object.entries(ids)) {
      for (let attempt = 0; attempt < 400; attempt++) {
        jobs[scenario] = await (await fetch(`${url}/v1/jobs/${id}`, { headers })).json();
        if (["failed", "interrupted", "succeeded"].includes(jobs[scenario].status)) break;
        await Bun.sleep(25);
      }
    }
    expect(jobs.hang).toMatchObject({ status: "failed", runId: "run-hang" });
    expect(jobs.hang.error).toContain("prepare timed out after 500ms");
    expect(jobs["publish-hang"]).toMatchObject({ status: "interrupted", runId: "run-publish-hang" });
    expect(jobs["publish-hang"].error).toContain("publish timed out after 500ms");
    expect(jobs.after.status).toBe("failed");
    expect(jobs.after.error).toContain("fixture step failed");
    for (const scenario of ["hang", "publish-hang"]) {
      const pid = Number(await readFile(join(root, "jobs", ids[scenario]!, "grandchild.pid"), "utf8"));
      expect(alive(pid)).toBe(false);
    }
  } finally { child.kill(); await child.exited; await rm(root, { recursive: true, force: true }); }
}, 30_000);
