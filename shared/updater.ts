export interface UpdatePlan {
  enabled: true;
  current: string;
  target: string | null;
  sha256?: string;
  size: number;
  changes?: string;
  channel: string;
}

export interface UpdateResult {
  at: string;
  status: "starting" | "installing" | "restarting" | "checking-health" | "rolling-back" | "applied" | "rolled-back" | "failed" | "rollback-failed" | "manual";
  current: string;
  target: string;
  runningTurns: number;
  message?: string;
}

export type UpdaterState = { enabled: false } | {
  enabled: true;
  current: string;
  layout: "npm-package" | "checkout" | "docker";
  channel: string;
  busy: boolean;
  runningTurns: number;
  lastCheck?: { at: string; plan?: UpdatePlan; error?: string };
  lastApply?: UpdateResult;
};

export const updateInProgress = (status?: UpdateResult["status"]): boolean =>
  status === "starting" || status === "installing" || status === "restarting" || status === "checking-health" || status === "rolling-back";
