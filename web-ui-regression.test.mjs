import { readFileSync } from "node:fs";

const app = readFileSync("web/app.js", "utf8");

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exitCode = 1;
  }
}

assert(app.includes("sentHistory"), "composer must keep sent message history");
assert(app.includes('e.key === "ArrowUp"'), "composer must handle ArrowUp history recall");
assert(app.includes("/api/channel/backend"), "channel backend menu must call the backend API");
assert(app.includes("setChannelBackend"), "channel backend setter must be wired in app.js");
assert(app.includes('fd.append("target", JSON.stringify(currentTarget || { kind: "telegram" }))'), "attachment uploads must include the current conversation target");

if (process.exitCode) process.exit(process.exitCode);
