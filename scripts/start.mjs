import { buildWeb } from "./web-build.mjs";
import { runEngine } from "./start-engine.mjs";

buildWeb({ reuse: true });
runEngine({ ...process.env, SERVE_UI: "1", PORT: process.env.PORT ?? "7788" });
