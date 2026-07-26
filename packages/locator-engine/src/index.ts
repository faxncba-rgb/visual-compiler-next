import type {
  LocatorCandidate,
  SemanticStep,
} from "@visual-compiler/semantic-ir";
import type { PageModel, PageNode } from "@visual-compiler/page-model";
import { candidateRoleNodes, findTextNodes } from "@visual-compiler/page-model";
import { filterByRelation, readingOrder } from "@visual-compiler/spatial";

export type ResolvedCandidate = LocatorCandidate & { node?: PageNode };

const strategyWeight: Record<LocatorCandidate["strategy"], number> = {
  "role-name": 1,
  "label-association": 0.96,
  "text-dom-relation": 0.92,
  "semantic-row-column": 0.88,
  "test-attribute": 0.78,
  "relative-dom": 0.74,
  "spatial-bounds": 0.68,
  "ocr-anchor": 0.45,
  "image-template": 0.4,
  "absolute-coordinate": 0.1,
};

function normalized(value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function escapeSelectorText(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function defaultRole(step: SemanticStep) {
  if (step.action === "check" || step.action === "uncheck") return "checkbox";
  if (step.action === "fill") return "textbox";
  if (step.action === "select") return "combobox";
  if (step.action === "click") return "button";
  return step.target.role ?? "button";
}

function ancestorChain(model: PageModel, node: PageNode) {
  const byId = new Map(model.nodes.map((candidate) => [candidate.id, candidate]));
  const chain: string[] = [];
  let currentId = node.parentId;
  while (currentId && chain.length < 24) {
    chain.push(currentId);
    currentId = byId.get(currentId)?.parentId;
  }
  return chain;
}

function domDistance(model: PageModel, anchor: PageNode, candidate: PageNode) {
  const anchorAncestors = ancestorChain(model, anchor);
  const candidateAncestors = ancestorChain(model, candidate);
  const shared = anchorAncestors.findIndex((id) =>
    candidateAncestors.includes(id),
  );
  if (shared < 0) return Number.POSITIVE_INFINITY;
  return shared + candidateAncestors.indexOf(anchorAncestors[shared]) + 2;
}

function candidate(
  strategy: LocatorCandidate["strategy"],
  selector: string,
  confidence: number,
  unique: boolean,
  stability: number,
  explanation: string,
  fallbackOrder: number,
  node: PageNode,
): ResolvedCandidate {
  return {
    strategy,
    selector,
    confidence,
    unique,
    stability,
    explanation,
    fallbackOrder,
    node,
  };
}

export function rankCandidates<T extends LocatorCandidate>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => {
    const scoreA =
      a.confidence * 0.45 +
      a.stability * 0.35 +
      (a.unique ? 0.2 : 0) +
      strategyWeight[a.strategy] * 0.1;
    const scoreB =
      b.confidence * 0.45 +
      b.stability * 0.35 +
      (b.unique ? 0.2 : 0) +
      strategyWeight[b.strategy] * 0.1;
    return (
      scoreB - scoreA ||
      a.fallbackOrder - b.fallbackOrder ||
      a.selector.localeCompare(b.selector)
    );
  });
}

