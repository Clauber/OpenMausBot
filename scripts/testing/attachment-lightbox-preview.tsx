// Real AttachmentThumbnail + AttachmentPreviewDialog over synthetic canvas
// images, so zoom, pan and the scale readout are driven without any of the
// user's attachments. Mounted by scripts/verify-attachment-lightbox.ts.
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { AttachmentPreviewDialog, AttachmentThumbnail, type PreviewImage } from "@/components/AttachmentPreview";
import "@/styles.css";

function syntheticImage(width: number, height: number, title: string): PreviewImage {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#f8fafc";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#0f172a";
  context.font = "bold 60px sans-serif";
  context.fillText(title, 60, 100);
  context.font = "32px sans-serif";
  for (let y = 180; y < height; y += 100) {
    context.fillStyle = y % 200 ? "#dbeafe" : "#cbd5e1";
    context.fillRect(40, y - 40, width - 80, 70);
    context.fillStyle = "#0f172a";
    context.fillText(`Synthetic detail row ${(y - 80) / 100}`, 70, y);
  }
  const src = canvas.toDataURL();
  return { src, name: `${title}.png`, downloadUrl: src, openUrl: src };
}

const images = [
  syntheticImage(2400, 1600, "Dense infographic"),
  syntheticImage(600, 2400, "Portrait infographic"),
];

function Probe() {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <div className="flex gap-3 bg-canvas p-4">
      {images.map((image, index) => (
        <AttachmentThumbnail
          key={image.name}
          image={image}
          onPreview={() => setSelected(index)}
          className="w-64"
          eager
        />
      ))}
      {selected !== null && (
        <AttachmentPreviewDialog
          image={images[selected]!}
          images={images}
          initialIndex={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Probe />);
