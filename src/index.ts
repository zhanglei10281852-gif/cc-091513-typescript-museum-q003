import { createApp } from "./app.js";
import { createContext } from "./bootstrap.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const sweepMs = Number.parseInt(process.env.SWEEP_INTERVAL_MS ?? "600000", 10);

const ctx = createContext();
const server = createApp(ctx);

// 周期性扫描评审超时，自动驳回并释放预占额度。
const sweeper = setInterval(() => {
  ctx.service.expireTimedOut().catch((error) => {
    process.stderr.write(`timeout sweep failed: ${String(error)}\n`);
  });
}, sweepMs);
sweeper.unref();

server.listen(port, host, () => {
  process.stdout.write(`service listening on ${host}:${port}\n`);
});
