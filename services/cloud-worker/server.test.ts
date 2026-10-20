import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createArticleStyleSnapshot } from "../../src/article-style";
import { createCoverSnapshot } from "../../cover-snapshot";
import { ARTICLE_COVER_FONT, DEFAULT_ARTICLE_COVER_CONTROLS } from "@akairos/typeset-studio/cover";
import { createCanvas } from "@napi-rs/canvas";

test("worker defaults to loopback and authenticates health and job requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzp-worker-test-"));
  const command = [process.execPath, join(import.meta.dir, "server.ts")];
  // 独立子进程和临时目录避免读取生产任务或账号配置。
  const env = {
    ...process.env,
    PIPELINE_WORKER_HOST: "",
    PIPELINE_WORKER_PRIVATE_NETWORK: "",
    PIPELINE_WORKER_PORT: "0",
    PIPELINE_WORKER_TOKEN: "test-worker-token",
    PIPELINE_WORKSPACE_ROOT: root,
    PIPELINE_WORKER_STATE_FILE: join(root, "jobs.json"),
    PIPELINE_ARTICLE_EXPORT_ENGINE: "dom",
  };
  await writeFile(`${env.PIPELINE_WORKER_STATE_FILE}.maintenance.json`, "true");
  const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "inherit" });
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const address = new TextDecoder().decode(value).match(/listening on (127\.0\.0\.1:\d+)/)?.[1];
    expect(address).toBeTruthy();
    const url = `http://${address}`;
    const headers = { Authorization: `Bearer ${env.PIPELINE_WORKER_TOKEN}` };
    expect((await fetch(`${url}/health`)).status).toBe(401);
    expect((await fetch(`${url}/health`, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${url}/health`, { headers })).status).toBe(200);
    expect((await (await fetch(`${url}/health`, { headers })).json()).capabilities.articleStyleSchemaVersions).toEqual([1, 2]);
    expect(await (await fetch(`${url}/health`, { headers })).json()).toMatchObject({ accepting: 0, preparing: 0, assetWrites: 0, capabilities: { jobLookupByIdempotencyKey: true, articleExportEngine: "dom" } });
    expect((await fetch(`${url}/v1/jobs/by-idempotency-key?idempotencyKey=absent&account=test`, { headers })).status).toBe(404);
    expect((await fetch(`${url}/v1/jobs/by-idempotency-key?idempotencyKey=a&idempotencyKey=b&account=test`, { headers })).status).toBe(400);
    expect((await fetch(`${url}/v1/jobs/missing`)).status).toBe(401);
    expect((await fetch(`${url}/v1/jobs/missing`, { headers })).status).toBe(404);

    expect((await fetch(`${url}/v1/accounts/test-account`, { method: "PUT", headers, body: JSON.stringify({
      account: "test-account",
      appId: "app-id",
      appSecret: "app-secret",
      pat: "pat",
    }) })).status).toBe(200);
    expect((await fetch(`${url}/v1/accounts/test-account`, { method: "DELETE", headers })).status).toBe(200);

    // 未配置的测试账号会在执行前停止，只验证快照契约与幂等保存。
    const input = { idempotencyKey: "newspic-input", title: "贴图", body: "原文", contentForm: "newspic", account: "missing-account", newspic: { content: "发送正文", photos: ["https://example.test/a.png", "https://example.test/b.png"] } };
    const submit = (value: unknown) => fetch(`${url}/v1/jobs`, { method: "POST", headers, body: JSON.stringify(value) });
    expect((await (await fetch(`${url}/health`, { headers })).json()).maintenance).toBe(true);
    expect((await submit(input)).status).toBe(503);
    expect((await fetch(`${url}/v1/maintenance`, { method: "PUT", headers, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    expect((await submit({ ...input, newspic: { ...input.newspic, content: "😀".repeat(512) + "a" } })).status).toBe(400);
    for (const photos of [null, ["file:///private/photo.png"], Array(21).fill("https://example.test/a.png")])
      expect((await submit({ ...input, newspic: { ...input.newspic, photos } })).status).toBe(400);
    const created = await submit(input);
    expect(created.status).toBe(202);
    const job = await created.json();
    expect(job.input.newspic).toEqual(input.newspic);
    expect(job.bodyHash).toBe(createHash("sha256").update(input.body).digest("hex"));
    const lookup = `${url}/v1/jobs/by-idempotency-key?idempotencyKey=${input.idempotencyKey}&account=${input.account}`;
    expect((await (await fetch(lookup, { headers })).json()).id).toBe(job.id);
    expect((await fetch(lookup, { headers })).headers.get("cache-control")).toBe("no-store");
    expect((await fetch(lookup.replace(input.account, "wrong-account"), { headers })).status).toBe(409);
    expect((await (await submit(input)).json()).id).toBe(job.id);
    expect((await fetch(`${url}/v1/maintenance`, { method: "PUT", body: JSON.stringify({ enabled: true }) })).status).toBe(401);
    expect((await fetch(`${url}/v1/maintenance`, { method: "PUT", headers, body: JSON.stringify({ enabled: true }) })).status).toBe(200);
    expect((await submit({ ...input, idempotencyKey: "paused-job" })).status).toBe(503);
    expect((await submit(input)).status).toBe(200);
    expect((await fetch(`${url}/v1/maintenance`, { method: "PUT", headers, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    expect((await submit({ ...input, newspic: { ...input.newspic, content: "另一份正文" } })).status).toBe(409);
    const generated = await submit({ ...input, idempotencyKey: "newspic-generated", newspic: { ...input.newspic, photos: [] } });
    expect(generated.status).toBe(202);
    expect((await generated.json()).input.newspic.photos).toEqual([]);

    const articleStyle = createArticleStyleSnapshot({ schemaVersion: 1, engineVersion: 1, id: "body-style", name: "正文", version: "1.0.0", exportTheme: { bodyFontSize: "20px" } }, "body-style", 1);
    const article = { idempotencyKey: "article-style", title: "正文样式", body: "正文", contentForm: "article", account: "missing-account", articleStyle };
    const styled = await (await submit(article)).json();
    expect(styled.input.articleStyle).toEqual(articleStyle);
    expect((await (await submit(article)).json()).id).toBe(styled.id);
    expect((await submit({ ...article, articleStyle: { ...articleStyle, schemaVersion: 2 } })).status).toBe(400);
    expect((await submit({ ...input, articleStyle })).status).toBe(400);
    const different = createArticleStyleSnapshot({ ...articleStyle.manifest, exportTheme: { bodyFontSize: "21px" } }, "body-style", 2);
    expect((await submit({ ...article, articleStyle: different })).status).toBe(409);
    const legacyInput = { idempotencyKey: "legacy-article", title: "旧正文", body: "正文", contentForm: "article", account: "missing-account" };
    const legacyJob = await (await submit(legacyInput)).json();
    expect(legacyJob.input).not.toHaveProperty("articleStyle");
    expect(legacyJob.input).not.toHaveProperty("coverSnapshot");
    expect(legacyJob.requestHash).toBe(createHash("sha256").update(JSON.stringify({ ...legacyInput, existingDraftMediaId: null })).digest("hex"));
    const saved = JSON.parse(await readFile(env.PIPELINE_WORKER_STATE_FILE, "utf8"));
    expect(saved.jobs.find((item: any) => item.id === styled.id).input.articleStyle.hash).toBe(articleStyle.hash);

    const image = createCanvas(1000, 1000).toBuffer("image/jpeg");
    const coverSnapshot = createCoverSnapshot({
      id: "a7d3e690-7b83-4e40-a988-50f833ad7746", revision: 1, name: "私有封面",
      controls: DEFAULT_ARTICLE_COVER_CONTROLS,
      asset: { id: "1c39284b-d336-4539-94e3-c01d7a535aa6", sha256: createHash("sha256").update(image).digest("hex"), contentType: "image/jpeg", dataBase64: image.toString("base64") },
      font: { id: ARTICLE_COVER_FONT.id, sha256: ARTICLE_COVER_FONT.sha256 },
    });
    const coveredInput = { ...article, idempotencyKey: "covered-article", coverSnapshot };
    const covered = await (await submit(coveredInput)).json();
    expect(covered.input.coverSnapshot).toEqual(coverSnapshot);
    expect((await (await submit(coveredInput)).json()).id).toBe(covered.id);
    expect((await submit({ ...coveredInput, coverSnapshot: { ...coverSnapshot, hash: "0".repeat(64) } })).status).toBe(400);
    expect((await submit({ ...input, coverSnapshot })).status).toBe(400);
    const coverFields = { ...coverSnapshot, revision: 2 } as Record<string, unknown>;
    delete coverFields.hash; delete coverFields.config; delete coverFields.schemaVersion;
    expect((await submit({ ...coveredInput, coverSnapshot: createCoverSnapshot(coverFields) })).status).toBe(409);
    const storedCover = JSON.parse(await readFile(env.PIPELINE_WORKER_STATE_FILE, "utf8")).jobs.find((item: any) => item.id === covered.id);
    expect(storedCover.input.coverSnapshot.asset.dataBase64).toBe(image.toString("base64"));

    const rejected = Bun.spawnSync(command, { env: { ...env, PIPELINE_WORKER_HOST: "0.0.0.0" } });
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain("PIPELINE_WORKER_HOST must be loopback");
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
