import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatMoney } from "../lib/format";
import {
  Account,
  CardStatus,
  Category,
  Contact,
  ContactList,
  FixedCommitment,
  Loan,
  MerchantPreset,
  PEOPLE_CATEGORY_NAME,
  PersonShare,
  Transaction,
  TransactionType,
  accountLabel,
  categoriesFor,
} from "../types";
import { Icon } from "./Icon";
import { creditWarning } from "./CardStrip";
import { RawMessageModal } from "./RawMessageModal";
import { AccountSelect, fromPickerValue, pickerValueName, toPickerValue } from "./transaction-editor/AccountSelect";
import { Kind, initialKind, kindAfterTypeChange, kindsFor, looksRaw } from "./transaction-editor/kinds";
import { MerchantField } from "./transaction-editor/MerchantField";
import { SettlePanel } from "./transaction-editor/SettlePanel";
import { SplitPanel } from "./transaction-editor/SplitPanel";
import { SplitDraft, computeSplit, initialSplitDraft } from "./transaction-editor/split";
import "../styles/edit-transaction.css";

/**
 * The date and time pickers work in IST, not the browser's timezone.
 *
 * Typing "11 Sep, 7:21pm" has to mean that in India however the laptop is
 * set, or editing a transaction abroad would silently move it.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Splits an ISO instant into the two values the date/time inputs want. */
