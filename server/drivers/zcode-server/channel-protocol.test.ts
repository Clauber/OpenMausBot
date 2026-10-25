import { describe, expect, it } from "vitest";

import { ResponseType, decodeMessage, decodeResponse, encodeCancel, encodeFrame, encodeMessage, encodeRequest, makeFrameDecoder, RequestType } from "./channel-protocol.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("channel protocol", () => {
  it("serializes values to the upstream byte layout", () => {
    expect(encodeMessage([ResponseType.Initialize], undefined)).toEqual(bytes(4, 1, 6, 0xc8, 0x01, 0));
    expect(encodeMessage(["ab"], undefined)).toEqual(bytes(4, 1, 1, 2, 0x61, 0x62, 0));
    expect(encodeMessage([], { a: 1 })).toEqual(bytes(4, 0, 5, 7, ...Buffer.from('{"a":1}')));
  });

  it("round-trips ints, strings, nested arrays, and objects", () => {
    const body = { revision: 3, providers: [], nested: { ok: true, none: null, pi: 3.5 } };
    const decoded = decodeMessage(encodeMessage([102, -7, 123456789, "モデル", [1, ["x"]]], body));
    expect(decoded.header).toEqual([102, -7, 123456789, "モデル", [1, ["x"]]]);
    expect(decoded.body).toEqual(body);
  });

  it("rejects truncated and unknown-tag payloads", () => {
    expect(() => decodeMessage(bytes(1, 5, 0x61))).toThrow();
    expect(() => decodeMessage(bytes(99))).toThrow();
  });

  it("frames with a 13 byte big-endian header and reassembles split and coalesced chunks", () => {
    const first = encodeFrame(bytes(1, 2, 3));
    expect(first.slice(0, 13)).toEqual(bytes(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3));
    const second = encodeFrame(bytes(9));
    const decode = makeFrameDecoder();
    expect(decode(first.slice(0, 5))).toEqual([]);
    expect(decode(first.slice(5, 14))).toEqual([]);
    expect(decode(new Uint8Array([...first.slice(14), ...second]))).toEqual([bytes(1, 2, 3), bytes(9)]);
  });

  it("skips non-Regular frames", () => {
    const keepAlive = encodeFrame(bytes(7));
    keepAlive[0] = 9;
    expect(makeFrameDecoder()(keepAlive)).toEqual([]);
  });

  it("rejects oversized frames", () => {
    const header = new Uint8Array(13);
    header[0] = 1;
    new DataView(header.buffer).setUint32(9, 0xffffffff);
    expect(() => makeFrameDecoder()(header)).toThrow();
  });

  it("encodes requests and cancels as one frame each", () => {
    const [request] = makeFrameDecoder()(encodeRequest(RequestType.Promise, 3, "c", "m", ["a"]));
    expect(decodeMessage(request!)).toEqual({ header: [RequestType.Promise, 3, "c", "m"], body: ["a"] });
    const [cancel] = makeFrameDecoder()(encodeCancel(RequestType.EventDispose, 3));
    expect(decodeMessage(cancel!)).toEqual({ header: [RequestType.EventDispose, 3], body: undefined });
  });

  it("decodes responses, ignores unknown types, and rejects a missing id", () => {
    expect(decodeResponse(encodeMessage([ResponseType.Initialize], undefined))).toEqual({ type: ResponseType.Initialize });
    expect(decodeResponse(encodeMessage([ResponseType.EventFire, 4], { n: 1 }))).toEqual({ type: ResponseType.EventFire, id: 4, data: { n: 1 } });
    expect(decodeResponse(encodeMessage([999], undefined))).toBeUndefined();
    expect(() => decodeResponse(encodeMessage([ResponseType.PromiseSuccess], undefined))).toThrow();
  });
});
