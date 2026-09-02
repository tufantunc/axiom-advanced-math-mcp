import { formatToolResponse, formatErrorResponse } from './response-formatter.js';

export async function geometryHandler(args: Record<string, unknown>) {
  try {
    const op = args.operation as string;
    const points = (args.points as [number, number][]) || [];
    const radius = args.radius as number | undefined;
    const diameter = args.diameter as number | undefined;
    const base = args.base as number | undefined;
    const height = args.height as number | undefined;
    const line1 = args.line1 as [number, number, number] | undefined;
    const line2 = args.line2 as [number, number, number] | undefined;

    switch (op) {
      case 'distance': {
        if (points.length < 2) return formatErrorResponse('distance requires at least 2 points');
        const [[x1, y1], [x2, y2]] = points;
        const d = Math.hypot(x2 - x1, y2 - y1);
        const exactSquared = (x2 - x1) ** 2 + (y2 - y1) ** 2;
        // The squared sum overflows above ~1e154 while hypot stays finite —
        // a "d = √(Infinity)" derivation beside a finite answer contradicts
        // itself, so that note switches to the form actually computed.
        const derivation = Number.isFinite(exactSquared)
          ? `d = √(${formatNumber(exactSquared)})`
          : `d = hypot(${formatNumber(x2 - x1)}, ${formatNumber(y2 - y1)})`;
        return formatToolResponse({
          result: formatNumber(d),
          notes: [
            `Distance between (${x1},${y1}) and (${x2},${y2})`,
            derivation,
          ],
        });
      }

      case 'midpoint': {
        if (points.length < 2) return formatErrorResponse('midpoint requires 2 points');
        const [[x1, y1], [x2, y2]] = points;
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        return formatToolResponse({
          result: `(${formatNumber(mx)}, ${formatNumber(my)})`,
          notes: [`Midpoint of (${x1},${y1}) and (${x2},${y2})`],
        });
      }

      case 'slope': {
        if (points.length < 2) return formatErrorResponse('slope requires 2 points');
        const [[x1, y1], [x2, y2]] = points;
        if (x2 === x1) return formatErrorResponse('Vertical line — slope is undefined (infinite)');
        const m = (y2 - y1) / (x2 - x1);
        return formatToolResponse({
          result: formatNumber(m),
          notes: [
            `Slope through (${x1},${y1}) and (${x2},${y2})`,
            `m = (${y2}-${y1})/(${x2}-${x1}) = ${formatNumber(m)}`,
          ],
        });
      }

      case 'area_triangle': {
        if (base !== undefined && height !== undefined) {
          const a = (base * height) / 2;
          return formatToolResponse({
            result: formatNumber(a),
            notes: [`Area = ½ × base × height = ½ × ${base} × ${height} = ${formatNumber(a)}`],
          });
        }
        if (points.length >= 3) {
          const [[x1, y1], [x2, y2], [x3, y3]] = points;
          const a = Math.abs(x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)) / 2;
          return formatToolResponse({
            result: formatNumber(a),
            notes: [
              `Triangle vertices: (${x1},${y1}), (${x2},${y2}), (${x3},${y3})`,
              `Area = ½|x₁(y₂-y₃) + x₂(y₃-y₁) + x₃(y₁-y₂)|`,
            ],
          });
        }
        return formatErrorResponse('area_triangle requires 3 points or base+height');
      }

      case 'area_polygon': {
        if (points.length < 3)
          return formatErrorResponse('area_polygon requires at least 3 vertices');
        let area = 0;
        const n = points.length;
        for (let i = 0; i < n; i++) {
          const [xi, yi] = points[i];
          const [xj, yj] = points[(i + 1) % n];
          area += xi * yj - xj * yi;
        }
        area = Math.abs(area) / 2;
        return formatToolResponse({
          result: formatNumber(area),
          notes: [
            `Polygon with ${n} vertices (shoelace formula)`,
            `Vertices: ${points.map(([x, y]) => `(${x},${y})`).join(', ')}`,
          ],
        });
      }

      case 'area_circle': {
        const r = radius ?? (diameter !== undefined ? diameter / 2 : undefined);
        if (r === undefined) return formatErrorResponse('area_circle requires radius or diameter');
        const a = Math.PI * r * r;
        return formatToolResponse({
          result: formatNumber(a),
          notes: [`Area = π × ${r}² = ${formatNumber(a)}`],
        });
      }

      case 'perimeter_polygon': {
        if (points.length < 2)
          return formatErrorResponse('perimeter_polygon requires at least 2 vertices');
        let perimeter = 0;
        const n = points.length;
        for (let i = 0; i < n; i++) {
          const [xi, yi] = points[i];
          const [xj, yj] = points[(i + 1) % n];
          perimeter += Math.hypot(xj - xi, yj - yi);
        }
        return formatToolResponse({
          result: formatNumber(perimeter),
          notes: [`Perimeter of polygon with ${n} vertices`],
        });
      }

      case 'circumference': {
        const r = radius ?? (diameter !== undefined ? diameter / 2 : undefined);
        if (r === undefined)
          return formatErrorResponse('circumference requires radius or diameter');
        const c = 2 * Math.PI * r;
        return formatToolResponse({
          result: formatNumber(c),
          notes: [`C = 2π × ${r} = ${formatNumber(c)}`],
        });
      }

      case 'line_intersection': {
        if (!line1 || !line2)
          return formatErrorResponse('line_intersection requires line1 and line2 as [a,b,c]');
        const [a1, b1, c1] = line1;
        const [a2, b2, c2] = line2;
        const det = a1 * b2 - a2 * b1;
        if (Math.abs(det) < 1e-12) {
          return formatErrorResponse('Lines are parallel — no intersection (determinant ≈ 0)');
        }
        const x = (b1 * c2 - b2 * c1) / det;
        const y = (a2 * c1 - a1 * c2) / det;
        return formatToolResponse({
          result: `(${formatNumber(x)}, ${formatNumber(y)})`,
          notes: [
            `Line 1: ${a1}x + ${b1}y + ${c1} = 0`,
            `Line 2: ${a2}x + ${b2}y + ${c2} = 0`,
            `Intersection point`,
          ],
        });
      }

      case 'point_line_distance': {
        if (points.length < 1 || !line1)
          return formatErrorResponse('point_line_distance requires points[0] and line1');
        const [px, py] = points[0];
        const [a, b, c] = line1;
        const d = Math.abs(a * px + b * py + c) / Math.hypot(a, b);
        return formatToolResponse({
          result: formatNumber(d),
          notes: [
            `Point: (${px}, ${py})`,
            `Line: ${a}x + ${b}y + ${c} = 0`,
            `d = |${a}×${px} + ${b}×${py} + ${c}| / √(${a}²+${b}²)`,
          ],
        });
      }

      case 'angle_between_lines': {
        if (!line1 || !line2)
          return formatErrorResponse('angle_between_lines requires line1 and line2 as [a,b,c]');
        const [a1, b1] = line1;
        const [a2, b2] = line2;
        const dot = a1 * a2 + b1 * b2;
        const mag1 = Math.hypot(a1, b1);
        const mag2 = Math.hypot(a2, b2);
        if (mag1 < 1e-12 || mag2 < 1e-12)
          return formatErrorResponse('Degenerate line (zero magnitude)');
        const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
        const angleRad = Math.acos(cosAngle);
        const angleDeg = (angleRad * 180) / Math.PI;
        return formatToolResponse({
          result: `${formatNumber(angleDeg)}°`,
          notes: [
            `Line 1: ${a1}x + ${b1}y + ${line1[2]} = 0`,
            `Line 2: ${a2}x + ${b2}y + ${line2[2]} = 0`,
            `Angle = ${formatNumber(angleDeg)}° = ${formatNumber(angleRad)} rad`,
          ],
        });
      }

      default:
        return formatErrorResponse(`Unknown operation: ${op}`);
    }
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const rounded = Math.round(n * 1e10) / 1e10;
  return String(rounded);
}