export function generateCandidates(
  model: PageModel,
  step: SemanticStep,
): ResolvedCandidate[] {
  const relation = step.target.relations[0];
  const role = step.target.role ?? defaultRole(step);
  const roleNodes = candidateRoleNodes(model, role);
  const clickableFallbackNodes =
    step.action === "click"
      ? model.nodes.filter(
          (node) =>
            node.visible &&
            node.enabled &&
            node.hasClickHandler === true &&
            Boolean(node.controlText || node.accessibleName),
        )
      : [];
  const nodes = [...roleNodes, ...clickableFallbackNodes]
    .filter(
      (node, index, all) =>
        all.findIndex((candidate) => candidate.id === node.id) === index,
    )
    .filter((node) => {
    if (step.target.state === "enabled") return node.enabled;
    if (step.target.state === "disabled") return !node.enabled;
    if (step.target.state === "checked") return node.checked === true;
    if (step.target.state === "unchecked") return node.checked !== true;
    return true;
    });
  const targetName = normalized(step.target.accessibleName);
  const results: ResolvedCandidate[] = [];
  let fallbackOrder = 0;

  if (targetName) {
    const roleNameMatches = nodes.filter(
      (node) =>
        node.role === role && normalized(node.accessibleName) === targetName,
    );
    for (const node of roleNameMatches) {
      results.push(
        candidate(
          "role-name",
          `role=${role}[name="${escapeSelectorText(step.target.accessibleName!)}"]`,
          roleNameMatches.length === 1 ? 0.98 : 0.76,
          roleNameMatches.length === 1,
          0.97,
          "Accessible role and computed accessible name.",
          fallbackOrder++,
          node,
        ),
      );
    }

    const labelMatches = nodes.filter(
      (node) =>
        normalized(node.labelText) === targetName ||
        normalized(node.ariaLabel) === targetName ||
        normalized(node.ariaLabelledByText) === targetName,
    );
    for (const node of labelMatches) {
      results.push(
        candidate(
          "label-association",
          `label="${escapeSelectorText(step.target.accessibleName!)}"`,
          labelMatches.length === 1 ? 0.96 : 0.73,
          labelMatches.length === 1,
          0.95,
          "Associated label, aria-label, or resolved aria-labelledby.",
          fallbackOrder++,
          node,
        ),
      );
    }

    const placeholderMatches = nodes.filter(
      (node) => normalized(node.placeholder) === targetName,
    );
    for (const node of placeholderMatches) {
      results.push(
        candidate(
          "label-association",
          `${node.controlType ?? role}[placeholder="${escapeSelectorText(node.placeholder!)}"]`,
          placeholderMatches.length === 1 ? 0.9 : 0.7,
          placeholderMatches.length === 1,
          0.86,
          "Generic placeholder combined with control type.",
          fallbackOrder++,
          node,
        ),
      );
    }

    const controlTextMatches = nodes.filter(
      (node) => normalized(node.controlText) === targetName,
    );
    for (const node of controlTextMatches) {
      results.push(
        candidate(
          "role-name",
          `${node.tagName}:text-is("${escapeSelectorText(node.controlText!)}")`,
          controlTextMatches.length === 1 ? 0.93 : 0.75,
          controlTextMatches.length === 1,
          0.9,
          "Visible button, link, or option text.",
          fallbackOrder++,
          node,
        ),
      );
    }
  }

  if (relation?.anchorText) {
    const anchors = findTextNodes(model, relation.anchorText);
    const eligibleNodes = targetName
      ? nodes.filter(
          (node) =>
            normalized(node.accessibleName) === targetName ||
            normalized(node.labelText) === targetName ||
            normalized(node.controlText) === targetName ||
            normalized(node.placeholder) === targetName,
        )
      : nodes;
    const rawDomMatches = anchors
      .flatMap((anchor) =>
        eligibleNodes.map((node) => ({
          anchor,
          node,
          distance: domDistance(model, anchor, node),
        })),
      )
      .filter((match) => Number.isFinite(match.distance))
      .sort(
        (a, b) =>
          a.distance - b.distance ||
          (a.node.visualOrder ?? a.node.domOrder ?? 0) -
            (b.node.visualOrder ?? b.node.domOrder ?? 0),
      );
    const domMatches = rawDomMatches.filter(
      (match, index, matches) =>
        matches.findIndex((candidate) => candidate.node.id === match.node.id) ===
        index,
    );
    const bestDomDistance = domMatches[0]?.distance;
    const bestDomMatches = domMatches.filter(
      (match) => match.distance === bestDomDistance,
    );
    for (const match of bestDomMatches) {
      results.push(
        candidate(
          "text-dom-relation",
          `${role} near-dom "${escapeSelectorText(relation.anchorText)}"`,
          bestDomMatches.length === 1 ? 0.92 : 0.72,
          bestDomMatches.length === 1,
          0.88,
          "Control is in the nearest shared DOM container to the interface anchor.",
          fallbackOrder++,
          match.node,
        ),
      );
    }

    const normalizedRelation =
      relation.relation === "next-to" ||
      relation.relation === "first" ||
      relation.relation === "second"
        ? "nearest"
        : relation.relation;
    const anchorMatch = readingOrder(anchors)
      .map((anchor) => ({
        anchor,
        related: filterByRelation(
          anchor.box,
          eligibleNodes,
          normalizedRelation,
          {
            rowTolerance: relation.tolerancePx,
          },
        ).filter((node) => node.enabled || step.target.state !== "enabled"),
      }))
      .find(({ related }) => related.length > 0);
    if (anchorMatch) {
      const ordered =
        relation.relation === "right-of"
          ? [...anchorMatch.related].sort((a, b) => a.box.x - b.box.x)
          : readingOrder(anchorMatch.related);
      for (const [index, node] of ordered.entries()) {
        results.push(
          candidate(
            relation.relation === "same-row" ||
              relation.relation === "same-column"
              ? "semantic-row-column"
              : "spatial-bounds",
            `${role} ${relation.relation} "${escapeSelectorText(relation.anchorText)}" nth=${index + 1}`,
            index === 0 ? 0.86 : 0.74,
            true,
            0.82,
            `Deterministic spatial relation: ${role} ${relation.relation} interface anchor.`,
            fallbackOrder++,
            node,
          ),
        );
      }
    }
  }

  const orderedNodes = [...nodes].sort(
    (a, b) =>
      (a.visualOrder ?? a.domOrder ?? 0) -
      (b.visualOrder ?? b.domOrder ?? 0),
  );
  for (const [index, node] of orderedNodes.entries()) {
    if (node.role === role) {
      const roleIndex = orderedNodes
        .filter((candidate) => candidate.role === role)
        .findIndex((candidate) => candidate.id === node.id);
      results.push(
        candidate(
          "relative-dom",
          `role=${role} >> nth=${roleIndex}`,
          0.68,
          true,
          0.66,
          "Deterministic role ordinal in visual order.",
          fallbackOrder++,
          node,
        ),
      );
    }
    results.push(
      candidate(
        "relative-dom",
        `${node.controlType ?? node.tagName} >> nth=${index}`,
        0.63,
        true,
        0.58,
        "Deterministic control-type fallback in visual order.",
        fallbackOrder++,
        node,
      ),
    );
  }

  const deduplicated = results.filter(
    (result, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.selector === result.selector &&
          candidate.node?.id === result.node?.id,
      ) === index,
  );
  return rankCandidates(deduplicated) as ResolvedCandidate[];
}

