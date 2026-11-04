export interface Point { x: number; y: number }
export interface View extends Point { scale: number }

export function zoomAt(view: View, nextScale: number, point: Point): View {
  const ratio = nextScale / view.scale;
  return {
    x: point.x - (point.x - view.x) * ratio,
    y: point.y - (point.y - view.y) * ratio,
    scale: nextScale,
  };
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
export const FIT_VIEW: View = { x: 0, y: 0, scale: 1 };

export function clampScale(scale: number): number {
  return Number.isNaN(scale) ? ZOOM_MIN : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

export function clampPan(view: View, content: { width: number; height: number }, viewport: { width: number; height: number }): View {
  const limitX = Math.max(0, (content.width * view.scale - viewport.width) / 2);
  const limitY = Math.max(0, (content.height * view.scale - viewport.height) / 2);
  return {
    x: limitX === 0 ? 0 : Math.max(-limitX, Math.min(limitX, view.x)),
    y: limitY === 0 ? 0 : Math.max(-limitY, Math.min(limitY, view.y)),
    scale: view.scale,
  };
}

export function pinchScale(startScale: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !Number.isFinite(distance)) return clampScale(startScale);
  return clampScale(startScale * (distance / startDistance));
}

export function actualSizeScale(naturalWidth: number, fittedWidth: number): number {
  if (fittedWidth <= 0 || !Number.isFinite(naturalWidth) || !Number.isFinite(fittedWidth)) return 2.5;
  const scale = clampScale(naturalWidth / fittedWidth);
  return scale === ZOOM_MIN ? 2.5 : scale;
}
