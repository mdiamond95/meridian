import { goToNode, nodeLabel } from '../splitter/controller';
import { childrenOf, pathTo } from '../splitter/tree';
import { useSplitStore } from '../state/splitStore';

/**
 * Nesting (plan Phase 6 §2): where the split on screen sits in its tree — the path from the root, and
 * the splits already made of its regions — each a button that shows that split.
 */
export function NestBreadcrumb() {
  const nest = useSplitStore((s) => s.nest);
  const nodeId = useSplitStore((s) => s.nodeId);
  if (!nodeId || !nest[nodeId] || Object.keys(nest).length < 2) return null;
  const path = pathTo(nest, nodeId);
  const below = childrenOf(nest, nodeId);
  return (
    <nav aria-label="Nested splits" data-testid="nest-breadcrumb">
      <ol className="breadcrumb">
        {path.map((node) => (
          <li key={node.id}>
            {node.id === nodeId ? (
              <strong aria-current="page">{nodeLabel(nest, node)}</strong>
            ) : (
              <button className="link-button" onClick={() => goToNode(node.id)}>
                {nodeLabel(nest, node)}
              </button>
            )}
          </li>
        ))}
      </ol>
      {below.length > 0 && (
        <p className="hint">
          Split further:{' '}
          {below.map((child, i) => (
            <span key={child.id}>
              {i > 0 && ' · '}
              <button className="link-button" onClick={() => goToNode(child.id)}>
                {nodeLabel(nest, child)}
              </button>
            </span>
          ))}
        </p>
      )}
    </nav>
  );
}
