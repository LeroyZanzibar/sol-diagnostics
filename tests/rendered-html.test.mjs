import assert from "node:assert/strict";
import test from "node:test";

test("renders the diagnostics experience metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const fetchPage=typeof worker==='function'?worker:worker.fetch.bind(worker);
  const response = await fetchPage(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, /<title>Sol Diagnostics<\/title>/i);
  assert.match(html, /Solar site diagnostics that identify performance issues and quantify estimated energy losses\./i);
  assert.doesNotMatch(html, /codex-preview/i);
});
