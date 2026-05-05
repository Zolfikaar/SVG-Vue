import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import SvgPath from 'svgpath';
import { svgPathBbox } from 'svg-path-bbox';

/** 2×3 affine matrix: x' = a*x + c*y + e, y' = b*x + d*y + f */
export type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

/** [minX, minY, maxX, maxY] */
export type BBox = [number, number, number, number];

const RAD = Math.PI / 180;

function identity(): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

/** Combined = M1 * M2 (M2 applied to the point first). */
function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f
  };
}

function transformPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

function parseNumber(s: string): number {
  const t = s.trim();
  if (!t) {
    return 0;
  }
  const n = parseFloat(t.replace(/(px|pt|em|ex|rem|cm|mm|in|pc|%)/gi, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseNumbers(args: string): number[] {
  return args
    .replace(/,/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(parseNumber);
}

/** SVG transform list: transforms apply left-to-right; combined = T1 * T2 * … */
function parseTransform(attr: string | null | undefined): Matrix {
  if (!attr?.trim()) {
    return identity();
  }
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let combined = identity();
  let m: RegExpExecArray | null;
  while ((m = re.exec(attr)) !== null) {
    const kind = m[1].toLowerCase();
    const nums = parseNumbers(m[2]);
    let next = identity();
    switch (kind) {
      case 'matrix':
        if (nums.length >= 6) {
          next = { a: nums[0], b: nums[1], c: nums[2], d: nums[3], e: nums[4], f: nums[5] };
        }
        break;
      case 'translate':
        next = { a: 1, b: 0, c: 0, d: 1, e: nums[0] ?? 0, f: nums[1] ?? 0 };
        break;
      case 'scale':
        next = {
          a: nums[0] ?? 1,
          b: 0,
          c: 0,
          d: nums.length >= 2 ? nums[1]! : nums[0] ?? 1,
          e: 0,
          f: 0
        };
        break;
      case 'rotate': {
        const deg = nums[0] ?? 0;
        const rad = deg * RAD;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const cx = nums[1] ?? 0;
        const cy = nums[2] ?? 0;
        if (nums.length >= 3) {
          const t1 = { a: 1, b: 0, c: 0, d: 1, e: cx, f: cy };
          const r = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
          const t2 = { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy };
          next = multiply(multiply(t1, r), t2);
        } else {
          next = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
        }
        break;
      }
      case 'skewx': {
        const t = Math.tan((nums[0] ?? 0) * RAD);
        next = { a: 1, b: 0, c: t, d: 1, e: 0, f: 0 };
        break;
      }
      case 'skewy': {
        const t = Math.tan((nums[0] ?? 0) * RAD);
        next = { a: 1, b: t, c: 0, d: 1, e: 0, f: 0 };
        break;
      }
      default:
        break;
    }
    combined = multiply(combined, next);
  }
  return combined;
}

function unionBBox(a: BBox | null, b: BBox | null): BBox | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function bboxFromPoints(matrix: Matrix, points: [number, number][]): BBox | null {
  if (points.length === 0) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    const [tx, ty] = transformPoint(matrix, x, y);
    minX = Math.min(minX, tx);
    minY = Math.min(minY, ty);
    maxX = Math.max(maxX, tx);
    maxY = Math.max(maxY, ty);
  }
  return [minX, minY, maxX, maxY];
}

function parsePointsAttr(s: string | null): [number, number][] {
  if (!s?.trim()) {
    return [];
  }
  const nums = parseNumbers(s);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    out.push([nums[i]!, nums[i + 1]!]);
  }
  return out;
}

function circleSamplePoints(cx: number, cy: number, r: number, n: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const ang = (2 * Math.PI * i) / n;
    pts.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
  }
  return pts;
}

function ellipseSamplePoints(cx: number, cy: number, rx: number, ry: number, n: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const ang = (2 * Math.PI * i) / n;
    pts.push([cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)]);
  }
  return pts;
}

