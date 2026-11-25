import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createDevSupervisor } from "./dev-supervisor.mjs";

class FakeChild extends EventEmitter {
  connected = true;
  exitCode = null;
  signalCode = null;
  messages = [];
  killedWith = null;

  send(message) {
    this.messages.push(message);
  }

  kill(signal) {
    this.killedWith = signal;
    this.signalCode = signal;
  }
}

function harness() {
  const engines = [];
  const webs = [];
  const timers = [];
  const logs = [];
  const supervisor = createDevSupervisor({
    env: { PORT: "7789" },
    argv: [],
    engineFactory: () => {
      const child = new FakeChild();
      engines.push(child);
      return child;
    },
    webFactory: () => {
      const child = new FakeChild();
      webs.push(child);
      return child;
    },
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    log: (message) => logs.push(message),
  });
  return { supervisor, engines, webs, timers, logs };
}

test("restarts a crashed engine while keeping Vite alive", () => {
  const { supervisor, engines, webs, timers, logs } = harness();
  supervisor.start();
  assert.equal(engines.length, 1);
  assert.equal(webs.length, 1);

  webs[0].emit("message", { type: "proxy-waiting" });
  engines[0].emit("message", { type: "listening" });
  assert.deepEqual(webs[0].messages, [{ type: "engine-listening" }]);

  engines[0].emit("exit", 1, null);
  assert.equal(webs[0].killedWith, null);
  assert.deepEqual(webs[0].messages.at(-1), { type: "engine-down" });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 250);
  assert.ok(logs.includes("engine exited (code 1)"));

  timers.shift().callback();
  assert.equal(engines.length, 2);
  assert.equal(webs.length, 1);
  engines[1].emit("message", { type: "listening" });
  assert.deepEqual(webs[0].messages.at(-1), { type: "engine-listening" });
  supervisor.stop();
});

test("backs off repeated engine crashes and resets after listening", () => {
  const { supervisor, engines, timers } = harness();
  supervisor.start();
  engines[0].emit("exit", null, "SIGKILL");
  assert.equal(timers[0].delayMs, 250);
  timers.shift().callback();
  engines[1].emit("exit", 1, null);
  assert.equal(timers[0].delayMs, 500);
  timers.shift().callback();
  engines[2].emit("message", { type: "listening" });
  engines[2].emit("exit", 1, null);
  assert.equal(timers[0].delayMs, 250);
  supervisor.stop();
});

test("restarts Vite independently when it exits", () => {
  const { supervisor, engines, webs, timers } = harness();
  supervisor.start();
  webs[0].emit("exit", 1, null);
  assert.equal(engines[0].killedWith, null);
  assert.equal(timers[0].delayMs, 250);
  timers.shift().callback();
  assert.equal(engines.length, 1);
  assert.equal(webs.length, 2);
  supervisor.stop();
});

test("does not restart children after an explicit stop", () => {
  const previousExitCode = process.exitCode;
  const { supervisor, engines, webs, timers } = harness();
  try {
    supervisor.start();
    supervisor.stop(0);
    engines[0].emit("exit", null, "SIGTERM");
    webs[0].emit("exit", null, "SIGTERM");
    assert.equal(timers.length, 0);
    assert.equal(engines[0].killedWith, "SIGTERM");
    assert.equal(webs[0].killedWith, "SIGTERM");
  } finally {
    process.exitCode = previousExitCode;
  }
});