function toIstParts(iso: string): { date: string; time: string } {
  const shifted = new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

function fromIstParts(date: string, time: string): string {
  return new Date(`${date}T${time}:00.000+05:30`).toISOString();
}

/** The system category transfers between own accounts are filed under. */
const TRANSFERS_CATEGORY_NAME = "Transfers";

/** Kinds a one-off / keep-out-of-savings flag means something on. */
const SPECIAL_KINDS: Record<TransactionType, Kind[]> = {
  DEBIT: ["normal", "split", "loan"],
  CREDIT: ["normal", "split"],
};
/** Kinds a payment can also be a fixed monthly cost on - rent split with a flatmate, say. */
const FIXED_KINDS: Kind[] = ["normal", "split", "loan"];

/**
 * Full manual edit. Parsing gets most of a message right but not all of it,
 * and a wrong amount or direction is worse than none — so every field a
 * person might need to correct is editable here, including creating a
 * transaction that no message ever produced (cash).
 *
 * Laid out as the basics on the left (amount, who, when, which account)
 * and "what kind of transaction is this?" on the right, where only the
 * chosen kind's own questions are asked.
 */
export function EditTransactionModal({
  transaction,
  categories,
  accounts,
  onSaved,
  onDeleted,
  onClose,
  onConvertToEmi,
  onMarkRefund,
}: {
  /** null means "create a new one". */
  transaction: Transaction | null;
  categories: Category[];
  accounts: Account[];
  onSaved: (saved: Transaction) => void;
  onDeleted?: (id: string) => void;
  onClose: () => void;
  /** Opens the EMI form for this purchase. */
  onConvertToEmi?: (transaction: Transaction) => void;
  /** Opens the refund picker for this credit (also links an earmark's purchases). */
  onMarkRefund?: (transaction: Transaction) => void;
}) {
  const isNew = transaction === null;
  const initial = transaction ? toIstParts(transaction.occurredAt) : toIstParts(new Date().toISOString());
  const cashAccount =
    accounts.find((account) => account.accountType === "CASH" && account.isActive) ??
    accounts.find((account) => account.accountType === "CASH");
  // Named apart from `cards`, which is the card *statuses* the limit
  // warning reads, not the accounts a bill can be paid against.
  const cardAccounts = accounts.filter(
    (account) => account.accountType === "CARD" && (account.isActive || account.id === transaction?.cardPaymentFor)
  );

  const [amount, setAmount] = useState(transaction ? (transaction.amountMinor / 100).toFixed(2) : "");
  const [type, setType] = useState<TransactionType>(transaction?.type ?? "DEBIT");
  const [kind, setKind] = useState<Kind>(() => initialKind(transaction));
  const [merchant, setMerchant] = useState(transaction?.merchant ?? "");
  // Whether the merchant was typed (or picked) in this edit: a transfer
  // may rename a bank's UPI handle, never something a person wrote.
  const [merchantTouched, setMerchantTouched] = useState(false);
  const [autoMerchant, setAutoMerchant] = useState<string | null>(null);
  const [note, setNote] = useState(transaction?.note ?? "");
  const [categoryId, setCategoryId] = useState(transaction?.category?.id ?? "");
  const [account, setAccount] = useState(toPickerValue(transaction?.account?.id, cashAccount));
  const [otherAccount, setOtherAccount] = useState(
    transaction?.transferAccountId ? toPickerValue(transaction.transferAccountId, cashAccount) : ""
  );
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);

  const [isSpecial, setIsSpecial] = useState(transaction?.isSpecial ?? false);
  const [cardPaymentFor, setCardPaymentFor] = useState(transaction?.cardPaymentFor ?? "");
  const [fixedOn, setFixedOn] = useState(!!transaction?.commitmentId);
  const [commitmentId, setCommitmentId] = useState(transaction?.commitmentId ?? "");
  const [loanId, setLoanId] = useState(transaction?.loanId ?? "");
  const [splitDraft, setSplitDraft] = useState<SplitDraft>(() => initialSplitDraft(transaction));
  const [settlePeople, setSettlePeople] = useState<PersonShare[]>(
    transaction?.isSettlement ? transaction.people ?? [] : []
  );
  // On a trip, an expense is everyone's unless it says otherwise. The only
  // narrowing worth a control is "this one was just mine".
  const [tripJustMine, setTripJustMine] = useState((transaction?.tripShareWith?.length ?? 0) > 0);

  const [commitments, setCommitments] = useState<FixedCommitment[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [presets, setPresets] = useState<MerchantPreset[]>([]);
  const [cards, setCards] = useState<CardStatus[]>([]);
  const [contacts, setContacts] = useState<Contact[] | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  // More than one message means this row was merged, whether automatically
  // or by hand — and either can be wrong, so both can be taken apart.
  const mergedCount = transaction?.sources.length ?? 0;

  const totalMinor = Math.max(0, Math.round(Number.parseFloat(amount || "0") * 100) || 0);
  const splitResult = computeSplit(splitDraft, totalMinor);
  const isSplitKind = kind === "split" || kind === "lent";
  const specialApplies = SPECIAL_KINDS[type].includes(kind);
  const fixedApplies = type === "DEBIT" && FIXED_KINDS.includes(kind);

  const peopleCategoryId = categories.find((category) => category.name === PEOPLE_CATEGORY_NAME)?.id ?? null;
  const transfersCategoryId =
    categories.find((category) => category.isSystem && category.name === TRANSFERS_CATEGORY_NAME)?.id ??
    categories.find((category) => category.name === TRANSFERS_CATEGORY_NAME)?.id ??
    null;

  // Escape closes (unless the original message is open on top, which
  // closes itself); Ctrl/Cmd+Enter saves from anywhere. Plain Enter does
  // nothing, so finishing the amount never files a half-done form.
  const saveRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (rawOpen) return;
      if (event.key === "Escape") onClose();
      else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        saveRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, rawOpen]);

  useEffect(() => {
    api
      .get<MerchantPreset[]>("/merchant-presets")
      .then(setPresets)
      .catch(() => setPresets([]));
    api
      .get<CardStatus[]>("/cards")
      .then(setCards)
      .catch(() => setCards([]));
    api
      .get<FixedCommitment[]>("/budget/commitments")
      .then(setCommitments)
      .catch(() => setCommitments([]));
    api
      .get<Loan[]>("/loans")
      // Active ones to pick from, plus whichever this payment already
      // claims - a closed loan should not vanish from its own dropdown.
      .then((all) =>
        setLoans(all.filter((loan) => loan.status === "ACTIVE" || loan.id === transaction?.loanId))
      )
      .catch(() => setLoans([]));
    api
      .get<ContactList>("/contacts")
      .then((list) => setContacts(list.contacts))
      .catch(() => setContacts([]));
  }, []);

  /* ---------- merchant ---------- */

  function typeMerchant(value: string) {
    setMerchant(value);
    setMerchantTouched(true);
  }

  /** Fills the name and its usual category in one go. */
  function applyPreset(preset: MerchantPreset) {
    setMerchant(preset.merchant);
    setMerchantTouched(true);
    if (preset.categoryId) changeCategory(preset.categoryId, preset.merchant);
    // Ordering only: a shortcut must not wait on a round trip.
    api.post(`/merchant-presets/${preset.id}/used`).catch(() => undefined);
  }

  /**
   * A person picked as the merchant: the money went to them, or came from
   * them - lent, or paid back, all of it theirs. Never spending or income,
   * and the server reads a plain row in Lent & borrowed the same way, so
   * the form shows here what will be saved rather than "Normal".
   */
  function pickPerson(contact: Contact) {
    if (kind === "transfer") leaveTransfer();
    setMerchant(contact.name);
    setMerchantTouched(true);
    setAutoMerchant(null);
    if (peopleCategoryId) setCategoryId(peopleCategoryId);
    becomePersonKind(contact.id);
  }

  /** The one contact a merchant names exactly, as the server matches it. */
  function contactNamed(name: string): string | null {
    const wanted = name.trim().toLowerCase();
    const matches = wanted ? (contacts ?? []).filter((contact) => contact.name.trim().toLowerCase() === wanted) : [];
    return matches.length === 1 ? matches[0].id : null;
  }

  /**
   * Lent on a payment, paid back on money in, with `contactId` (when
   * known) down for the whole amount. A payment already marked as split
   * or as paying someone back keeps that, with the person added.
   */
  function becomePersonKind(contactId: string | null) {
    setIsSpecial(false);
    setFixedOn(false);
    setCardPaymentFor("");
    setLoanId("");
    if (type === "DEBIT" && kind !== "settle") {
      const keepSplit = kind === "split";
      setSplitDraft((draft) => {
        const already = !contactId || draft.people.some((person) => person.contactId === contactId);
        const people = already ? draft.people : [...(keepSplit ? draft.people : []), { contactId, amountMinor: 0 }];
        return keepSplit ? { ...draft, people } : { ...draft, includeMe: false, mode: "equal", people };
      });
      setKind(keepSplit ? "split" : "lent");
      return;
    }
    if (contactId && !settlePeople.some((person) => person.contactId === contactId)) {
      // Whatever is not already on someone, as SettlePanel adds a person.
      const assigned = settlePeople.reduce((sum, person) => sum + person.amountMinor, 0);
      setSettlePeople([...settlePeople, { contactId, amountMinor: Math.max(0, totalMinor - assigned) }]);
    }
    setKind("settle");
  }

  /**
   * Filing something plain under Lent & borrowed means it was lent or paid
   * back - the server will save it so - so the kind follows the category.
   */
  function changeCategory(id: string, merchantName = merchant) {
    setCategoryId(id);
    if (id && id === peopleCategoryId && kind === "normal") becomePersonKind(contactNamed(merchantName));
  }

  async function savePreset() {
    const name = merchant.trim();
    if (!name) return;
    try {
      await api.post<MerchantPreset>("/merchant-presets", { merchant: name, categoryId: categoryId || null });
      setPresets(await api.get<MerchantPreset[]>("/merchant-presets"));
    } catch {
      // A shortcut that failed to save is not worth interrupting the edit.
    }
  }

  function removePreset(preset: MerchantPreset) {
    setPresets((current) => current.filter((p) => p.id !== preset.id));
    api.delete(`/merchant-presets/${preset.id}`).catch(() => undefined);
  }

  /* ---------- transfers ---------- */

  /**
   * A transfer is filed under Transfers and, when the merchant is only a
   * bank's handle (or empty), named for where the money went - "Transfer to
   * Cash" says what an ATM withdrawal was; "NEFT/HDFC00012" does not.
   */
  function nameTransfer(nextType: TransactionType, otherValue: string) {
    if (transfersCategoryId) setCategoryId(transfersCategoryId);
    const otherName = otherValue ? pickerValueName(otherValue, accounts) : null;
    if (!otherName) return;
    const label = nextType === "DEBIT" ? `Transfer to ${otherName}` : `Transfer from ${otherName}`;
    const current = merchant.trim();
    if ((autoMerchant !== null && current === autoMerchant) || (!merchantTouched && looksRaw(current))) {
      setMerchant(label);
      setAutoMerchant(label);
    }
  }

  function changeOtherAccount(value: string) {
    setOtherAccount(value);
    nameTransfer(type, value);
  }

  /* ---------- people ---------- */

  /**
   * Money lent to someone, or paid back by them, is about that person: the
   * merchant a bank message gives it is a UPI handle at best, and none of
   * the spending categories fit. So it takes their name and the people
   * category. An ordinary split - a dinner with Rahul - keeps its merchant
   * and category, and only borrows the name when it has none.
   */
  function nameAfterPerson(name: string, isLend: boolean) {
    if (isLend) {
      setMerchant(name);
      setAutoMerchant(null);
      if (peopleCategoryId) setCategoryId(peopleCategoryId);
    } else if (!merchant.trim()) {
      setMerchant(name);
    }
  }

  function contactName(id: string | undefined): string | null {
    if (!id) return null;
    return contacts?.find((contact) => contact.id === id)?.name ?? null;
  }

  function personAdded(contact: Contact, isFirst: boolean) {
    if (!isFirst) return; // The first person names it.
    nameAfterPerson(contact.name, kind === "settle" || (type === "DEBIT" && kind === "lent"));
  }

  /** "Include me" off on a payment is lending, so the chip follows it. */
  function changeSplit(next: SplitDraft) {
    setSplitDraft(next);
    if (type === "DEBIT" && next.includeMe !== splitDraft.includeMe) {
      setKind(next.includeMe ? "split" : "lent");
      if (!next.includeMe) becameLend(next.people[0]?.contactId);
    }
  }

  function becameLend(firstContactId: string | undefined) {
    const name = contactName(firstContactId);
    if (name) nameAfterPerson(name, true);
    else if (peopleCategoryId) setCategoryId(peopleCategoryId);
  }

  /* ---------- kind and direction ---------- */

  function leaveTransfer() {
    if (transfersCategoryId && categoryId === transfersCategoryId) setCategoryId("");
    if (autoMerchant !== null && merchant.trim() === autoMerchant) {
      setMerchant(transaction?.merchant ?? "");
      setAutoMerchant(null);
    }
  }

  function chooseKind(next: Kind) {
    if (next === kind) return;
    if (kind === "transfer") leaveTransfer();
    if (next === "transfer") nameTransfer(type, otherAccount);
    if (next === "split" || next === "lent") {
      setSplitDraft((draft) => ({ ...draft, includeMe: next !== "lent" }));
      if (next === "lent" && type === "DEBIT") becameLend(splitDraft.people[0]?.contactId);
    }
    if (next === "settle") {
      const first = contactName(settlePeople[0]?.contactId);
      if (first) nameAfterPerson(first, true);
      else if (peopleCategoryId) setCategoryId(peopleCategoryId);
    }
    if (next === "cardBill" && !cardPaymentFor && cardAccounts.length === 1) setCardPaymentFor(cardAccounts[0].id);
    if (next === "loan" && !loanId && loans.length === 1) setLoanId(loans[0].id);
    if (!SPECIAL_KINDS[type].includes(next)) setIsSpecial(false);
    if (!FIXED_KINDS.includes(next)) setFixedOn(false);
    setKind(next);
  }

  /**
   * Changing direction has to drop anything the new one cannot mean, or a
   * category picked as spending stays attached to something that is now
   * income and quietly lands in the wrong total.
   */
  function changeType(next: TransactionType) {
    if (next === type) return;
    setType(next);

    const stillValid = categoriesFor(categories, next).some((category) => category.id === categoryId);
    if (!stillValid) setCategoryId("");

    const nextKind = kindAfterTypeChange(kind, next);
    if (kind === "transfer" && nextKind === "transfer") nameTransfer(next, otherAccount);
    setKind(nextKind);
    // A one-off and keeping money out of the savings bucket are different
    // flags that happen to share a column; neither carries over.
    setIsSpecial(false);
    setFixedOn(false);
    setCardPaymentFor("");
    setLoanId("");
    setTripJustMine(false);
  }

  /** Keeps a one-person settling-up covering the whole amount as it is corrected. */
  function changeAmount(value: string) {
    const nextMinor = Math.max(0, Math.round(Number.parseFloat(value || "0") * 100) || 0);
    if (settlePeople.length === 1 && settlePeople[0].amountMinor === totalMinor) {
      setSettlePeople([{ ...settlePeople[0], amountMinor: nextMinor }]);
    }
    setAmount(value);
  }

  /**
   * Picking a fixed cost fills in what it is always paid to and always
   * counts as. Only fills what is empty: a merchant already read off a
   * bank message is better evidence than a default recorded weeks ago.
   */
  function pickCommitment(id: string) {
    setCommitmentId(id);
    const picked = commitments.find((commitment) => commitment.id === id);
    if (!picked) return;
    if (!merchant.trim() && picked.merchant) setMerchant(picked.merchant);
    const category = typeof picked.categoryId === "object" ? picked.categoryId?.id : picked.categoryId;
    if (!categoryId && category) setCategoryId(category);
  }

  /* ---------- what it will count as ---------- */

  // Said before the payment is filed rather than after: the point of a
  // limit is to change the next decision, not to report on the last one.
  const cardForThis = cards.find((card) => card.accountId === fromPickerValue(account, cashAccount));
  const cardWarning =
    cardForThis && (cardForThis.state === "over" || cardForThis.state === "close") ? cardForThis : null;

  const loanForThis = loans.find((loan) => loan.id === loanId);
  const total = formatMoney(totalMinor);
  const counts: { text: string; tone: "debit" | "credit" | "neutral" } = (() => {
    if (type === "DEBIT") {
      switch (kind) {
        case "split":
          return {
            text: `${formatMoney(splitResult.myShareMinor)} is your spending · ${formatMoney(splitResult.othersMinor)} owed back`,
            tone: "debit",
          };
        case "lent":
          return { text: `Not spending — ${total} owed back to you`, tone: "neutral" };
        case "transfer":
          return { text: "Not spending — it only moved between your accounts", tone: "neutral" };
        case "cardBill":
          return { text: "Counts as nothing — the card's purchases were counted when they happened", tone: "neutral" };
        case "loan":
          return {
            text: `${total} of spending${loanForThis ? ` · next instalment on ${loanForThis.label}` : ""}`,
            tone: "debit",
          };
        case "settle":
          return { text: "Not spending — paying back what you owed", tone: "neutral" };
        default:
          return {
            text: `${total} of spending${isSpecial ? " · a one-off, still in the monthly budget" : ""}`,
            tone: "debit",
          };
      }
    }
    switch (kind) {
      case "salary":
        return { text: "Your salary — a new spending period starts here", tone: "credit" };
      case "refund":
        return { text: "Not income — money back on earlier purchases", tone: "neutral" };
      case "earmark":
        return { text: "Not income — set aside for a purchase still to come", tone: "neutral" };
      case "transfer":
        return { text: "Not income — it only moved between your accounts", tone: "neutral" };
      case "settle":
        return { text: "Not income — paid back what you were owed", tone: "neutral" };
      case "split":
        return {
          text: `${formatMoney(splitResult.myShareMinor)} is income · ${formatMoney(splitResult.othersMinor)} is money coming back`,
          tone: "credit",
        };
      default:
        return {
          text: `${total} of income${isSpecial ? " · kept out of the savings bucket" : " · goes into the savings bucket"}`,
          tone: "credit",
        };
    }
  })();

  /* ---------- saving ---------- */

  function problem(): string | null {
    const rupees = Number.parseFloat(amount);
    if (!Number.isFinite(rupees) || rupees <= 0) return "Enter an amount greater than zero.";
    if (kind === "transfer" && otherAccount && otherAccount === account)
      return "Money can't move from an account to itself — pick a different one.";
    if (isSplitKind && splitResult.error) return splitResult.error;
    if (kind === "settle") {
      const assigned = settlePeople.reduce((sum, person) => sum + person.amountMinor, 0);
      if (assigned > totalMinor) return `The people add up to more than ${total}.`;
    }
    if (kind === "cardBill" && !cardPaymentFor) return "Pick which card's bill this paid.";
    if (kind === "loan" && !loanId) return "Pick which loan this repays.";
    return null;
  }

  /** `thenLink` opens the purchase picker once saved (refunds and earmarks). */
  async function save(thenLink = false) {
    const wrong = problem();
    if (wrong) {
      setError(wrong);
      return;
    }

    setSaving(true);
    setError(null);
    const isDebit = type === "DEBIT";
    const transferOther = kind === "transfer" ? fromPickerValue(otherAccount, cashAccount) : null;
    const body = {
      amountMinor: totalMinor,
      type,
      merchant: merchant.trim() || null,
      note: note.trim() || null,
      categoryId: categoryId || null,
      accountId: fromPickerValue(account, cashAccount),
      occurredAt: fromIstParts(date, time),
      // A card bill found as both legs of a transfer keeps that mark.
      isTransfer: kind === "transfer" || (kind === "cardBill" && !!transaction?.isTransfer),
      transferAccountId: transferOther,
      isSpecial: specialApplies && isSpecial,
      isSalary: !isDebit && kind === "salary",
      isEarmarked: !isDebit && kind === "earmark",
      cardPaymentFor: isDebit && kind === "cardBill" ? cardPaymentFor || null : null,
      commitmentId: fixedApplies && fixedOn ? commitmentId || null : null,
      loanId: isDebit && kind === "loan" ? loanId || null : null,
      isSettlement: kind === "settle",
      // Narrowed to the payer alone, or widened back to everyone on the trip.
      ...(transaction?.tripId ? { tripShareWith: isDebit && tripJustMine ? [transaction.userId] : null } : {}),
      split: isSplitKind
        ? { myShareMinor: splitResult.myShareMinor, groupLabel: splitDraft.groupLabel.trim() || null }
        : null,
      // Only a split or a settling-up has anyone else in it.
      people: isSplitKind
        ? splitResult.people.filter((person) => person.amountMinor > 0)
        : kind === "settle"
          ? settlePeople.filter((person) => person.amountMinor > 0)
          : [],
    };

    try {
      const saved = isNew
        ? await api.post<Transaction>("/transactions", { ...body, currency: "INR" })
        : await api.patch<Transaction>(`/transactions/${transaction!.id}`, body);
      onSaved(saved);
      onClose();
      if (thenLink) onMarkRefund?.(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the change.");
      setSaving(false);
    }
  }
  saveRef.current = () => {
    if (!saving) void save();
  };

  async function remove() {
    if (!transaction) return;
    setSaving(true);
    try {
      await api.delete(`/transactions/${transaction.id}`);
      onDeleted?.(transaction.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete it.");
      setSaving(false);
    }
  }

  async function unmerge() {
    if (!transaction) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/transactions/${transaction.id}/unmerge`);
      onSaved(transaction);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't separate that transaction.");
      setSaving(false);
    }
  }

  /* ---------- layout ---------- */

  const kindOptions = kindsFor(type).filter((option) => {
    if (option.kind === "cardBill") return cardAccounts.length > 0 || kind === "cardBill";
    if (option.kind === "loan") return loans.length > 0 || kind === "loan";
    return true;
  });

  const accountRow =
    kind === "transfer" ? (
      type === "DEBIT" ? (
        <>
          <AccountSelect id="e-account" label="From" value={account} onChange={setAccount} accounts={accounts} />
          <AccountSelect
            id="e-account-other"
            label="To"
            value={otherAccount}
            onChange={changeOtherAccount}
            accounts={accounts}
            placeholder="Choose where it went"
          />
        </>
      ) : (
        <>
          <AccountSelect
            id="e-account-other"
            label="From"
            value={otherAccount}
            onChange={changeOtherAccount}
            accounts={accounts}
            placeholder="Choose where it came from"
          />
          <AccountSelect id="e-account" label="To" value={account} onChange={setAccount} accounts={accounts} />
        </>
      )
    ) : (
      <AccountSelect id="e-account" label="Account" value={account} onChange={setAccount} accounts={accounts} />
    );

  const noteField = (
    <div className="form-row">
      <label htmlFor="e-note">Note</label>
      <input
        id="e-note"
        className="filter-input"
        placeholder="Optional"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
    </div>
  );

  const earmarkSpentMinor = transaction?.isEarmarked
    ? transaction.refundOf.reduce((sum, link) => sum + link.amountMinor, 0)
    : 0;
  const refundLinkedMinor = transaction ? transaction.refundOf.reduce((sum, link) => sum + link.amountMinor, 0) : 0;

  const panel = (() => {
    switch (kind) {
      case "split":
      case "lent":
        return (
          <SplitPanel
            type={type}
            totalMinor={totalMinor}
            contacts={contacts}
            draft={splitDraft}
            result={splitResult}
            onChange={changeSplit}
            onPersonAdded={personAdded}
          />
        );
      case "settle":
        return (
          <SettlePanel
            type={type}
            totalMinor={totalMinor}
            contacts={contacts}
            people={settlePeople}
            onChange={setSettlePeople}
            onPersonAdded={personAdded}
          />
        );
      case "transfer":
        return (
          <p className="field-hint">
            Left out of spending and income — the money only moved. Cash counts as an account, so an ATM
            withdrawal is a transfer to Cash. {otherAccount ? "" : "Pick the other account on the left."}
          </p>
        );
      case "cardBill":
        // A bill payment usually produces one message, from the bank being
        // debited, with nothing on the card side to pair it with - so the
        // automatic transfer detection can never find it.
        return (
          <>
            <div className="form-row">
              <label htmlFor="e-cardbill">Which card's bill?</label>
              <select
                id="e-cardbill"
                className="filter-select"
                value={cardPaymentFor}
                onChange={(e) => setCardPaymentFor(e.target.value)}
              >
                <option value="">Choose a card</option>
                {cardAccounts.map((card) => (
                  <option key={card.id} value={card.id}>
                    {accountLabel(card)}
                  </option>
                ))}
              </select>
            </div>
            <p className="field-hint">
              Counts as nothing. Every purchase on that card was already counted the day it happened, so
              counting the bill too would book the same money twice.
            </p>
          </>
        );
      case "loan":
        // A loan has no purchase to keep out of the totals the way an
        // EMI's does, so this always counts in full - the picker only says
        // which schedule the payment closes off next.
        return (
          <>
            <div className="form-row">
              <label htmlFor="e-loan">Which loan?</label>
              <select id="e-loan" className="filter-select" value={loanId} onChange={(e) => setLoanId(e.target.value)}>
                <option value="">Choose a loan</option>
                {loans.map((loan) => (
                  <option key={loan.id} value={loan.id}>
                    {loan.label} · {formatMoney(loan.monthlyAmountMinor)} a month · {loan.paidCount} of {loan.months}{" "}
                    paid
                  </option>
                ))}
              </select>
            </div>
            <p className="field-hint">
              Claims whichever instalment on it is next due, regardless of the exact amount here.
            </p>
          </>
        );
      case "salary":
        // Only a person can say which credit is the month's pay: it lands a
        // day either side of when it should, and a month with leave in it
        // is smaller than the figure in the profile.
        return (
          <p className="field-hint">
            Starts the spending period here, and uses this amount rather than the one in Settings.
          </p>
        );
      case "refund":
        return (
          <>
            <p className="field-hint">
              {refundLinkedMinor > 0 && transaction && !transaction.isEarmarked
                ? `Linked to ${transaction.refundOf.length === 1 ? "1 purchase" : `${transaction.refundOf.length} purchases`} · ${formatMoney(refundLinkedMinor)} of it is money back. Anything not linked counts as income.`
                : "Link it to the purchases it gives money back on. Until then it counts as income."}
            </p>
            {onMarkRefund && (
              <div>
                <button type="button" className="btn btn-sm" onClick={() => save(true)} disabled={saving}>
                  <Icon name="ic-link" />
                  {transaction && transaction.refundOf.length > 0 && !transaction.isEarmarked
                    ? "Save and change refund link"
                    : "Save and pick the purchase"}
                </button>
              </div>
            )}
          </>
        );
      case "earmark":
        return (
          <>
            <p className="field-hint">
              Not counted as income. When you buy the thing, link the purchase to this money.
            </p>
            {transaction?.isEarmarked && (
              <div className="tx-earmark-state">
                <span>
                  <b className="num">{formatMoney(earmarkSpentMinor)}</b> spent
                  {transaction.refundOf.length > 0
                    ? ` on ${transaction.refundOf.length === 1 ? "1 purchase" : `${transaction.refundOf.length} purchases`}`
                    : ""}
                </span>
                <span>
                  <b className="num">{formatMoney(Math.max(0, transaction.amountMinor - earmarkSpentMinor))}</b> still
                  waiting
                </span>
              </div>
            )}
            <div className="tx-panel-actions">
              {!isNew && onMarkRefund && (
                <button type="button" className="btn btn-sm" onClick={() => save(true)} disabled={saving}>
                  <Icon name="ic-link" />
                  What did this pay for?
                </button>
              )}
              {transaction?.isEarmarked && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => chooseKind("normal")}>
                  No longer needed — count as income
                </button>
              )}
            </div>
          </>
        );
      default:
        return null;
    }
  })();

  const showTrip = type === "DEBIT" && !!transaction?.trip;
  const showFixed = fixedApplies && (commitments.length > 0 || fixedOn);
  const hasAlso = specialApplies || showFixed || showTrip;

  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal tx-editor" role="dialog" aria-modal="true" aria-labelledby="tx-editor-title">
        <header className="tx-head">
          <h3 id="tx-editor-title">{isNew ? "Add transaction" : "Edit transaction"}</h3>
          <div className="tx-dir" role="radiogroup" aria-label="Direction">
            {(
              [
                ["DEBIT", "Debit", "money out"],
                ["CREDIT", "Credit", "money in"],
              ] as [TransactionType, string, string][]
            ).map(([value, label, sub]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={type === value}
                className={`tx-dir-btn is-${value.toLowerCase()}${type === value ? " on" : ""}`}
                onClick={() => changeType(value)}
              >
                <b>{label}</b>
                <span>{sub}</span>
              </button>
            ))}
          </div>
          <span className="tx-head-sub">
            {isNew
              ? "Record something by hand"
              : `From ${transaction!.source === "EMAIL" ? "an email" : transaction!.source === "SMS" ? "an SMS" : transaction!.source === "STATEMENT" ? "a statement" : "manual entry"} — change anything that's wrong`}
          </span>
          <button className="tx-close icon-button" onClick={onClose} aria-label="Close">
            <Icon name="ic-x" />
          </button>
        </header>

        <div className="tx-body">
          <section className="tx-main" aria-label="Details">
            <div className={`tx-hero is-${type.toLowerCase()}`}>
              <label htmlFor="e-amount">Amount</label>
              <div className="tx-hero-input">
                <span className="tx-hero-sign" aria-hidden="true">
                  {type === "DEBIT" ? "−₹" : "+₹"}
                </span>
                <input
                  id="e-amount"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => changeAmount(e.target.value)}
                  autoFocus
                  autoComplete="off"
                />
              </div>
              <p className={`tx-counts is-${counts.tone}`} aria-live="polite">
                <Icon name="ic-info" />
                {counts.text}
              </p>
            </div>

            <div className="tx-pair">
              <MerchantField
                value={merchant}
                placeholder={type === "DEBIT" ? "Who was paid" : "Who paid you"}
                presets={presets}
                people={contacts}
                personPicked={
                  kind === "lent" || kind === "split"
                    ? (splitDraft.people[0]?.contactId ?? null)
                    : kind === "settle"
                      ? (settlePeople[0]?.contactId ?? null)
                      : null
                }
                onType={typeMerchant}
                onPreset={applyPreset}
                onPerson={pickPerson}
                onSavePreset={savePreset}
                onRemovePreset={removePreset}
              />
              <div className="form-row">
                <label htmlFor="e-category">Category</label>
                <select
                  id="e-category"
                  className="filter-select"
                  value={categoryId}
                  onChange={(e) => changeCategory(e.target.value)}
                >
                  <option value="">Uncategorized</option>
                  {categoriesFor(categories, type).map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="tx-pair">
              <div className="form-row">
                <label htmlFor="e-date">Date</label>
                <input
                  id="e-date"
                  type="date"
                  className="filter-input"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div className="form-row">
                <label htmlFor="e-time">Time</label>
                <input
                  id="e-time"
                  type="time"
                  className="filter-input"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </div>
            </div>

            <div className="tx-pair">
              {accountRow}
              {kind !== "transfer" && noteField}
            </div>
            {kind === "transfer" && noteField}

            {cardWarning && (
              <div className={`card-strip-row is-${cardWarning.state}`}>
                <Icon name="ic-alert" />
                <span>
                  <b>{cardWarning.name}</b> {creditWarning(cardWarning)}.
                </span>
              </div>
            )}
          </section>

          <section className="tx-side" aria-labelledby="tx-kind-title">
            <h4 id="tx-kind-title" className="tx-side-title">
              What kind of transaction is this?
            </h4>
            <div className="tx-kinds" role="radiogroup" aria-labelledby="tx-kind-title">
              {kindOptions.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  role="radio"
                  aria-checked={kind === option.kind}
                  title={option.hint}
                  className={`tx-chip${kind === option.kind ? " on" : ""}`}
                  onClick={() => chooseKind(option.kind)}
                >
                  <Icon name={option.icon} />
                  {option.label}
                </button>
              ))}
            </div>

            {panel && <div className="tx-panel">{panel}</div>}

            {hasAlso && (
              <div className="tx-also">
                <span className="tx-also-label">Also</span>
                <div className="tx-also-toggles">
                  {/* On a payment, a marker for a rare big purchase - the
                      laptop, not the lunch - so it can be told apart. It is
                      real spending and counts against the monthly budget
                      like anything else. On money in, the same flag keeps a
                      windfall out of the savings bucket. */}
                  {specialApplies && (
                    <label
                      className="tx-toggle"
                      title={
                        type === "DEBIT"
                          ? "Marks a rare, big purchase so it stands out. It still counts against the monthly budget."
                          : "Money in normally tops up the savings bucket at the end of the month"
                      }
                    >
                      <input type="checkbox" checked={isSpecial} onChange={(e) => setIsSpecial(e.target.checked)} />
                      <span>{type === "DEBIT" ? "One-off purchase" : "Keep out of savings bucket"}</span>
                    </label>
                  )}
                  {/* Marking the payment rather than ticking a due date is
                      what lets a bill be paid early, and what makes a part
                      payment tellable from none. */}
                  {showFixed && (
                    <label className="tx-toggle" title="Still counts as spending">
                      <input
                        type="checkbox"
                        checked={fixedOn}
                        onChange={(e) => {
                          setFixedOn(e.target.checked);
                          if (e.target.checked && !commitmentId && commitments.length === 1)
                            pickCommitment(commitments[0].id);
                        }}
                      />
                      <span>Fixed monthly cost</span>
                    </label>
                  )}
                  {showTrip && (
                    <label className="tx-toggle" title="Leave it out of who owes whom on the trip">
                      <input type="checkbox" checked={tripJustMine} onChange={(e) => setTripJustMine(e.target.checked)} />
                      <span>Just mine on {transaction!.trip!.name}</span>
                    </label>
                  )}
                </div>
                {showFixed && fixedOn && (
                  <div className="form-row">
                    <label htmlFor="e-commitment">Which fixed cost?</label>
                    <select
                      id="e-commitment"
                      className="filter-select"
                      value={commitmentId}
                      onChange={(e) => pickCommitment(e.target.value)}
                    >
                      <option value="">Choose one</option>
                      {commitments.map((commitment) => (
                        <option key={commitment.id} value={commitment.id}>
                          {commitment.name} · {formatMoney(commitment.amountMinor)} a month
                        </option>
                      ))}
                    </select>
                    <span className="field-hint">
                      Still counts as spending. Sending less than usual is fine — the dashboard says what went
                      short rather than treating it as unpaid.
                    </span>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        {error && (
          <p className="form-error tx-error" role="alert">
            {error}
          </p>
        )}

        <footer className="tx-foot">
          {!isNew && onDeleted && (
            <button
              className={`btn btn-sm ${confirmDelete ? "btn-primary tx-danger" : "btn-ghost btn-danger-text"}`}
              onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}
              disabled={saving}
            >
              {confirmDelete ? "Really delete?" : "Delete"}
            </button>
          )}
          {!isNew && (
            <button className="btn btn-sm btn-ghost" onClick={() => setRawOpen(true)} disabled={saving}>
              <Icon name="ic-message" />
              {mergedCount > 1 ? "Original messages" : "Original message"}
            </button>
          )}
          {mergedCount > 1 && (
            <button
              className="btn btn-sm btn-ghost"
              onClick={unmerge}
              disabled={saving}
              title="Undo the merge: one transaction per message"
            >
              Separate into {mergedCount}
            </button>
          )}
          {!isNew && onConvertToEmi && type === "DEBIT" && !transaction.emiPlanId && (
            <button className="btn btn-sm btn-ghost" onClick={() => onConvertToEmi(transaction)} disabled={saving}>
              <Icon name="ic-calendar" />
              Convert to EMI
            </button>
          )}
          <span className="modal-actions-spacer" />
          <span className="tx-shortcut" aria-hidden="true">
            Ctrl+Enter to save
          </span>
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => save()} disabled={saving}>
            {saving ? "Saving…" : isNew ? "Add transaction" : "Save changes"}
          </button>
        </footer>
      </div>

      {rawOpen && transaction && <RawMessageModal transaction={transaction} onClose={() => setRawOpen(false)} />}
    </div>
  );
}
