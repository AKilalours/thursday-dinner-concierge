// Sentences real people reported from the app's "Report it" link, each with the outcome they expected.
// Written by `npm run users:import` (one row per GitHub issue labelled real-user); merged into the real-user sweep,
// so every report is checked on every commit and by Agent Watch. Edit by hand only to fix a label.
import type { UserRow } from "./user-requests.ts";

export const REPORTED: (UserRow & { 3?: number })[] = [
  // rows below this line are generated
];
