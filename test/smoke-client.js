// smoke-client.js — 验证 client.js 的 __ModuleLoader__ 契约（无需真实浏览器/React）。
"use strict";

import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../client/client.js", import.meta.url), "utf-8");

const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (x) => {
        sandbox.__loaded = x;
      },
    },
  },
  console,
};

// react 桩：返回可调用的 Proxy，避免任何渲染路径崩溃
const callable = () => {};
const reactStub = new Proxy(callable, {
  get: (t, k) => {
    if (k === "createElement") return () => ({ __tag: "el" });
    if (k === "useState") return () => [null, () => {}];
    if (k === "useEffect" || k === "useRef" || k === "useCallback") return () => () => {};
    return reactStub;
  },
  apply: () => reactStub,
});
const requireStub = (id) => {
  if (id === "react") return reactStub;
  if (id === "react/jsx-runtime") return { jsx: () => ({}) };
  throw new Error("unexpected require: " + id);
};

sandbox.require = requireStub;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const loaded = sandbox.__loaded;
if (!loaded) throw new Error("bundle did not call __ModuleLoader__.load");
const exportsObj = loaded.factory(sandbox.require);
console.log("exports:", Object.keys(exportsObj));
if (exportsObj.name !== "dsh-wechat-link") throw new Error("bad name");
if (!Array.isArray(exportsObj.inject) || !exportsObj.inject.includes("slots")) throw new Error("bad inject");

const calls = [];
const ctx = {
  slots: {
    inject: (slot, fn) => calls.push([slot, typeof fn]),
  },
};
exportsObj.apply(ctx);
console.log("slots.inject:", JSON.stringify(calls));
if (calls.length !== 1 || calls[0][0] !== "shell.overlay" || calls[0][1] !== "function") {
  throw new Error("apply did not register shell.overlay correctly");
}
console.log("SMOKE OK");
