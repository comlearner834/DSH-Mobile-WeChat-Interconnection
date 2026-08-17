// render-check.js — 用真实 react + react-dom/server 渲染 client.js 的组件初始路径，验证无运行时错误。
"use strict";

import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const requireFromApp = createRequire("D:/DSH/dsh-desktop/dist/DSH Desktop/resources/app/node_modules/react/package.json");
const React = requireFromApp("react");
const { renderToString } = requireFromApp("react-dom/server");

const src = fs.readFileSync(new URL("../client/client.js", import.meta.url), "utf-8");

let loaded = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (x) => (loaded = x) } },
  console,
};
sandbox.require = (id) => {
  if (id === "react") return React;
  throw new Error("unexpected require: " + id);
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const exportsObj = loaded.factory(sandbox.require);
let registered = null;
const ctx = {
  slots: {
    inject: (_slot, fn) => (registered = fn),
    register: (meta, component) => component,
  },
};
exportsObj.apply(ctx);
const component = registered();

// 渲染初始状态（未打开弹窗）
const html = renderToString(React.createElement(component));
if (!html.includes("dshwl-btn") || !html.includes("手机微信互联")) {
  throw new Error("button markup missing from render: " + html.slice(0, 300));
}
console.log("render OK, button present, html length =", html.length);
