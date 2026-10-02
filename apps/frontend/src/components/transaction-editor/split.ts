import { formatMoney } from "../../lib/format";
import { PersonShare, Transaction } from "../../types";
import { toMinor } from "../PeoplePicker";

/**
 * A split as it is being edited.
 *
 * Who is in it and how it is divided are kept apart from the figures,
 * which are worked out on every render: in "equal" mode the shares follow
 * the amount as it is typed, so nothing goes stale.
 */
export interface SplitDraft {
  /** Off means lent: none of it was mine. */
  includeMe: boolean;
  mode: "equal" | "custom";
  /** In custom mode, what each owes. In equal mode the amounts are ignored. */
  people: PersonShare[];
  groupLabel: string;
  /** My share typed directly - only used while nobody is picked yet, so a
      split can be recorded before deciding who the rest is owed by. */
  shareWithoutPeople: string;
  /** Owed by people never named: rows saved before every rupee had to be
      on someone. Kept until removed so opening one does not change it. */
  unnamedMinor: number;
}

export interface SplitResult {
  people: PersonShare[];
  myShareMinor: number;
  /** total - my share: what is owed back (or, on a credit, coming back). */
  othersMinor: number;
  /** Not on anyone yet, with me left out. */
  leftoverMinor: number;
  error: string | null;
}

export function computeSplit(draft: SplitDraft, totalMinor: number): SplitResult {
  const total = Math.max(0, totalMinor);

  if (draft.people.length === 0) {
    if (!draft.includeMe) {
      return { people: [], myShareMinor: 0, othersMinor: total, leftoverMinor: total, error: null };
    }
    const typed = draft.shareWithoutPeople.trim() ? toMinor(draft.shareWithoutPeople) : total;
    return {
      people: [],
      myShareMinor: Math.min(typed, total),
      othersMinor: Math.max(0, total - typed),
      leftoverMinor: 0,
      error: typed > total ? `Your share is more than the ${formatMoney(total)} total.` : null,
    };
  }

  if (draft.mode === "equal") {
    const heads = draft.people.length + (draft.includeMe ? 1 : 0);
    const each = Math.floor(total / heads);
    const amounts = draft.people.map(() => each);
    let mine = 0;
    // Odd paise go to me when I am in it, else to the first person, so the
    // shares always add up to exactly the total.
    if (draft.includeMe) mine = total - each * draft.people.length;
    else amounts[0] += total - each * heads;
    return {
      people: draft.people.map((person, index) => ({ contactId: person.contactId, amountMinor: amounts[index] })),
      myShareMinor: mine,
      othersMinor: total - mine,
      leftoverMinor: 0,
      error: null,
    };
  }

  const assigned = draft.people.reduce((sum, person) => sum + person.amountMinor, 0) + draft.unnamedMinor;
  if (draft.includeMe) {
    const mine = total - assigned;
    return {
      people: draft.people,
      myShareMinor: Math.max(0, mine),
      othersMinor: Math.min(total, assigned),
      leftoverMinor: 0,
      error: mine < 0 ? `That's ${formatMoney(-mine)} more than the ${formatMoney(total)} total.` : null,
    };
  }
  const left = total - assigned;
  return {
    people: draft.people,
    myShareMinor: 0,
    othersMinor: total,
    leftoverMinor: Math.max(0, left),
    error: left < 0 ? `That's ${formatMoney(-left)} more than the ${formatMoney(total)} total.` : null,
  };
}

/** Reads a saved split back into something editable, without changing it. */
export function initialSplitDraft(transaction: Transaction | null): SplitDraft {
  const split = transaction?.split ?? null;
  // A settling-up has people too, but they are not a split's.
  const people = split ? transaction?.people ?? [] : [];
  const total = transaction?.amountMinor ?? 0;
  const base: SplitDraft = {
    includeMe: split ? split.myShareMinor > 0 : true,
    mode: "equal",
    people,
    groupLabel: split?.groupLabel ?? "",
    shareWithoutPeople: split && people.length === 0 && split.myShareMinor > 0 ? (split.myShareMinor / 100).toFixed(2) : "",
    unnamedMinor: 0,
  };
  if (!split || people.length === 0) return base;

  const sum = people.reduce((s, p) => s + p.amountMinor, 0);
  const unnamed = Math.max(0, total - split.myShareMinor - sum);
  if (unnamed === 0) {
    // Equal if equal reproduces exactly what was saved; otherwise the
    // amounts were typed and stay as typed.
    const equal = computeSplit(base, total);
    const same =
      equal.myShareMinor === split.myShareMinor &&
      equal.people.every((person, index) => person.amountMinor === people[index].amountMinor);
    if (same) return base;
  }
  return { ...base, mode: "custom", unnamedMinor: unnamed };
}
