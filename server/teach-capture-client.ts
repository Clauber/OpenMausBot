/** Recording observer for the existing gated computer MCP bridges. */
export function createTeachCaptureClient(connection: { url: string; token: string }) {
  const pending = new Map<string, string>();
  const key = (id: unknown) => JSON.stringify([typeof id, id]);
  const post = async (body: unknown) => {
    const url = new URL(connection.url);
    url.pathname = "/api/internal/teach-capture"; url.search = "";
    const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` }, body: JSON.stringify(body) });
    const result = await response.json() as { captureId?: string; error?: string };
    if (!response.ok) throw new Error(result.error ?? "Teaching capture is unavailable.");
    return result;
  };
  return {
    async before(line: string) {
      let frame;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame?.method !== "tools/call" || frame.id === undefined) return;
      const response = await post({ phase: "begin", tool: frame.params?.name, args: frame.params?.arguments ?? {} });
      if (response.captureId) pending.set(key(frame.id), response.captureId);
    },
    async after(line: string) {
      let frame;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame?.id === undefined || frame.method) return;
      const captureId = pending.get(key(frame.id));
      if (!captureId) return;
      pending.delete(key(frame.id));
      await post({ phase: "finish", captureId, result: frame.result ?? { isError: true, error: frame.error } });
    },
  };
}
