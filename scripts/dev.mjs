import { createDevSupervisor } from "./dev-supervisor.mjs";

const supervisor = createDevSupervisor();
supervisor.start();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => supervisor.stop());
