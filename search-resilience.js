"use strict";

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 30_000;

function createSearchProviderRunner(options = {}) {
  const threshold = Number.isInteger(options.failureThreshold) && options.failureThreshold > 0
    ? options.failureThreshold : FAILURE_THRESHOLD;
  const cooldownMs = Number.isFinite(options.cooldownMs) && options.cooldownMs >= 0
    ? options.cooldownMs : COOLDOWN_MS;
  const states = new Map();

  function stateFor(name) {
    if (!states.has(name)) states.set(name, {
      calls: 0, successes: 0, failures: 0, consecutiveFailures: 0,
      totalLatencyMs: 0, lastLatencyMs: null, lastSuccessAt: null,
      lastFailureAt: null, lastError: null, circuitOpenUntil: 0, probeInFlight: false
    });
    return states.get(name);
  }

  async function run(name, task) {
    const state = stateFor(String(name || "unknown"));
    const now = Date.now();
    if (state.circuitOpenUntil > now) {
      const seconds = Math.ceil((state.circuitOpenUntil - now) / 1000);
      throw new Error("Circuit open for " + name + " (" + seconds + "s cooldown remaining).");
    }
    if (state.circuitOpenUntil && state.circuitOpenUntil <= now) {
      if (state.probeInFlight) throw new Error("Circuit half-open for " + name + "; recovery probe is already running.");
      state.probeInFlight = true;
    }

    state.calls += 1;
    const startedAt = Date.now();
    try {
      const results = await task();
      if (!Array.isArray(results)) throw new Error("Malformed provider response: expected an array of results.");
      if (results.length && results.some(item =>
        !item || typeof item !== "object" ||
        typeof item.title !== "string" || !item.title.trim() ||
        typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)
      )) {
        throw new Error("Malformed provider response: each result needs a title and an HTTP(S) URL.");
      }
      if (!results.length) throw new Error("Provider returned no usable results.");
      state.successes += 1;
      state.consecutiveFailures = 0;
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
      state.circuitOpenUntil = 0;
      return results;
    } catch (error) {
      state.failures += 1;
      state.consecutiveFailures += 1;
      state.lastFailureAt = new Date().toISOString();
      state.lastError = String(error?.message || error || "Unknown provider error").slice(0, 300);
      if (state.consecutiveFailures >= threshold) {
        state.circuitOpenUntil = Date.now() + cooldownMs;
      }
      throw error;
    } finally {
      const latency = Math.max(0, Date.now() - startedAt);
      state.lastLatencyMs = latency;
      state.totalLatencyMs += latency;
      state.probeInFlight = false;
    }
  }

  function snapshot() {
    const output = {};
    for (const [name, state] of states) {
      const completed = state.successes + state.failures;
      output[name] = {
        calls: state.calls,
        successes: state.successes,
        failures: state.failures,
        successRate: completed ? Number((state.successes / completed * 100).toFixed(1)) : null,
        averageLatencyMs: completed ? Math.round(state.totalLatencyMs / completed) : null,
        lastLatencyMs: state.lastLatencyMs,
        lastSuccessAt: state.lastSuccessAt,
        lastFailureAt: state.lastFailureAt,
        lastError: state.lastError,
        circuit: state.circuitOpenUntil > Date.now() ? "open" :
          state.circuitOpenUntil ? "half-open" : "closed",
        circuitOpenUntil: state.circuitOpenUntil ? new Date(state.circuitOpenUntil).toISOString() : null
      };
    }
    return output;
  }

  return { run, snapshot };
}

const searchProviderRunner = createSearchProviderRunner();

module.exports = { createSearchProviderRunner, searchProviderRunner };
