import { readFileSync } from "node:fs";
import { runUpdateJob, type UpdateJob } from "./updater.ts";

// Bundled and copied outside node_modules before installation. The independent
// transient systemd user unit survives restart of the server's own unit.
const job = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as UpdateJob;
await runUpdateJob(job);