export function explainZeroCandidates(
  model: PageModel,
  step: SemanticStep,
) {
  const role = step.target.role ?? defaultRole(step);
  const visibleRoleMatches = candidateRoleNodes(model, role);
  const enabledRoleMatches = visibleRoleMatches.filter((node) => node.enabled);
  const namedRoleMatches = step.target.accessibleName
    ? visibleRoleMatches.filter(
        (node) =>
          normalized(node.accessibleName) ===
            normalized(step.target.accessibleName) ||
          normalized(node.labelText) === normalized(step.target.accessibleName) ||
          normalized(node.placeholder) ===
            normalized(step.target.accessibleName) ||
          normalized(node.controlText) ===
            normalized(step.target.accessibleName),
      )
    : visibleRoleMatches;
  return [
    `No locator candidates for step ${step.id}.`,
    `Requested role: ${role}.`,
    `Visible role matches: ${visibleRoleMatches.length}.`,
    `Enabled role matches: ${enabledRoleMatches.length}.`,
    `Semantic-name matches: ${namedRoleMatches.length}.`,
    `DOM/visual relation supplied: ${step.target.relations.length > 0}.`,
  ].join(" ");
}

export function selectBestCandidate(
  candidates: ResolvedCandidate[],
  threshold = 0.62,
): ResolvedCandidate {
  const ranked = rankCandidates(candidates);
  const best = ranked[0];
  if (!best) throw new Error("No locator candidates were generated.");
  if (!best.unique) throw new Error("The top locator candidate is not unique.");
  if (best.confidence < threshold)
    throw new Error(
      `Locator confidence ${best.confidence} is below threshold ${threshold}.`,
    );
  if (best.strategy === "absolute-coordinate")
    throw new Error(
      "Compilation rejected: only absolute coordinates were available.",
    );
  return best;
}
