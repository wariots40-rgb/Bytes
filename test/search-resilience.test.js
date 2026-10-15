"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSearchProviderRunner } = require("../search-resilience");

const goodResult = [{ title: "Example result", url: "https://example.com/story", snippet: "A result." }];

test("tracks provider calls, success rate, and latency", async () => {
  const runner = createSearchProviderRunner();
  await runner.run("MockSearch", async () => goodResult);
  const stats = runner.snapshot().MockSearch;
  assert.equal(stats.calls, 1);
  assert.equal(stats.successes, 1);
  assert.equal(stats.failures, 0);
  assert.equal(stats.successRate, 100);
  assert.equal(typeof stats.averageLatencyMs, "number");
  assert.equal(stats.circuit, "closed");
});

test("rejects malformed provider payloads and counts them as failures", async () => {
  const runner = createSearchProviderRunner();
  await assert.rejects(runner.run("Malformed", async () => ({ results: goodResult })), /expected an array/);
  await assert.rejects(runner.run("BadUrl", async () => [{ title: "No URL", url: "javascript:alert(1)" }]), /HTTP\(S\) URL/);
  await assert.rejects(runner.run("Empty", async () => []), /no usable results/);
  assert.equal(runner.snapshot().Malformed.failures, 1);
  assert.equal(runner.snapshot().BadUrl.failures, 1);
  assert.equal(runner.snapshot().Empty.failures, 1);
});

test("opens circuit after repeated failures and allows recovery after cooldown", async () => {
  const runner = createSearchProviderRunner({ failureThreshold: 2, cooldownMs: 20 });
  const broken = async () => { throw new Error("provider offline"); };
  await assert.rejects(runner.run("Flaky", broken), /provider offline/);
  await assert.rejects(runner.run("Flaky", broken), /provider offline/);
  assert.equal(runner.snapshot().Flaky.circuit, "open");
  await assert.rejects(runner.run("Flaky", async () => goodResult), /Circuit open/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(await runner.run("Flaky", async () => goodResult), goodResult);
  assert.equal(runner.snapshot().Flaky.circuit, "closed");
  assert.equal(runner.snapshot().Flaky.successRate, 33.3);
});
