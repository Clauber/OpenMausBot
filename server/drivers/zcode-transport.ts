// How a server-mode ZCode turn talks to its engine: the driver speaks the
// app-server ("ZCode Protocol") request names to a ZCode server through its
// channel RPC.

export interface ZcodeServerRequest {
  id: unknown;
  method: string;
  params?: unknown;
}

export interface ZcodeTransportFailure {
  message: string;
  /** The turn's settle reason. */
  stopReason: "spawn_error" | "exit_before_result" | "connection_lost";
  setup?: boolean;
}

export interface ZcodeTransportHandlers {
  /** A server→client request (a permission or user-input ask). */
  serverRequest(request: ZcodeServerRequest): void;
  /** A `session/event` notification's params. */
  event(params: unknown): void;
  /** The engine went away before the turn settled. */
  failed(failure: ZcodeTransportFailure): void;
}

export interface ZcodeTransport {
  /**
   * How long a stop waits for the engine to report the cancelled turn itself before the transport is torn down.
   * Absent for a process the stop simply kills.
   */
  readonly stopGraceMs?: number;
  /** Correlated request; rejects with the engine's error message. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  /** Answers a server→client request. */
  respond(id: unknown, result: unknown): void;
  /** Refuses a server→client request so the engine applies its own fallback. */
  respondError(id: unknown, code: number, message: string): void;
  /** False once the engine process or connection is gone. */
  alive(): boolean;
  /** Stops delivering anything to the handlers; the engine may still be winding down. */
  mute(): void;
  /** Stops the engine side without touching pending requests; true once it is fully stopped. */
  terminate(): Promise<boolean>;
  /** Mutes, rejects pending requests and terminates. */
  close(): Promise<boolean>;
}

export const ZCODE_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
