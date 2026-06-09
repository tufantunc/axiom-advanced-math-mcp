import { formatToolResponse, formatErrorResponse } from '../response-formatter.js';
import { need, vsub, vdot, vcross, vnorm, formatNumber, vfmt, isZero } from './vec.js';

export async function planeHandler(args: Record<string, unknown>) {
  try {
    const op = args.operation as string;
    const lists = (args.lists as number[][]) ?? [];

    switch (op) {
      case 'plane_from_points': {
        const p1 = need(lists[0], 3, 'P1');
        const p2 = need(lists[1], 3, 'P2');
        const p3 = need(lists[2], 3, 'P3');
        const n = vcross(vsub(p2, p1), vsub(p3, p1));
        if (isZero(vnorm(n))) return formatErrorResponse('plane_from_points: the three points are collinear');
        const d = -vdot(n, p1);
        const plane = [...n, d];
        return formatToolResponse({
          result: vfmt(plane),
          notes: [
            `Plane ax+by+cz+d=0 through ${vfmt(p1)}, ${vfmt(p2)}, ${vfmt(p3)}`,
            `${formatNumber(n[0])}x + ${formatNumber(n[1])}y + ${formatNumber(n[2])}z + ${formatNumber(d)} = 0`,
            'Coefficients use the raw cross-product normal (not unit-normalized).',
          ],
        });
      }
      case 'point_plane_distance': {
        const p = need(lists[0], 3, 'point');
        const pl = need(lists[1], 4, 'plane');
        const n = pl.slice(0, 3);
        const nn = vnorm(n);
        if (isZero(nn)) return formatErrorResponse('point_plane_distance: degenerate plane (zero normal)');
        const dist = Math.abs(vdot(n, p) + pl[3]) / nn;
        return formatToolResponse({ result: formatNumber(dist), notes: [`Distance from ${vfmt(p)} to plane ${vfmt(pl)}`] });
      }
      case 'line_plane_intersection': {
        const p = need(lists[0], 3, 'line point');
        const dir = need(lists[1], 3, 'line direction');
        const pl = need(lists[2], 4, 'plane');
        const n = pl.slice(0, 3);
        const denom = vdot(n, dir);
        if (isZero(denom)) return formatErrorResponse('line_plane_intersection: line is parallel to the plane');
        const t = -(vdot(n, p) + pl[3]) / denom;
        const pt = p.map((x, i) => x + t * dir[i]);
        return formatToolResponse({
          result: vfmt(pt),
          notes: [`Line ${vfmt(p)} + t·${vfmt(dir)} meets plane ${vfmt(pl)} at t = ${formatNumber(t)}`],
        });
      }
      case 'plane_plane_angle': {
        const a = need(lists[0], 4, 'first plane');
        const b = need(lists[1], 4, 'second plane');
        const na = a.slice(0, 3);
        const nb = b.slice(0, 3);
        const da = vnorm(na);
        const db = vnorm(nb);
        if (isZero(da) || isZero(db)) return formatErrorResponse('plane_plane_angle: degenerate plane (zero normal)');
        const cos = Math.max(-1, Math.min(1, Math.abs(vdot(na, nb)) / (da * db)));
        const deg = (Math.acos(cos) * 180) / Math.PI;
        return formatToolResponse({ result: `${formatNumber(deg)}°`, notes: [`Angle between planes ${vfmt(a)} and ${vfmt(b)}`] });
      }
      case 'line_line_distance': {
        const p1 = need(lists[0], 3, 'line1 point');
        const d1 = need(lists[1], 3, 'line1 direction');
        const p2 = need(lists[2], 3, 'line2 point');
        const d2 = need(lists[3], 3, 'line2 direction');
        const w = vsub(p2, p1);
        const cr = vcross(d1, d2);
        if (isZero(vnorm(cr))) {
          const nd1 = vnorm(d1);
          if (isZero(nd1)) return formatErrorResponse('line_line_distance: line1 direction is the zero vector');
          const dist = vnorm(vcross(w, d1)) / nd1;
          return formatToolResponse({ result: formatNumber(dist), notes: ['Lines are parallel'] });
        }
        const dist = Math.abs(vdot(w, cr)) / vnorm(cr);
        const note = isZero(dist) ? 'Lines intersect (distance = 0)' : 'Distance between skew lines';
        return formatToolResponse({ result: formatNumber(dist), notes: [note] });
      }
      default:
        return formatErrorResponse(`Unknown plane operation: ${op}`);
    }
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
