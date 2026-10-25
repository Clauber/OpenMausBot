/**
 * Wire format of ZCode's `/ws` channel protocol: socket framing, value
 * serialization, and the request/response messages.
 *
 * Protocol derived from ZCode (zai-org/ZCode), Apache-2.0; minimal re-implementation.
 *
 * Decoders throw on malformed input. The client maps any throw to a fixed
 * "malformed frame" error, so a thrown message never reaches an error value.
 */

export const RequestType = {
  Promise: 100,
  PromiseCancel: 101,
  EventListen: 102,
  EventDispose: 103,
} as const;

export const ResponseType = {
  Initialize: 200,
  PromiseSuccess: 201,
  PromiseError: 202,
  PromiseErrorObj: 203,
  EventFire: 204,
} as const;

export type ChannelResponse =
  | { readonly type: typeof ResponseType.Initialize }
  | {
      readonly type:
        | typeof ResponseType.PromiseSuccess
        | typeof ResponseType.PromiseError
        | typeof ResponseType.PromiseErrorObj
        | typeof ResponseType.EventFire;
      readonly id: number;
      readonly data: unknown;
    };

// Frame header: type(1) id(4) ack(4) length(4), big endian. Only Regular
// frames carry messages; the plain socket protocol never sends acks.
const HEADER_SIZE = 13;
const REGULAR_FRAME = 1;
const MAX_FRAME_BYTES = 128 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export const encodeFrame = (payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, REGULAR_FRAME);
  view.setUint32(9, payload.length);
  frame.set(payload, HEADER_SIZE);
  return frame;
};

/** Reassembles frames from arbitrary chunking and returns the Regular payloads. */
export const makeFrameDecoder = () => {
  let pending: Uint8Array = new Uint8Array(0);
  return (chunk: Uint8Array): ReadonlyArray<Uint8Array> => {
    pending = pending.length === 0 ? chunk : concat([pending, chunk]);
    const payloads: Array<Uint8Array> = [];
    while (pending.length >= HEADER_SIZE) {
      const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
      const length = view.getUint32(9);
      if (length > MAX_FRAME_BYTES) throw new RangeError("frame too large");
      if (pending.length < HEADER_SIZE + length) break;
      if (view.getUint8(0) === REGULAR_FRAME && length > 0) {
        payloads.push(pending.slice(HEADER_SIZE, HEADER_SIZE + length));
      }
      pending = pending.subarray(HEADER_SIZE + length);
    }
    return payloads;
  };
};

// Value tags. Buffer values are returned as bytes; this client never sends them.
const Tag = {
  Undefined: 0,
  String: 1,
  Buffer: 2,
  VSBuffer: 3,
  Array: 4,
  Object: 5,
  Int: 6,
} as const;

// 7 bits per byte, low group first, high bit set when more bytes follow.
const vql = (value: number): Uint8Array => {
  if (value === 0) return Uint8Array.of(0);
  const bytes: Array<number> = [];
  for (let rest = value; rest !== 0; rest >>>= 7) {
    bytes.push((rest & 0x7f) | (rest >>> 7 !== 0 ? 0x80 : 0));
  }
  return Uint8Array.from(bytes);
};

const serializeInto = (parts: Array<Uint8Array>, data: unknown): void => {
  if (data === undefined) {
    parts.push(Uint8Array.of(Tag.Undefined));
  } else if (typeof data === "string") {
    const bytes = encoder.encode(data);
    parts.push(Uint8Array.of(Tag.String), vql(bytes.length), bytes);
  } else if (Array.isArray(data)) {
    parts.push(Uint8Array.of(Tag.Array), vql(data.length));
    for (const element of data) serializeInto(parts, element);
  } else if (typeof data === "number" && (data | 0) === data) {
    parts.push(Uint8Array.of(Tag.Int), vql(data));
  } else {
    const bytes = encoder.encode(JSON.stringify(data) ?? "null");
    parts.push(Uint8Array.of(Tag.Object), vql(bytes.length), bytes);
  }
};

interface Cursor {
  readonly bytes: Uint8Array;
  pos: number;
}

const take = (cursor: Cursor, count: number): Uint8Array => {
  if (count < 0 || cursor.pos + count > cursor.bytes.length) throw new RangeError("truncated");
  const out = cursor.bytes.subarray(cursor.pos, cursor.pos + count);
  cursor.pos += count;
  return out;
};

const readVql = (cursor: Cursor): number => {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const byte = take(cursor, 1)[0]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
  }
  throw new RangeError("vql too long");
};

const deserializeFrom = (cursor: Cursor): unknown => {
  switch (take(cursor, 1)[0]) {
    case Tag.Undefined:
      return undefined;
    case Tag.String:
      return decoder.decode(take(cursor, readVql(cursor)));
    case Tag.Buffer:
    case Tag.VSBuffer:
      return take(cursor, readVql(cursor)).slice();
    case Tag.Array: {
      const length = readVql(cursor);
      const out: Array<unknown> = [];
      for (let index = 0; index < length; index++) out.push(deserializeFrom(cursor));
      return out;
    }
    case Tag.Object:
      return JSON.parse(decoder.decode(take(cursor, readVql(cursor))));
    case Tag.Int:
      return readVql(cursor);
    default:
      throw new RangeError("unknown tag");
  }
};

/** Every message is one serialized header (an array) followed by one serialized body. */
export const encodeMessage = (header: ReadonlyArray<unknown>, body: unknown): Uint8Array => {
  const parts: Array<Uint8Array> = [];
  serializeInto(parts, header);
  serializeInto(parts, body);
  return concat(parts);
};

export const decodeMessage = (payload: Uint8Array): { header: unknown; body: unknown } => {
  const cursor: Cursor = { bytes: payload, pos: 0 };
  const header = deserializeFrom(cursor);
  return { header, body: deserializeFrom(cursor) };
};

export const encodeRequest = (
  type: typeof RequestType.Promise | typeof RequestType.EventListen,
  id: number,
  channel: string,
  name: string,
  arg: unknown,
): Uint8Array => encodeFrame(encodeMessage([type, id, channel, name], arg));

export const encodeCancel = (
  type: typeof RequestType.PromiseCancel | typeof RequestType.EventDispose,
  id: number,
): Uint8Array => encodeFrame(encodeMessage([type, id], undefined));

/** Returns undefined for response types this client does not know. */
export const decodeResponse = (payload: Uint8Array): ChannelResponse | undefined => {
  const { header, body } = decodeMessage(payload);
  if (!Array.isArray(header)) throw new TypeError("header");
  switch (header[0]) {
    case ResponseType.Initialize:
      return { type: ResponseType.Initialize };
    case ResponseType.PromiseSuccess:
    case ResponseType.PromiseError:
    case ResponseType.PromiseErrorObj:
    case ResponseType.EventFire:
      if (typeof header[1] !== "number") throw new TypeError("id");
      return { type: header[0], id: header[1], data: body };
    default:
      return undefined;
  }
};
