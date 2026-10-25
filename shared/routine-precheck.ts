/** A locally approved executable, invoked directly without a shell. */
export interface RoutinePreCheck {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface RoutinePreCheckItem {
  source: string;
  id: string;
  from: string;
  subject?: string;
  channel?: string;
  snippet: string;
}

export interface RoutinePreCheckResult {
  state: "pending" | "wake" | "skip" | "fallback";
  reason?: string;
  probability?: number;
  items?: RoutinePreCheckItem[];
}