function elementBBox(el: Element, matrix: Matrix): BBox | null {
  const name = (el.localName || el.tagName || '').toLowerCase();

  switch (name) {
    case 'path': {
      const d = el.getAttribute('d')?.trim();
      if (!d) {
        return null;
      }
      try {
        const d2 = new SvgPath(d)
          .matrix([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f])
          .round(4)
          .toString();
        return svgPathBbox(d2) as BBox;
      } catch {
        return null;
      }
    }
    case 'rect': {
      const x = parseNumber(el.getAttribute('x') ?? '0');
      const y = parseNumber(el.getAttribute('y') ?? '0');
      const w = parseNumber(el.getAttribute('width') ?? '0');
      const h = parseNumber(el.getAttribute('height') ?? '0');
      if (w <= 0 || h <= 0) {
        return null;
      }
      return bboxFromPoints(matrix, [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h]
      ]);
    }
    case 'circle': {
      const cx = parseNumber(el.getAttribute('cx') ?? '0');
      const cy = parseNumber(el.getAttribute('cy') ?? '0');
      const r = parseNumber(el.getAttribute('r') ?? '0');
      if (r <= 0) {
        return null;
      }
      return bboxFromPoints(matrix, circleSamplePoints(cx, cy, r, 48));
    }
    case 'ellipse': {
      const cx = parseNumber(el.getAttribute('cx') ?? '0');
      const cy = parseNumber(el.getAttribute('cy') ?? '0');
      const rx = parseNumber(el.getAttribute('rx') ?? '0');
      const ry = parseNumber(el.getAttribute('ry') ?? '0');
      if (rx <= 0 || ry <= 0) {
        return null;
      }
      return bboxFromPoints(matrix, ellipseSamplePoints(cx, cy, rx, ry, 48));
    }
    case 'line': {
      const x1 = parseNumber(el.getAttribute('x1') ?? '0');
      const y1 = parseNumber(el.getAttribute('y1') ?? '0');
      const x2 = parseNumber(el.getAttribute('x2') ?? '0');
      const y2 = parseNumber(el.getAttribute('y2') ?? '0');
      return bboxFromPoints(matrix, [
        [x1, y1],
        [x2, y2]
      ]);
    }
    case 'polyline':
    case 'polygon': {
      const pts = parsePointsAttr(el.getAttribute('points'));
      if (pts.length === 0) {
        return null;
      }
      return bboxFromPoints(matrix, pts);
    }
    case 'image': {
      const x = parseNumber(el.getAttribute('x') ?? '0');
      const y = parseNumber(el.getAttribute('y') ?? '0');
      const w = parseNumber(el.getAttribute('width') ?? '0');
      const h = parseNumber(el.getAttribute('height') ?? '0');
      if (w <= 0 || h <= 0) {
        return null;
      }
      return bboxFromPoints(matrix, [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h]
      ]);
    }
    default:
      return null;
  }
}

const SKIP_TAGS = new Set([
  'defs',
  'clippath',
  'mask',
  'pattern',
  'filter',
  'lineargradient',
  'radialgradient',
  'stop',
  'style',
  'title',
  'desc',
  'metadata',
  'script',
  'animate',
  'animatetransform',
  'set',
  'symbol'
]);

function walkFixed(el: Element, parentMatrix: Matrix): BBox | null {
  const local = parseTransform(el.getAttribute('transform'));
  const name = (el.localName || el.tagName || '').toLowerCase();

  let matrix = multiply(parentMatrix, local);

  const parent = el.parentNode;
  const isNestedSvg = name === 'svg' && parent && parent.nodeType === 1;

  if (isNestedSvg) {
    const x = parseNumber(el.getAttribute('x') ?? '0');
    const y = parseNumber(el.getAttribute('y') ?? '0');
    matrix = multiply(matrix, { a: 1, b: 0, c: 0, d: 1, e: x, f: y });
  }

  let acc: BBox | null = null;

  if (!SKIP_TAGS.has(name)) {
    acc = unionBBox(acc, elementBBox(el, matrix));
  }

  if (name === 'defs' || name === 'clippath' || name === 'mask' || name === 'symbol') {
    return acc;
  }

  for (let i = 0; i < el.childNodes.length; i++) {
    const ch = el.childNodes[i];
    if (ch?.nodeType === 1) {
      acc = unionBBox(acc, walkFixed(ch as Element, matrix));
    }
  }

  return acc;
}

