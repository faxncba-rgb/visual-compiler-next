import type { Frame, Page } from "playwright";
import type { Box } from "@visual-compiler/spatial";

export type PageNode = {
  id: string;
  tagName: string;
  role?: string;
  controlType?: string;
  accessibleName?: string;
  labelText?: string;
  ariaLabel?: string;
  ariaLabelledByText?: string;
  placeholder?: string;
  controlText?: string;
  hasClickHandler?: boolean;
  frame?: {
    name?: string;
    title?: string;
    pathname: string;
    index?: number;
  };
  structuralHeading?: string;
  text: string;
  box: Box;
  visible: boolean;
  enabled: boolean;
  checked?: boolean;
  valueWasPresent?: boolean;
  color?: "green" | "red" | "neutral" | "warning";
  attributes: Record<string, string>;
  parentId?: string;
  previousSiblingId?: string;
  nextSiblingId?: string;
  domOrder?: number;
  visualOrder?: number;
};

export type PageModel = {
  url: string;
  viewport: { width: number; height: number };
  nodes: PageNode[];
  capturedAt: string;
};

export async function extractPageModel(page: Page | Frame): Promise<PageModel> {
  const viewport =
    "viewportSize" in page
      ? (page.viewportSize() ?? { width: 1280, height: 720 })
      : (page.page().viewportSize() ?? { width: 1280, height: 720 });
  // Keep this evaluator as a string. TS-on-the-fly loaders can inject helper
  // references into serialized functions that do not exist in the browser.
  const nodes = await page.evaluate<PageNode[]>(String.raw`(() => {
    const normalize = (value, maxLength = 160) =>
      (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
    const textWithoutControlValues = (el, maxLength = 160) => {
      if (!el) return "";
      const clone = el.cloneNode(true);
      clone
        .querySelectorAll?.("input,textarea,select,option,[contenteditable=true]")
        .forEach((control) => control.remove());
      return normalize(clone.textContent, maxLength);
    };
    const roleFor = (el) => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = el.type;
        if (type === "checkbox") return "checkbox";
        if (
          type === "text" ||
          type === "email" ||
          type === "search" ||
          type === "tel" ||
          type === "url" ||
          type === "password"
        )
          return "textbox";
      }
      if (tag === "select") return "combobox";
      if (tag === "option") return "option";
      if (
        tag === "a" &&
        (el.hasAttribute("href") || el.getAttribute("role") === "link")
      )
        return "link";
      if (/^h[1-6]$/.test(tag)) return "heading";
      if (tag === "tr") return "row";
      if (tag === "td" || tag === "th") return "cell";
      if (tag === "table") return "table";
      return undefined;
    };
    const labelsFor = (el) => {
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        const explicitLabels = Array.from(el.labels ?? [])
          .map((label) => textWithoutControlValues(label))
          .filter(Boolean);
        if (explicitLabels.length > 0) return normalize(explicitLabels.join(" "));
        const wrappingLabel = textWithoutControlValues(el.closest("label"));
        if (wrappingLabel) return wrappingLabel;
      }
      return undefined;
    };
    const labelledByFor = (el) => {
      const ids = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean);
      const resolved = ids
        .map((id) => textWithoutControlValues(document.getElementById(id)))
        .filter(Boolean);
      return resolved.length > 0 ? normalize(resolved.join(" ")) : undefined;
    };
    const controlTextFor = (el) => {
      const tag = el.tagName.toLowerCase();
      if (
        ["button", "a", "option"].includes(tag) ||
        ["button", "link", "tab", "menuitem"].includes(
          el.getAttribute("role") ?? "",
        )
      ) {
        return normalize(el.textContent);
      }
      return undefined;
    };
    const headingFor = (el) => {
      const container = el.closest(
        "section,form,fieldset,article,dialog,table",
      );
      const localHeading = container?.querySelector(
        ":scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6,:scope > legend,:scope > caption",
      );
      if (localHeading && localHeading !== el) {
        const value = normalize(localHeading.textContent, 120);
        if (value) return value;
      }
      let previous = el.previousElementSibling;
      while (previous) {
        if (/^H[1-6]$/.test(previous.tagName)) {
          const value = normalize(previous.textContent, 120);
          if (value) return value;
        }
        previous = previous.previousElementSibling;
      }
      return undefined;
    };
    const interfaceTextFor = (el) => {
      const tag = el.tagName.toLowerCase();
      if (
        ["label", "legend", "caption", "th"].includes(tag) ||
        /^h[1-6]$/.test(tag)
      ) {
        return normalize(el.textContent);
      }
      return controlTextFor(el) ?? "";
    };
    const nameFor = (el, role) => {
      const aria = normalize(el.getAttribute("aria-label"));
      if (aria) return aria;
      const labelledBy = labelledByFor(el);
      if (labelledBy) return labelledBy;
      const label = labelsFor(el);
      if (label) return label;
      const controlText = controlTextFor(el);
      if (controlText) return controlText;
      const placeholder = normalize(el.getAttribute("placeholder"));
      if (placeholder && ["textbox", "searchbox", "combobox"].includes(role ?? ""))
        return placeholder;
      return undefined;
    };
    const isEnabled = (el) =>
      !(
        el instanceof HTMLButtonElement ||
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ) || !el.disabled;
    const all = Array.from(document.querySelectorAll("body *"));
    const nodeIds = new Map(all.map((el, index) => [el, "n" + (index + 1)]));
    const captured = all
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none";
        if (!visible) return null;
        if (el instanceof HTMLInputElement && el.type === "hidden") return null;
        const role = roleFor(el);
        const attrs = {};
        for (const attr of Array.from(el.attributes)) {
          if (
            [
              "type",
              "aria-label",
              "aria-labelledby",
              "placeholder",
              "required",
              "data-vc-stable-label",
            ].includes(attr.name)
          ) {
            attrs[attr.name] = normalize(attr.value);
          }
        }
        const labelText = labelsFor(el);
        const ariaLabel = normalize(el.getAttribute("aria-label")) || undefined;
        const ariaLabelledByText = labelledByFor(el);
        const placeholder =
          normalize(el.getAttribute("placeholder")) || undefined;
        const controlText = controlTextFor(el);
        const node = {
          id: "n" + (index + 1),
          tagName: el.tagName.toLowerCase(),
          role,
          controlType:
            el instanceof HTMLInputElement
              ? el.type
              : el.tagName.toLowerCase(),
          accessibleName: nameFor(el, role),
          labelText,
          ariaLabel,
          ariaLabelledByText,
          placeholder,
          controlText,
          hasClickHandler:
            el.hasAttribute("onclick") ||
            typeof el.onclick === "function" ||
            el.getAttribute("role") === "button",
          structuralHeading: headingFor(el),
          text: interfaceTextFor(el),
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible,
          enabled: isEnabled(el),
          checked:
            el instanceof HTMLInputElement && el.type === "checkbox"
              ? el.checked
              : undefined,
          valueWasPresent:
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLSelectElement
              ? String(el.value ?? "").length > 0
              : el.getAttribute("contenteditable") === "true"
                ? normalize(el.textContent).length > 0
                : undefined,
          color: el.getAttribute("data-icon-color") ?? undefined,
          attributes: attrs,
          parentId: el.parentElement
            ? nodeIds.get(el.parentElement)
            : undefined,
          previousSiblingId: el.previousElementSibling
            ? nodeIds.get(el.previousElementSibling)
            : undefined,
          nextSiblingId: el.nextElementSibling
            ? nodeIds.get(el.nextElementSibling)
            : undefined,
          domOrder: index,
          visualOrder: 0,
        };
        return node;
      })
      .filter(Boolean);
    const visual = [...captured].sort(
      (a, b) =>
        a.box.y - b.box.y ||
        a.box.x - b.box.x ||
        a.domOrder - b.domOrder,
    );
    visual.forEach((node, visualOrder) => {
      node.visualOrder = visualOrder;
    });
    return captured;
  })()`);
  return {
    url: page.url(),
    viewport,
    nodes,
    capturedAt: new Date().toISOString(),
  };
}

export const findTextNodes = (model: PageModel, text: string) =>
  model.nodes.filter(
    (node) =>
      node.visible && (node.text === text || node.accessibleName === text),
  );

export const candidateRoleNodes = (model: PageModel, role: string) =>
  model.nodes.filter((node) => node.visible && node.role === role);
