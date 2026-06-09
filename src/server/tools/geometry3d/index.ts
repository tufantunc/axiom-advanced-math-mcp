// src/server/tools/geometry3d/index.ts
import { formatErrorResponse } from '../response-formatter.js';
import { vectorHandler } from './vectors.js';
import { planeHandler } from './planes.js';
import { volumeHandler } from './volumes.js';

const VECTOR_OPS = new Set(['distance3d', 'midpoint3d', 'dot', 'cross', 'vector_norm', 'angle_vectors']);
const PLANE_OPS = new Set([
  'plane_from_points',
  'point_plane_distance',
  'line_plane_intersection',
  'plane_plane_angle',
  'line_line_distance',
]);
const VOLUME_OPS = new Set(['volume_tetrahedron', 'volume_sphere', 'volume_parallelepiped']);

export async function geometry3dHandler(args: Record<string, unknown>) {
  const op = args.operation as string;
  if (VECTOR_OPS.has(op)) return vectorHandler(args);
  if (PLANE_OPS.has(op)) return planeHandler(args);
  if (VOLUME_OPS.has(op)) return volumeHandler(args);
  return formatErrorResponse(`Unknown geometry3d operation: ${op}`);
}
