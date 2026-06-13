import type { ReactElement } from "react";
import { useAppStore } from "../../store/use-app-store";
import { AFFILIATIONS, applyAffiliation } from "../../lib/milsymbol-utils";
import type { ToolType } from "../../types";

/**
 * Floating tool palette over the map. Tool clicks only set store state —
 * MapCanvas's MapController owns the actual draw state machine. Finishing a
 * multi-point draft is delegated to MapCanvas via a window CustomEvent so the
 * completion logic lives in exactly one place.
 */

const icon = (children: ReactElement | ReactElement[]): ReactElement => (
  <svg
    viewBox="0 0 18 18"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const TOOLS: { id: ToolType; label: string; glyph: ReactElement }[] = [
  {
    id: "select",
    label: "Select / edit",
    glyph: icon(<path d="M4 2l9.5 8.5-5.2.9L6 16.5z" fill="currentColor" stroke="none" />),
  },
  {
    id: "marker",
    label: "Marker (milsymbol)",
    glyph: icon([
      <path key="p" d="M9 1C5.7 1 3 3.7 3 7c0 4.5 6 10 6 10s6-5.5 6-10c0-3.3-2.7-6-6-6z" />,
      <circle key="c" cx="9" cy="7" r="2" />,
    ]),
  },
  {
    id: "line",
    label: "Line (KML only)",
    glyph: icon([
      <line key="l" x1="3" y1="15" x2="15" y2="3" />,
      <circle key="a" cx="3" cy="15" r="1.5" fill="currentColor" />,
      <circle key="b" cx="15" cy="3" r="1.5" fill="currentColor" />,
    ]),
  },
  {
    id: "route",
    label: "Route (CoT b-m-r)",
    glyph: icon([
      <path key="p" d="M2 15l5-5 4 3 5-9" />,
      <path key="h" d="M13 4h3v3" />,
    ]),
  },
  {
    id: "polygon",
    label: "Polygon",
    glyph: icon(<polygon points="9,1 16,6 14,15 4,15 2,6" />),
  },
  {
    id: "rectangle",
    label: "Rectangle",
    glyph: icon(<rect x="2" y="4" width="14" height="10" rx="1" />),
  },
  {
    id: "circle",
    label: "Circle (center + radius)",
    glyph: icon(<circle cx="9" cy="9" r="7" />),
  },
  {
    id: "aoi",
    label: "AOI (imagery extent, two clicks)",
    glyph: icon([
      <rect key="r" x="2" y="2" width="14" height="14" strokeDasharray="3 2" />,
      <line key="v" x1="9" y1="6" x2="9" y2="12" />,
      <line key="h" x1="6" y1="9" x2="12" y2="9" />,
    ]),
  },
];

const MULTI_POINT_TOOLS: ToolType[] = ["line", "route", "polygon"];
const TWO_CLICK_TOOLS: ToolType[] = ["rectangle", "circle", "aoi"];

export default function AnnotationToolbar() {
  const tool = useAppStore((s) => s.tool);
  const setTool = useAppStore((s) => s.setTool);
  const draftPoints = useAppStore((s) => s.draftPoints);
  const clearDraft = useAppStore((s) => s.clearDraft);
  const activeAffiliation = useAppStore((s) => s.activeAffiliation);
  const setActiveAffiliation = useAppStore((s) => s.setActiveAffiliation);
  const activeSidc = useAppStore((s) => s.activeSidc);
  const setActiveSidc = useAppStore((s) => s.setActiveSidc);

  const drafting = MULTI_POINT_TOOLS.includes(tool) && draftPoints.length > 0;
  const awaitingSecondClick =
    TWO_CLICK_TOOLS.includes(tool) && draftPoints.length === 1;

  // Mirror MapController's dedupeConsecutive so the Finish button's enabled
  // state matches what finishActiveDraft will actually accept (a stray
  // double-click can leave a duplicate trailing vertex).
  const finishableCount = draftPoints.filter(
    (p, i) =>
      i === 0 ||
      p[0] !== draftPoints[i - 1][0] ||
      p[1] !== draftPoints[i - 1][1],
  ).length;
  const minToFinish = tool === "polygon" ? 3 : 2;

  const finishDraft = () => {
    // MapCanvas listens and runs the same completion path as Enter/double-click.
    window.dispatchEvent(new CustomEvent("takpack:finish-draft"));
  };

  const cancelDraft = () => {
    clearDraft();
    setTool("select");
  };

  return (
    <div className="toolbar-floating">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`tool-btn${tool === t.id ? " active" : ""}`}
          title={t.label}
          aria-label={t.label}
          onClick={() => setTool(t.id)}
        >
          {t.glyph}
        </button>
      ))}

      {tool === "marker" && (
        <div
          className="affiliation-segment"
          style={{ display: "inline-flex", gap: 2, marginLeft: 6 }}
        >
          {AFFILIATIONS.map((a) => {
            const active = activeAffiliation === a.id;
            return (
              <button
                key={a.id}
                type="button"
                className={`tool-btn${active ? " active" : ""}`}
                title={a.id}
                style={{
                  color: a.color,
                  ...(active
                    ? { borderColor: a.color, boxShadow: `0 0 5px ${a.color}66` }
                    : {}),
                }}
                onClick={() => {
                  setActiveAffiliation(a.id);
                  setActiveSidc(applyAffiliation(activeSidc, a.id));
                }}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      )}

      {drafting && (
        <>
          <span className="chip">
            {draftPoints.length}{" "}
            {draftPoints.length === 1 ? "vertex" : "vertices"}
          </span>
          <span className="chip">
            Enter / double-click to finish · Esc to cancel
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={finishDraft}
            disabled={finishableCount < minToFinish}
            title="Finish drawing"
          >
            Finish
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={cancelDraft}
            title="Cancel drawing"
          >
            Cancel
          </button>
        </>
      )}

      {awaitingSecondClick && (
        <span className="chip">
          {tool === "circle"
            ? "Click the edge to set radius · Esc to cancel"
            : "Click the opposite corner · Esc to cancel"}
        </span>
      )}
    </div>
  );
}
