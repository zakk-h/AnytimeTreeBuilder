import type { BuildNode } from './types';

export type LayoutNode = BuildNode & {
  x: number;
  y: number;
};

export type LayoutEdge = {
  id: string;
  source: number;
  target: number;
  label: string;
};

const NODE_WIDTH = 420;
const SHALLOW_NODE_Y_GAP = 220;
const HORIZONTAL_NODE_GAP = 44;
const MIN_CENTER_GAP = NODE_WIDTH + HORIZONTAL_NODE_GAP;

type RelativePosition = {
  centerX: number;
  depth: number;
};

type SubtreeLayout = {
  positions: Map<number, RelativePosition>;
  leftContour: number[];
  rightContour: number[];
};

function treeDepth(node: BuildNode): number {
  const leftDepth = node.left ? treeDepth(node.left) + 1 : 0;
  const rightDepth = node.right ? treeDepth(node.right) + 1 : 0;
  return Math.max(leftDepth, rightDepth);
}

function verticalGapFor(root: BuildNode): number {
  const depth = treeDepth(root);

  // Preserve the spacious look for the common shallow case, but keep deep
  // trees from becoming unnecessarily tiny when fit into the viewport.
  if (depth <= 4) return SHALLOW_NODE_Y_GAP;
  if (depth <= 6) return 205;
  if (depth <= 8) return 190;
  return 180;
}

function shiftedContour(contour: number[], dx: number): number[] {
  return contour.map((x) => x + dx);
}

/**
 * Build a compact tidy-tree layout around this node at x = 0.
 *
 * The contours record the leftmost/rightmost occupied node center at every
 * depth. When two child subtrees are combined, we separate only the contour
 * levels that actually overlap. This lets empty space in an asymmetric tree
 * be reused instead of reserving a full rectangular box for every subtree.
 *
 * Because every overlapping contour level is kept at least MIN_CENTER_GAP
 * apart, 420px-wide nodes cannot collide, including across cousin subtrees.
 */
function layoutSubtree(node: BuildNode): SubtreeLayout {
  const left = node.left ? layoutSubtree(node.left) : undefined;
  const right = node.right ? layoutSubtree(node.right) : undefined;

  const positions = new Map<number, RelativePosition>();
  positions.set(node.uid, { centerX: 0, depth: 0 });

  if (!left && !right) {
    return {
      positions,
      leftContour: [0],
      rightContour: [0],
    };
  }

  // A one-child branch is most legible directly below its parent. It also
  // avoids wasting horizontal space on the sparse side of an imperfect tree.
  const onlyChild = left ?? right;
  if (!left || !right) {
    for (const [uid, p] of onlyChild!.positions) {
      positions.set(uid, {
        centerX: p.centerX,
        depth: p.depth + 1,
      });
    }

    return {
      positions,
      leftContour: [0, ...onlyChild!.leftContour],
      rightContour: [0, ...onlyChild!.rightContour],
    };
  }

  // Find the minimum root-to-root separation that keeps the two child
  // contours apart at every depth where both subtrees contain nodes.
  const sharedLevels = Math.min(
    left.rightContour.length,
    right.leftContour.length,
  );

  let childSeparation = MIN_CENTER_GAP;
  for (let d = 0; d < sharedLevels; d += 1) {
    childSeparation = Math.max(
      childSeparation,
      left.rightContour[d] + MIN_CENTER_GAP - right.leftContour[d],
    );
  }

  // Keep the parent exactly between its two immediate children. This gives
  // stable, easy-to-read branch angles while the deeper contours determine
  // how tightly the subtrees can pack.
  const leftShift = -childSeparation / 2;
  const rightShift = childSeparation / 2;

  for (const [uid, p] of left.positions) {
    positions.set(uid, {
      centerX: p.centerX + leftShift,
      depth: p.depth + 1,
    });
  }

  for (const [uid, p] of right.positions) {
    positions.set(uid, {
      centerX: p.centerX + rightShift,
      depth: p.depth + 1,
    });
  }

  const shiftedLeftLeft = shiftedContour(left.leftContour, leftShift);
  const shiftedLeftRight = shiftedContour(left.rightContour, leftShift);
  const shiftedRightLeft = shiftedContour(right.leftContour, rightShift);
  const shiftedRightRight = shiftedContour(right.rightContour, rightShift);

  const leftContour = [0];
  const rightContour = [0];
  const childLevels = Math.max(
    left.leftContour.length,
    right.leftContour.length,
  );

  for (let d = 0; d < childLevels; d += 1) {
    const leftCandidates: number[] = [];
    const rightCandidates: number[] = [];

    if (d < shiftedLeftLeft.length) {
      leftCandidates.push(shiftedLeftLeft[d]);
      rightCandidates.push(shiftedLeftRight[d]);
    }

    if (d < shiftedRightLeft.length) {
      leftCandidates.push(shiftedRightLeft[d]);
      rightCandidates.push(shiftedRightRight[d]);
    }

    leftContour.push(Math.min(...leftCandidates));
    rightContour.push(Math.max(...rightCandidates));
  }

  return {
    positions,
    leftContour,
    rightContour,
  };
}

export function layoutTree(root: BuildNode): {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
} {
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  const layout = layoutSubtree(root);
  const yGap = verticalGapFor(root);

  function collect(node: BuildNode, depth: number): void {
    const p = layout.positions.get(node.uid);
    if (!p) return;

    nodes.push({
      ...node,
      x: p.centerX - NODE_WIDTH / 2,
      y: p.depth * yGap,
    });

    if (node.left) {
      edges.push({
        id: `${node.uid}-${node.left.uid}`,
        source: node.uid,
        target: node.left.uid,
        label: depth === 0 ? 'T' : '',
      });
      collect(node.left, depth + 1);
    }

    if (node.right) {
      edges.push({
        id: `${node.uid}-${node.right.uid}`,
        source: node.uid,
        target: node.right.uid,
        label: depth === 0 ? 'F' : '',
      });
      collect(node.right, depth + 1);
    }
  }

  collect(root, 0);

  // Keep the visible tree centered around x = 0 regardless of how asymmetric
  // its branching structure is. React Flow can then fit the real occupied
  // bounds rather than a large artificial subtree rectangle.
  if (nodes.length > 0) {
    const minX = Math.min(...nodes.map((n) => n.x));
    const maxX = Math.max(...nodes.map((n) => n.x + NODE_WIDTH));
    const midX = 0.5 * (minX + maxX);

    for (const n of nodes) {
      n.x -= midX;
    }
  }

  return { nodes, edges };
}