export function computeContentBBox(svgRoot: Element): BBox | null {
  return walkFixed(svgRoot, identity());
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function bboxToViewBox(b: BBox): string | null {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  return `${round4(b[0])} ${round4(b[1])} ${round4(w)} ${round4(h)}`;
}

export function parseViewBoxFromSvgRoot(svg: Element): string | null {
  const vb = svg.getAttribute('viewBox')?.trim();
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(parseNumber);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      const [x, y, w, h] = parts as [number, number, number, number];
      if (w > 0 && h > 0) {
        return `${round4(x)} ${round4(y)} ${round4(w)} ${round4(h)}`;
      }
    }
  }
  const sw = parseNumber(svg.getAttribute('width') ?? '');
  const sh = parseNumber(svg.getAttribute('height') ?? '');
  if (sw > 0 && sh > 0) {
    return `0 0 ${round4(sw)} ${round4(sh)}`;
  }
  return null;
}

export function optimizeSvg(svg: string): string {
  const optimize = getSvgoOptimize();
  if (!optimize) {
    return svg;
  }

  const result = optimize(svg, {
    multipass: true,
    plugins: ['preset-default']
  });
  return typeof result?.data === 'string' ? result.data : svg;
}

type SvgoOptimize = (input: string, options: { multipass: boolean; plugins: string[] }) => { data: string };
let svgoOptimizeCache: SvgoOptimize | null | undefined;

function getSvgoOptimize(): SvgoOptimize | null {
  if (svgoOptimizeCache !== undefined) {
    return svgoOptimizeCache;
  }

  try {
    const svgo = require('svgo') as { optimize?: SvgoOptimize };
    svgoOptimizeCache = typeof svgo.optimize === 'function' ? svgo.optimize : null;
  } catch {
    svgoOptimizeCache = null;
  }

  return svgoOptimizeCache;
}

const parser = new DOMParser();
const serializer = new XMLSerializer();

export function parseSvgDocument(svgXml: string): Document | null {
  const doc = parser.parseFromString(svgXml, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') {
    return null;
  }
  return doc;
}

export function serializeSvgInnerContent(svgRoot: Element): string {
  let out = '';
  for (let i = 0; i < svgRoot.childNodes.length; i++) {
    out += serializer.serializeToString(svgRoot.childNodes[i]!);
  }
  return out;
}

const BLOCKED_ROOT_ATTRS = new Set([
  'width',
  'height',
  'viewbox',
  'xmlns',
  'xmlns:xlink',
  'fill',
  'version'
]);

export function formatRootAttributes(svgRoot: Element): string {
  if (!svgRoot.attributes?.length) {
    return '';
  }
  const parts: string[] = [];
  for (let i = 0; i < svgRoot.attributes.length; i++) {
    const a = svgRoot.attributes[i]!;
    const n = a.name.toLowerCase();
    if (BLOCKED_ROOT_ATTRS.has(n)) {
      continue;
    }
    const val = a.value.replace(/"/g, '&quot;');
    parts.push(`${a.name}="${val}"`);
  }
  if (parts.length === 0) {
    return '';
  }
  return ' ' + parts.join(' ');
}

export function applyCurrentColorToFills(svgFragment: string): string {
  let s = svgFragment.replace(/\sfill\s*=\s*"[^"]*"/gi, ' fill="currentColor"');
  s = s.replace(/\sfill\s*=\s*'[^']*'/gi, ' fill="currentColor"');
  return s;
}
