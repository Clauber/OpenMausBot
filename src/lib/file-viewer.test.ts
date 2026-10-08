import { describe, expect, it } from "vitest";

import {
  fileViewerExtension,
  fileViewerKind,
  fileViewerTabId,
  formatByteSize,
  textPreviewExceeds,
  truncateTextPreview,
} from "./file-viewer";

describe("file viewer classification", () => {
  it("trusts a specific server MIME over the file name", () => {
    expect(fileViewerKind("text/plain; charset=utf-8", "/tmp/report.bin")).toBe("text");
    expect(fileViewerKind("application/pdf", "/tmp/thing.txt")).toBe("pdf");
    expect(fileViewerKind("image/png", "/tmp/cover.dat")).toBe("image");
    expect(fileViewerKind("video/mp4", "/tmp/clip.dat")).toBe("video");
    expect(fileViewerKind("audio/mpeg", "/tmp/clip.dat")).toBe("audio");
  });

  it("renders structured text MIME types as source", () => {
    expect(fileViewerKind("application/json", "/tmp/data.json")).toBe("text");
    expect(fileViewerKind("application/xml", "/tmp/feed.xml")).toBe("text");
    expect(fileViewerKind("application/x-yaml", "/tmp/compose.yml")).toBe("text");
    expect(fileViewerKind("image/svg+xml", "/tmp/icon.svg")).toBe("text");
  });

  it("falls back to the extension only when the MIME is generic", () => {
    expect(fileViewerKind("application/octet-stream", "/tmp/app.py")).toBe("text");
    expect(fileViewerKind("application/octet-stream", "/tmp/notes.md")).toBe("text");
    expect(fileViewerKind(null, "/tmp/ARCHIVE.zip")).toBe("unsupported");
    // A lying specific MIME stays a download: only generic MIME reads names.
    expect(fileViewerKind("application/octet-stream", "/tmp/movie.mp4")).toBe("video");
    expect(fileViewerKind("application/octet-stream", "/tmp/song.flac")).toBe("audio");
    expect(fileViewerKind("application/octet-stream", "/tmp/scan.pdf")).toBe("pdf");
    expect(fileViewerKind("application/octet-stream", "/tmp/pic.JPG")).toBe("image");
  });

  it("keeps unknown binaries and media the server named away as downloads", () => {
    expect(fileViewerKind("application/vnd.unknown+binary", "/tmp/blob")).toBe("unsupported");
    expect(fileViewerKind("application/x-msdownload", "/tmp/setup.exe")).toBe("unsupported");
  });

  it("reads the extension from the basename only", () => {
    expect(fileViewerExtension("/a/b/c.d/notes.txt")).toBe("txt");
    expect(fileViewerExtension("/no/ext")).toBe("");
  });

  it("builds stable per-message tab ids", () => {
    expect(fileViewerTabId("t1", "m1", "/a.md")).toBe("t1\u0000m1\u0000/a.md");
    expect(fileViewerTabId("t1", "m1", "/a.md")).not.toBe(fileViewerTabId("t1", "m2", "/a.md"));
  });
});

describe("text preview bounds", () => {
  it("flags declared sizes past the cap without needing the bytes", () => {
    expect(textPreviewExceeds(null)).toBe(false);
    expect(textPreviewExceeds(1_000_000)).toBe(false);
    expect(textPreviewExceeds(1_000_001)).toBe(true);
  });

  it("truncates long text without leaving a lone surrogate", () => {
    expect(truncateTextPreview("short")).toBe("short");
    const long = "a".repeat(1_000_001);
    expect(truncateTextPreview(long)).toHaveLength(1_000_000);
    // 𝄞 is one code point over two UTF-16 units; the cut drops the whole
    // character rather than splitting it into a lone surrogate.
    const note = "b".repeat(999_999) + "𝄞";
    const capped = truncateTextPreview(note);
    expect(capped).toHaveLength(999_999);
    const last = capped.charCodeAt(capped.length - 1);
    expect(last >= 0xd800 && last <= 0xdfff).toBe(false);
  });
});

describe("byte formatting", () => {
  it("formats preview sizes for the unsupported card", () => {
    expect(formatByteSize(null)).toBe("");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(2048)).toBe("2 KB");
    expect(formatByteSize(5 * 1024 * 1024)).toBe("5 MB");
  });
});
