// Who a work-session note names: other people by full name, never the person working and never
// a description (they became duplicate person pages in the Ambient team wiki).
import { describe, expect, it } from "vitest";
import { noteNames } from "../src/sessions/service.ts";

describe("noteNames", () => {
  it("keeps other people's full names once", () => {
    expect(noteNames(["Anna Müller", "anna müller", "Klaus", "Petra Schäfer"], "Lena Vogel")).toEqual(["Anna Müller", "Petra Schäfer"]);
  });

  it("leaves out the person working, by full name or by their first-name-only account", () => {
    expect(noteNames(["Nikolai Madlener", "Anna Müller"], "Nikolai Madlener")).toEqual(["Anna Müller"]);
    expect(noteNames(["Nikolai Madlener", "Anna Müller"], "Nikolai")).toEqual(["Anna Müller"]);
  });

  it("leaves out descriptions in a name's place", () => {
    expect(noteNames(["Nikolai (person working/testing on Mac)", "Karina (calendar test attendee)", "the Bergmann team"], null)).toEqual([]);
  });
});
