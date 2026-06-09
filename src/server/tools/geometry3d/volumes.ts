import { formatToolResponse, formatErrorResponse } from '../response-formatter.js';
import { need, vsub, vdot, vcross, formatNumber } from './vec.js';

export async function volumeHandler(args: Record<string, unknown>) {
  try {
    const op = args.operation as string;
    const lists = (args.lists as number[][]) ?? [];

    switch (op) {
      case 'volume_tetrahedron': {
        const p1 = need(lists[0], 3, 'P1');
        const p2 = need(lists[1], 3, 'P2');
        const p3 = need(lists[2], 3, 'P3');
        const p4 = need(lists[3], 3, 'P4');
        const v = Math.abs(vdot(vsub(p2, p1), vcross(vsub(p3, p1), vsub(p4, p1)))) / 6;
        return formatToolResponse({ result: formatNumber(v), notes: ['Volume = |(P2−P1)·((P3−P1)×(P4−P1))| / 6'] });
      }
      case 'volume_parallelepiped': {
        const a = need(lists[0], 3, 'V1');
        const b = need(lists[1], 3, 'V2');
        const c = need(lists[2], 3, 'V3');
        const v = Math.abs(vdot(a, vcross(b, c)));
        return formatToolResponse({ result: formatNumber(v), notes: ['Volume = |V1·(V2×V3)|'] });
      }
      case 'volume_sphere': {
        const r = args.scalar as number | undefined;
        if (r === undefined || !Number.isFinite(r)) return formatErrorResponse('volume_sphere requires a numeric radius');
        if (r < 0) return formatErrorResponse('volume_sphere: radius must be non-negative');
        const v = (4 / 3) * Math.PI * r ** 3;
        return formatToolResponse({ result: formatNumber(v), notes: [`Volume = (4/3)·π·${formatNumber(r)}³`] });
      }
      default:
        return formatErrorResponse(`Unknown volume operation: ${op}`);
    }
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
