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
