import type { SupportDocId } from "../types";

export const SUPPORT_DOCS: { id: SupportDocId; label: string; description: string }[] = [
  {
    id: "comms",
    label: "Comms plan",
    description: "Net, channel, callsigns, authentication, and lost-comms notes.",
  },
  {
    id: "pace",
    label: "PACE plan",
    description: "Primary, alternate, contingency, and emergency contact methods.",
  },
  {
    id: "medevac",
    label: "MEDEVAC card",
    description: "9-line style evacuation reference card for the package.",
  },
  {
    id: "checklist",
    label: "Op checklist",
    description: "Import, imagery, route, comms, medical, and attachment checks.",
  },
];
