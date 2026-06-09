import { formatToolResponse, formatErrorResponse } from '../response-formatter.js';
import { need, vsub, vdot, vcross, vnorm, formatNumber, vfmt } from './vec.js';

export async function vectorHandler(args: Record<string, unknown>) {
  try {
    const op = args.operation as string;
    const lists = (args.lists as number[][]) ?? [];

    switch (op) {
      case 'distance3d': {
        const p = need(lists[0], 3, 'first point');
        const q = need(lists[1], 3, 'second point');
        const d = vnorm(vsub(q, p));
        return formatToolResponse({ result: formatNumber(d), notes: [`Distance between ${vfmt(p)} and ${vfmt(q)}`] });
      }
      case 'midpoint3d': {
        const p = need(lists[0], 3, 'first point');
        const q = need(lists[1], 3, 'second point');
        const m = p.map((x, i) => (x + q[i]) / 2);
        return formatToolResponse({ result: vfmt(m), notes: [`Midpoint of ${vfmt(p)} and ${vfmt(q)}`] });
      }
      case 'dot': {
        const u = need(lists[0], 3, 'first vector');
        const v = need(lists[1], 3, 'second vector');
        return formatToolResponse({ result: formatNumber(vdot(u, v)), notes: [`${vfmt(u)} · ${vfmt(v)}`] });
      }
      case 'cross': {
        const u = need(lists[0], 3, 'first vector');
        const v = need(lists[1], 3, 'second vector');
        return formatToolResponse({ result: vfmt(vcross(u, v)), notes: [`${vfmt(u)} × ${vfmt(v)}`] });
      }
      case 'vector_norm': {
        const v = need(lists[0], 3, 'vector');
        return formatToolResponse({ result: formatNumber(vnorm(v)), notes: [`Magnitude of ${vfmt(v)}`] });
      }
      case 'angle_vectors': {
        const u = need(lists[0], 3, 'first vector');
        const v = need(lists[1], 3, 'second vector');
        const nu = vnorm(u);
        const nv = vnorm(v);
        if (nu === 0 || nv === 0) return formatErrorResponse('angle_vectors: vectors must be non-zero');
        const cos = Math.max(-1, Math.min(1, vdot(u, v) / (nu * nv)));
        const deg = (Math.acos(cos) * 180) / Math.PI;
        return formatToolResponse({ result: `${formatNumber(deg)}°`, notes: [`Angle between ${vfmt(u)} and ${vfmt(v)}`] });
      }
      default:
        return formatErrorResponse(`Unknown vector operation: ${op}`);
    }
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
