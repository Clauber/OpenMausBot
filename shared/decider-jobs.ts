// The decision model's jobs, shared by the server (server/decider) and
// Settings. Each job's question and default live in server/decider/jobs.ts
// (room routing's in room-routing.ts).

export type DeciderJob = "roomRouting" | "toolPick" | "workPlace" | "browserClick" | "routineWake" | "routineGate";
/** In the order Settings lists them. */
export const DECIDER_JOBS: readonly DeciderJob[] = ["roomRouting", "toolPick", "workPlace", "browserClick", "routineWake", "routineGate"];
