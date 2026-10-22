import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { PeoplePicker } from "../components/PeoplePicker";
import { StateBlock } from "../components/States";
import { ShareChooser, ShareMode } from "../components/transaction-editor/ShareChooser";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDayLabel, formatMoney, formatMoneyShort, istDayOf, istToday } from "../lib/format";
import {
  Contact,
  ContactList,
  Group,
  GroupCandidate,
  GroupDetail,
  GroupSettlement,
  GroupSummary,
  Transaction,
} from "../types";
import "../styles/edit-transaction.css";

/** A payment in the group, as the group's own list gives it. */
type GroupPayment = Transaction & { isMine?: boolean; paidByName?: string | null };

/** Two initials, for a monogram or avatar. */
function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** "9 Oct – 12 Oct", "From 9 Oct", or null for a group with no dates. */
function groupDates(group: Pick<Group, "startedAt" | "endedAt">): string | null {
  const from = group.startedAt ? formatDayLabel(istDayOf(group.startedAt)) : null;
  const to = group.endedAt ? formatDayLabel(istDayOf(group.endedAt)) : null;
  if (from && to) return `${from} – ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Until ${to}`;
  return null;
}

/** A bare date input's value as the start, or the end, of that IST day. */
function dayToIso(day: string, end = false): string | null {
  if (!day) return null;
  return new Date(`${day}T${end ? "23:59:59.999" : "00:00:00.000"}+05:30`).toISOString();
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Trippin links straight to a trip as /trips?trip=<id>, and so did this
 * app before trips became groups. Both land on the same group here.
 */
export function LegacyTripsRedirect() {
  const [params] = useSearchParams();
  const id = params.get("trip") ?? params.get("group");
  return <Navigate to={id ? `/groups?group=${encodeURIComponent(id)}` : "/groups"} replace />;
}

/**
 * Where a group planned in Trippin says so: a chip back to it while
 * linked, and a note of where it came from once tracking was switched off
 * there.
 */
function GroupSourceRow({ group }: { group: Pick<Group, "source"> }) {
  const source = group.source;
  if (!source) return null;

  const label = source.linked ? "Planned in Trippin" : "Was linked to Trippin";
  const chip = source.url ? (
    <a
      className={`trip-source-chip${source.linked ? "" : " is-past"}`}
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      <Icon name="ic-link" /> {label}
      <Icon name="ic-arrow-up-right" />
    </a>
  ) : (
    <span className={`trip-source-chip${source.linked ? "" : " is-past"}`}>
      <Icon name="ic-link" /> {label}
    </span>
  );

  return (
    <div className="trip-source">
      {chip}
      <span className="trip-source-note">
        {source.linked
          ? "Its name, dates and people follow Trippin, and payments inside its dates are added on their own. You can still change it here, but Trippin's next change overwrites yours."
          : "Tracking was switched off in Trippin. Everything in it stayed, and it's an ordinary group now."}
      </span>
    </div>
  );
}

/**
 * Groups: a trip, a flat, an office lunch - anything spent together.
 *
 * Payments go into a group when they are put there, from the transaction
 * editor or here; each is split equally among everyone in it unless it
 * says otherwise. People without SpendLog are added from Contacts, and
 * what they owe shows on the People page. Only a group planned in Trippin
 * still picks up payments by its dates.
 */
export function GroupsPage() {
  const { user } = useAuth();
  const [groups, setGroups] = useState<Group[] | null>(null);
  // Trippin's links, and the old /trips ones, arrive as ?trip=; ours as ?group=.
  const [searchParams] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(() => searchParams.get("group") ?? searchParams.get("trip"));
  const [summary, setSummary] = useState<GroupSummary | null>(null);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [settlement, setSettlement] = useState<GroupSettlement | null>(null);
  const [payments, setPayments] = useState<GroupPayment[] | null>(null);
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paidByOpen, setPaidByOpen] = useState(false);
  const [candidatesOpen, setCandidatesOpen] = useState(false);
  // Bumped to reload the open group's figures after a change.
  const [version, setVersion] = useState(0);

  const loadContacts = useCallback(() => {
    api
      .get<ContactList>("/contacts")
      .then((list) => setContacts(list.contacts))
      .catch(() => setContacts([]));
  }, []);

  const load = useCallback(() => {
    api
      .get<Group[]>("/groups")
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);

  useEffect(load, [load]);
  useEffect(loadContacts, [loadContacts]);

  useEffect(() => {
    setSummary(null);
    setDetail(null);
    setSettlement(null);
    setPayments(null);
    if (!openId) return;
    api
      .get<GroupSummary>(`/groups/${openId}/summary`)
      .then(setSummary)
      .catch(() => setSummary(null));
    api
      .get<GroupDetail>(`/groups/${openId}`)
      .then(setDetail)
      .catch(() => setDetail(null));
    api
      .get<GroupSettlement>(`/groups/${openId}/settlement`)
      .then(setSettlement)
      .catch(() => setSettlement(null));
    api
      .get<GroupPayment[]>(`/groups/${openId}/transactions`)
      .then(setPayments)
      .catch(() => setPayments([]));
  }, [openId, version]);

  const active = groups?.filter((group) => !group.isArchived) ?? [];
  const archived = groups?.filter((group) => group.isArchived) ?? [];
  const openGroup = groups?.find((group) => group.id === openId) ?? null;
  const openDetail = detail && detail.id === openId ? detail : null;
  const me = openDetail?.members.find((member) => member.isMe) ?? null;
  const myId = me?.userId ?? user?.id ?? null;
  const isOwner = !!openGroup && !!myId && openGroup.ownerId === myId;
  const myContactMembers = openDetail?.contacts.filter((contact) => contact.isMine) ?? [];

  async function run<T>(action: () => Promise<T>, after?: (result: T) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      load();
      setVersion((v) => v + 1);
      after?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  function joinGroup() {
    run(
      () => api.post<Group & { alreadyJoined?: boolean }>("/groups/join", { code: joinCode.trim() }),
      (group) => {
        setJoinCode("");
        setOpenId(group.id);
        setNotice(
          group.alreadyJoined
            ? `You're already in "${group.name}".`
            : `Joined "${group.name}". Nothing you spent before goes into it unless you add it.`
        );
      }
    );
  }

  function groupCard(group: Group) {
    const selected = openId === group.id;
    const dates = groupDates(group);
    return (
      <div key={group.id} className={`trip-card${selected ? " is-selected" : ""}${group.isActive ? " is-active" : ""}`}>
        <button
          className="trip-card-head"
          aria-pressed={selected}
          onClick={() => setOpenId(openId === group.id ? null : group.id)}
        >
          <span className={`monogram trip-mono${selected ? " is-on" : ""}`}>{initialsOf(group.name)}</span>
          <span className="trip-card-main">
            <span className="trip-card-name">{group.name}</span>
            <span className="trip-card-sub num">
              {dates ? `${dates} · ` : ""}
              {plural(group.transactionCount, "payment")}
              {group.memberCount > 1 && ` · ${plural(group.memberCount, "person", "people")}`}
            </span>
            {group.isArchived && <span className="badge badge-neutral trip-live">Archived</span>}
          </span>
          <span className="trip-card-total num">{formatMoneyShort(group.totalMinor)}</span>
        </button>
        <GroupSourceRow group={group} />
      </div>
    );
  }

  const paymentsSorted = payments ?? [];

  return (
    <section className="screen trips-screen">
      <div className="screen-header">
        <h1 className="screen-title">Groups</h1>
        {groups && active.length > 0 && (
          <span className="status-pill status-on">
            <span className="dot dot-good" /> {plural(active.length, "active group")}
          </span>
        )}
      </div>

      {(error || notice) && (
        <div className="trip-messages">
          {error && (
            <div className="callout callout-crit" role="alert">
              <Icon name="ic-alert-triangle" />
              <div className="callout-body">{error}</div>
            </div>
          )}
          {notice && (
            <div className="callout callout-info" role="status">
              <Icon name="ic-info" />
              <div className="callout-body">{notice}</div>
            </div>
          )}
        </div>
      )}

      <div className="flow">
        <div className="trips-left stack">
          <div className="trips-left-head">
            <h2 className="t-title-section">Your groups</h2>
            <div className="trip-join-row">
              <input
                className="filter-input mono"
                placeholder="Join code"
                aria-label="Join code"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && joinCode.trim() && joinGroup()}
              />
              <button className="btn" disabled={busy || !joinCode.trim()} onClick={joinGroup}>
                Join with a code
              </button>
            </div>
          </div>

          {creating ? (
            <NewGroupForm
              contacts={contacts}
              busy={busy}
              onCancel={() => setCreating(false)}
              onCreate={(body) =>
                run(
                  () => api.post<Group>("/groups", body),
                  (group) => {
                    setCreating(false);
                    setOpenId(group.id);
                    setNotice(`"${group.name}" is ready. Put payments in it from the transaction editor, or below.`);
                  }
                )
              }
            />
          ) : (
            <button className="btn btn-primary btn-lg btn-block" onClick={() => setCreating(true)} disabled={busy}>
              <Icon name="ic-plus" /> New group
            </button>
          )}

          {groups === null ? null : groups.length === 0 ? (
            <StateBlock
              icon="ic-briefcase"
              title="No groups yet"
              body="Make one for a trip, a flat or the office lunch run. Put payments in it and SpendLog splits them between everyone, including people who don't use SpendLog."
            />
          ) : (
            <>
              <div className="trip-group-label">Active</div>
              {active.length === 0 ? (
                <p className="t-caption">Nothing active. Archived groups are below.</p>
              ) : (
                <div className="trip-list">{active.map(groupCard)}</div>
              )}
              {archived.length > 0 && (
                <>
                  <button
                    type="button"
                    className="group-archived-toggle"
                    aria-expanded={showArchived}
                    onClick={() => setShowArchived((open) => !open)}
                  >
                    <Icon name={showArchived ? "ic-chevron-up" : "ic-chevron-down"} />
                    Archived ({archived.length})
                  </button>
                  {showArchived && <div className="trip-list">{archived.map(groupCard)}</div>}
                </>
              )}
            </>
          )}
        </div>

        <div className="trips-right stack">
          {openGroup && summary ? (
            <>
              <div className="trip-head">
                <div className="trip-head-main">
                  <div className="t-label num">
                    {openGroup.isArchived ? "Archived" : "Active"}
                    {groupDates(openGroup) && ` · ${groupDates(openGroup)}`}
                    {openDetail && (
                      <>
                        {" "}
                        · code <span className="mono">{openDetail.joinCode}</span>
                      </>
                    )}
                  </div>
                  <h2 className="t-title-page">{openGroup.name}</h2>
                </div>
                {openDetail && (
                  <div
                    className="avatar-stack"
                    aria-label={`${openDetail.members.length + openDetail.contacts.length} people`}
                  >
                    {[...openDetail.members, ...openDetail.contacts].slice(0, 6).map((person) => (
                      <span
                        className={`avatar${person.kind === "contact" ? " is-contact" : ""}`}
                        key={person.id}
                        title={person.name}
                      >
                        {initialsOf(person.name)}
                      </span>
                    ))}
                  </div>
                )}
                <div className="group-head-actions">
                  {openGroup.autoAdds && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => api.post<{ claimedCount: number }>(`/groups/${openGroup.id}/rescan`),
                          (result) =>
                            setNotice(
                              result.claimedCount === 0
                                ? "Nothing else from those dates to add."
                                : `Added ${result.claimedCount} more.`
                            )
                        )
                      }
                    >
                      <Icon name="ic-refresh" /> Re-scan dates
                    </button>
                  )}
                  {isOwner && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            api.post<Group>(
                              `/groups/${openGroup.id}/${openGroup.isArchived ? "unarchive" : "archive"}`
                            ),
                          (group) =>
                            setNotice(
                              group.isArchived
                                ? `"${group.name}" is archived. It stays below the active ones, with everything in it.`
                                : `"${group.name}" is active again.`
                            )
                        )
                      }
                    >
                      <Icon name={openGroup.isArchived ? "ic-undo" : "ic-check"} />
                      {openGroup.isArchived ? "Unarchive" : "Archive"}
                    </button>
                  )}
                </div>
              </div>

              <GroupSourceRow group={openGroup} />

              <div className="group-actions-bar">
                <button
                  className="btn btn-primary"
                  disabled={busy || myContactMembers.length === 0}
                  title={
                    myContactMembers.length === 0
                      ? "Add someone from your contacts to the group first"
                      : "Record a payment one of your contacts made"
                  }
                  onClick={() => setPaidByOpen(true)}
                >
                  <Icon name="ic-plus" /> Add a payment someone else made
                </button>
                <button className="btn" disabled={busy} onClick={() => setCandidatesOpen(true)}>
                  <Icon name="ic-list" /> Add my payments
                </button>
              </div>

              <div className="stat-tiles">
                <div className="stat-tile">
                  <div className="label">Group total</div>
                  <div className="value num">{formatMoneyShort(summary.totalMinor)}</div>
                  <div className="foot">
                    {plural(summary.transactionCount, "payment")}
                    {summary.byMember.length > 1 && ` by ${summary.byMember.length} people`}
                  </div>
                </div>
                <div className="stat-tile">
                  <div className="label">Days</div>
                  <div className="value num">{plural(summary.dayCount, "day")}</div>
                  <div className="foot">with spending</div>
                </div>
                <div className="stat-tile">
                  <div className="label">Per day</div>
                  <div className="value num">{formatMoneyShort(summary.perDayMinor)}</div>
                  <div className="foot">for the whole group</div>
                </div>
              </div>

              {settlement && settlement.balances.length > 0 && (
                <div className="card trip-settle">
                  <div className="card-head">
                    <h2>Who owes whom</h2>
                  </div>
                  {settlement.transfers.length === 0 ? (
                    <div className="trip-transfer is-square">
                      <span className="icon-tile tile-good tile-on-tint">
                        <Icon name="ic-check" />
                      </span>
                      Everyone is square — nobody owes anybody anything.
                    </div>
                  ) : (
                    settlement.transfers.map((transfer) => (
                      <div className="trip-transfer" key={`${transfer.fromUserId}-${transfer.toUserId}`}>
                        <span className="avatar tile-on-tint">{initialsOf(transfer.fromName)}</span>
                        <span>
                          <b>{transfer.fromName}</b> pays <b>{transfer.toName}</b>
                        </span>
                        <span className="trip-transfer-amount num">{formatMoneyShort(transfer.amountMinor)}</span>
                      </div>
                    ))
                  )}
                  <table className="data-table group-balances">
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th className="num">Paid</th>
                        <th className="num">Share</th>
                        <th className="num">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {settlement.balances.map((balance) => (
                        <tr key={balance.userId}>
                          <td className="trip-cell-name">
                            <span className="trip-who">
                              <span className={`avatar${balance.kind === "contact" ? " is-contact" : ""}`}>
                                {initialsOf(balance.name)}
                              </span>
                              {balance.isMe ? "You" : balance.name}
                            </span>
                          </td>
                          <td className="num">{formatMoneyShort(balance.paidMinor)}</td>
                          <td className="num">{formatMoneyShort(balance.shareMinor)}</td>
                          <td className={`num ${balance.netMinor > 0 ? "money-in" : balance.netMinor < 0 ? "money-out" : ""}`}>
                            {balance.netMinor > 0 ? "+" : balance.netMinor < 0 ? "−" : ""}
                            {formatMoneyShort(Math.abs(balance.netMinor))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="t-caption">
                    What your contacts owe you, or you owe them, is also on the People page — one balance per person,
                    across groups and lending, settled there as usual.
                  </p>
                </div>
              )}

              <div className="card card-flush group-payments">
                <div className="card-head trip-card-pad">
                  <h2>Payments</h2>
                </div>
                {payments === null ? (
                  <p className="t-caption group-pad">Loading…</p>
                ) : paymentsSorted.length === 0 ? (
                  <p className="t-caption group-pad">
                    Nothing in it yet. Put a payment in this group from the transaction editor, add your earlier
                    payments, or record one someone else made.
                  </p>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>What</th>
                        <th>Paid by</th>
                        <th className="num">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paymentsSorted.map((payment) => (
                        <tr key={payment.id}>
                          <td className="num">{formatDayLabel(istDayOf(payment.occurredAt))}</td>
                          <td className="trip-cell-name">
                            {payment.merchant ?? "Payment"}
                            {(payment.groupShareWith ?? payment.tripShareWith)?.length ? (
                              <span className="badge badge-outline group-share-badge">
                                {(payment.groupShareWith ?? payment.tripShareWith)!.length === 1 ? "Just one" : "Some people"}
                              </span>
                            ) : null}
                          </td>
                          <td>
                            {payment.offLedger
                              ? (payment.paidByContact?.name ?? payment.paidByName ?? "Someone else")
                              : payment.isMine
                                ? "You"
                                : (payment.paidByName ?? "Someone")}
                          </td>
                          <td className="num">{formatMoney(payment.amountMinor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="flow">
                {summary.byCategory.length > 0 && (
                  <div className="card card-flush span-4">
                    <div className="card-head trip-card-pad">
                      <h2>By category</h2>
                    </div>
                    <table className="data-table">
                      <tbody>
                        {summary.byCategory.map((entry) => (
                          <tr key={entry.categoryId ?? "none"}>
                            <td className="trip-cell-name">{entry.name}</td>
                            <td className="num">{formatMoneyShort(entry.amountMinor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {summary.byMember.length > 1 && (
                  <div className="card card-flush span-4">
                    <div className="card-head trip-card-pad">
                      <h2>Who paid</h2>
                    </div>
                    <table className="data-table">
                      <tbody>
                        {summary.byMember.map((entry) => (
                          <tr key={entry.userId}>
                            <td className="trip-cell-name">
                              <span className="trip-who">
                                <span className={`avatar${entry.kind === "contact" ? " is-contact" : ""}`}>
                                  {initialsOf(entry.name)}
                                </span>
                                {entry.name ?? "Someone"}
                              </span>
                            </td>
                            <td className="num">{formatMoneyShort(entry.spentMinor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {openDetail && (
                <MembersCard
                  detail={openDetail}
                  isOwner={isOwner}
                  contacts={contacts}
                  busy={busy}
                  onRotate={() =>
                    run(
                      () => api.post<{ joinCode: string }>(`/groups/${openDetail.id}/rotate-code`),
                      () => setNotice("New code. The old one no longer works.")
                    )
                  }
                  onRemoveUser={(userId) =>
                    run(
                      () => api.delete(`/groups/${openDetail.id}/members/${userId}`),
                      () => setNotice("Removed. What they spent stays in the group.")
                    )
                  }
                  onAddContact={(body) =>
                    run(
                      () => api.post<GroupDetail>(`/groups/${openDetail.id}/contacts`, body),
                      () => {
                        loadContacts();
                        setNotice("Added. Their share of what's split from now on shows on the People page.");
                      }
                    )
                  }
                  onRemoveContact={(contactId) =>
                    run(
                      () => api.delete(`/groups/${openDetail.id}/contacts/${contactId}`),
                      () => setNotice("Taken out of the group.")
                    )
                  }
                />
              )}

              <div className="trip-actions">
                {isOwner ? (
                  <>
                    <p className="t-caption">Deleting a group keeps every payment — only the label goes.</p>
                    <button
                      className="btn btn-danger-text"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Delete "${openGroup.name}"? Every payment in it is kept.`)) return;
                        run(
                          () => api.delete(`/groups/${openGroup.id}`),
                          () => setOpenId(null)
                        );
                      }}
                    >
                      <Icon name="ic-trash" /> Delete group
                    </button>
                  </>
                ) : (
                  <>
                    <p className="t-caption">Leaving keeps what you spent in the group.</p>
                    <button
                      className="btn btn-danger-text"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => api.post(`/groups/${openGroup.id}/leave`),
                          () => setOpenId(null)
                        )
                      }
                    >
                      Leave group
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
            groups &&
            groups.length > 0 && (
              <div className="empty-inline trips-pick">
                <span className="icon-tile tile-neutral">
                  <Icon name="ic-briefcase" />
                </span>
                Pick a group to see what it cost, who paid and who owes whom.
              </div>
            )
          )}
        </div>
      </div>

      {paidByOpen && openDetail && myId && (
        <PaidByOtherModal
          detail={openDetail}
          myUserId={myId}
          onClose={() => setPaidByOpen(false)}
          onSaved={(payer) => {
            setPaidByOpen(false);
            load();
            setVersion((v) => v + 1);
            setNotice(`Recorded. Your share counts as your spending, and ${payer} is owed it.`);
          }}
        />
      )}
      {candidatesOpen && openGroup && (
        <CandidatesModal
          group={openGroup}
          onClose={() => setCandidatesOpen(false)}
          onAdded={(added) => {
            setCandidatesOpen(false);
            load();
            setVersion((v) => v + 1);
            setNotice(`${plural(added, "payment")} added to ${openGroup.name}.`);
          }}
        />
      )}
    </section>
  );
}

/** Name, optional dates and optional people for a new group. */
function NewGroupForm({
  contacts,
  busy,
  onCancel,
  onCreate,
}: {
  contacts: Contact[] | null;
  busy: boolean;
  onCancel: () => void;
  onCreate: (body: { name: string; startedAt: string | null; endedAt: string | null; contactIds: string[] }) => void;
}) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [picked, setPicked] = useState<Contact[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  function submit() {
    if (!name.trim()) return setProblem("Give the group a name first.");
    if (from && to && to < from) return setProblem("It can't end before it starts.");
    setProblem(null);
    onCreate({
      name: name.trim(),
      startedAt: dayToIso(from),
      endedAt: dayToIso(to, true),
      contactIds: picked.map((contact) => contact.id),
    });
  }

  return (
    <form
      className="card group-new"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3 className="t-title-card">New group</h3>
      <label className="field">
        <span>Name</span>
        <input
          autoFocus
          className="filter-input"
          placeholder="Goa trip, Flatmates, Office lunch"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="group-dates">
        <label className="field">
          <span>Starts (optional)</span>
          <input type="date" className="filter-input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>Ends (optional)</span>
          <input type="date" className="filter-input" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div className="field">
        <span>People from your contacts (optional)</span>
        {picked.length > 0 && (
          <div className="group-chips">
            {picked.map((contact) => (
              <button
                type="button"
                key={contact.id}
                className="chip on"
                aria-label={`Remove ${contact.name}`}
                onClick={() => setPicked(picked.filter((other) => other.id !== contact.id))}
              >
                {contact.name} <Icon name="ic-x" />
              </button>
            ))}
          </div>
        )}
        <PeoplePicker
          contacts={contacts}
          excludeIds={picked.map((contact) => contact.id)}
          onPick={(contact) => setPicked([...picked, contact])}
          placeholder="Add someone from your contacts"
        />
        <span className="field-hint">
          SpendLog users join with the group's code. Anyone else comes from your contacts — you can add more later.
        </span>
      </div>
      {problem && (
        <p className="form-error" role="alert">
          {problem}
        </p>
      )}
      <div className="group-form-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Create group
        </button>
      </div>
      <p className="t-caption">
        It stays active until you archive it. Nothing goes in on its own: you pick the group for each payment.
      </p>
    </form>
  );
}

/** Everyone in the group, the code to join it, and adding contacts. */
function MembersCard({
  detail,
  isOwner,
  contacts,
  busy,
  onRotate,
  onRemoveUser,
  onAddContact,
  onRemoveContact,
}: {
  detail: GroupDetail;
  isOwner: boolean;
  contacts: Contact[] | null;
  busy: boolean;
  onRotate: () => void;
  onRemoveUser: (userId: string) => void;
  onAddContact: (body: { contactId: string } | { name: string; phone: string | null }) => void;
  onRemoveContact: (contactId: string) => void;
}) {
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  const inGroup = detail.contacts.map((contact) => contact.contactId);

  return (
    <div className="card trip-members">
      <div className="card-head">
        <h2>People</h2>
      </div>
      <div className="trip-code-box">
        <div>
          <div className="t-label">Join code</div>
          <span className="trip-code mono">{detail.joinCode}</span>
        </div>
        <span className="trip-code-note">
          For people on SpendLog: read this out, or show the QR from the phone app. They see what was spent in this
          group and nothing else of yours.
        </span>
        {isOwner && (
          <button className="btn btn-sm" disabled={busy} onClick={onRotate}>
            <Icon name="ic-refresh" /> New code
          </button>
        )}
      </div>

      <div className="trip-people">
        {detail.members.map((member) => (
          <div className="trip-person" key={member.id}>
            <span className="trip-who">
              <span className="avatar">{initialsOf(member.name)}</span>
              <span className="group-person-text">
                {member.isMe ? `${member.name} (you)` : member.name}
                <span className="group-person-sub">On SpendLog</span>
              </span>
            </span>
            {member.isOwner ? (
              <span className="badge badge-neutral">Started it</span>
            ) : isOwner ? (
              <button className="btn btn-sm btn-danger-text" disabled={busy} onClick={() => onRemoveUser(member.userId)}>
                Remove
              </button>
            ) : null}
          </div>
        ))}
        {detail.contacts.map((contact) => (
          <div className="trip-person" key={contact.id}>
            <span className="trip-who">
              <span className="avatar is-contact">{initialsOf(contact.name)}</span>
              <span className="group-person-text">
                {contact.name}
                <span className="group-person-sub">
                  {contact.isMine
                    ? "Your contact · on your People page"
                    : `${contact.addedByName ?? "Someone"}'s contact`}
                </span>
              </span>
            </span>
            <span className="group-person-end">
              <span className="badge badge-outline">Contact</span>
              {(contact.isMine || isOwner) && (
                <button
                  className="btn btn-sm btn-danger-text"
                  disabled={busy}
                  onClick={() => onRemoveContact(contact.contactId)}
                >
                  Remove
                </button>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="group-add-contact">
        <span className="field-label">Add someone without SpendLog</span>
        <div className="tx-people-add">
          <PeoplePicker
            contacts={contacts}
            excludeIds={inGroup}
            onPick={(contact) => onAddContact({ contactId: contact.id })}
            placeholder="Pick from your contacts"
          />
          <button type="button" className="btn btn-sm" onClick={() => setNewOpen((open) => !open)}>
            <Icon name="ic-plus" /> New person
          </button>
        </div>
        {newOpen && (
          <form
            className="people-add-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              onAddContact({ name: name.trim(), phone: phone.trim() || null });
              setName("");
              setPhone("");
              setNewOpen(false);
            }}
          >
            <label className="field">
              <span>Name</span>
              <input autoFocus className="filter-input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>Phone (optional)</span>
              <input
                className="filter-input"
                inputMode="tel"
                placeholder="98765 43210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            <p className="field-hint">Saved to your People too. Someone already there with this number is reused.</p>
            <div className="group-form-actions">
              <button type="button" className="btn" onClick={() => setNewOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
                Add to group
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/** "Rahul paid ₹2,000 for dinner", split across the group. */
function PaidByOtherModal({
  detail,
  myUserId,
  onClose,
  onSaved,
}: {
  detail: GroupDetail;
  myUserId: string;
  onClose: () => void;
  onSaved: (payerName: string) => void;
}) {
  const payers = detail.contacts.filter((contact) => contact.isMine);
  const everyone = useMemo(
    () => [
      ...detail.members.map((member) => ({ id: member.userId, name: member.isMe ? "You" : member.name })),
      ...detail.contacts.map((contact) => ({ id: contact.contactId, name: contact.name })),
    ],
    [detail]
  );
  const [payer, setPayer] = useState(payers[0]?.contactId ?? "");
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [day, setDay] = useState(istToday());
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<ShareMode>("everyone");
  const [chosen, setChosen] = useState<string[]>(() => everyone.map((person) => person.id));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const totalMinor = Math.max(0, Math.round(Number.parseFloat(amount || "0") * 100) || 0);
  const sharers = mode === "everyone" ? everyone.map((p) => p.id) : mode === "mine" ? [myUserId] : chosen;
  const myShareMinor =
    sharers.length === 0 || !sharers.includes(myUserId) ? 0 : Math.floor(totalMinor / sharers.length);
  const payerName = payers.find((p) => p.contactId === payer)?.name ?? "them";

  async function save() {
    if (!payer) return setError("Pick who paid.");
    if (totalMinor <= 0) return setError("Enter an amount greater than zero.");
    if (mode === "custom" && chosen.length === 0) return setError("Tick at least one person it was for.");
    setSaving(true);
    setError(null);
    try {
      // Midday IST on the day picked: what it cost matters, not the minute.
      const occurredAt = new Date(`${day}T12:00:00.000+05:30`).toISOString();
      await api.post<Transaction>(`/groups/${detail.id}/payments`, {
        paidBy: { contactId: payer },
        amountMinor: totalMinor,
        occurredAt,
        merchant: merchant.trim() || null,
        note: note.trim() || null,
        shareWith: mode === "everyone" ? null : sharers,
      });
      onSaved(payerName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't record that.");
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-wide" role="dialog" aria-labelledby="paid-by-title" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <Icon name="ic-x" />
        </button>
        <h3 id="paid-by-title">Add a payment someone else made</h3>
        <p className="modal-sub">No account of yours moves. Your share counts as your spending.</p>

        <div className="group-modal-grid">
          <div className="form-row">
            <label htmlFor="pb-payer">Who paid</label>
            <select id="pb-payer" className="filter-select" value={payer} onChange={(e) => setPayer(e.target.value)}>
              {payers.map((contact) => (
                <option key={contact.contactId} value={contact.contactId}>
                  {contact.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="pb-amount">Amount (₹)</label>
            <input
              id="pb-amount"
              className="filter-input num"
              inputMode="decimal"
              placeholder="2000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </div>
          <div className="form-row">
            <label htmlFor="pb-merchant">What for</label>
            <input
              id="pb-merchant"
              className="filter-input"
              placeholder="Dinner"
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label htmlFor="pb-day">Date</label>
            <input id="pb-day" type="date" className="filter-input" value={day} onChange={(e) => setDay(e.target.value)} />
          </div>
          <div className="form-row form-row-wide">
            <label htmlFor="pb-note">Note</label>
            <input
              id="pb-note"
              className="filter-input"
              placeholder="Optional"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <ShareChooser
          mode={mode}
          onMode={setMode}
          people={everyone}
          chosen={chosen}
          onChosen={setChosen}
        />

        <p className="tx-counts is-debit" aria-live="polite">
          {formatMoney(myShareMinor)} is your spending · you owe {payerName} {formatMoney(myShareMinor)}
        </p>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Add payment"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The user's own payments on no group yet, to put in this one by hand. */
function CandidatesModal({
  group,
  onClose,
  onAdded,
}: {
  group: Group;
  onClose: () => void;
  onAdded: (added: number) => void;
}) {
  const [candidates, setCandidates] = useState<GroupCandidate[] | null>(null);
  const [query, setQuery] = useState("");
  const [days, setDays] = useState(60);
  const [picked, setPicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCandidates(null);
    const params = new URLSearchParams({ days: String(days) });
    if (query.trim()) params.set("q", query.trim());
    const timer = setTimeout(() => {
      api
        .get<GroupCandidate[]>(`/groups/${group.id}/candidates?${params.toString()}`)
        .then(setCandidates)
        .catch(() => setCandidates([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [group.id, query, days]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickedTotal = (candidates ?? [])
    .filter((candidate) => picked.includes(candidate.id))
    .reduce((sum, candidate) => sum + candidate.amountMinor, 0);

  async function add() {
    if (picked.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.post<{ added: number; skipped: number }>(`/groups/${group.id}/add`, {
        transactionIds: picked,
      });
      onAdded(result.added);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add those.");
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-wide" role="dialog" aria-labelledby="cand-title" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <Icon name="ic-x" />
        </button>
        <h3 id="cand-title">Add my payments to {group.name}</h3>
        <p className="modal-sub">Your own payments that aren't in any group. Tickets and stays come first.</p>
        <div className="group-cand-filters">
          <input
            className="filter-input"
            placeholder="Search merchant or note"
            aria-label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="filter-select"
            aria-label="How far back"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
            <option value={180}>Last 6 months</option>
            <option value={365}>Last year</option>
          </select>
        </div>
        <div className="group-cand-list">
          {candidates === null ? (
            <p className="t-caption">Loading…</p>
          ) : candidates.length === 0 ? (
            <p className="t-caption">Nothing to add from that far back.</p>
          ) : (
            candidates.map((candidate) => (
              <label className="group-cand" key={candidate.id}>
                <input
                  type="checkbox"
                  checked={picked.includes(candidate.id)}
                  onChange={(e) =>
                    setPicked(
                      e.target.checked ? [...picked, candidate.id] : picked.filter((id) => id !== candidate.id)
                    )
                  }
                />
                <span className="group-cand-main">
                  <span className="group-cand-name">
                    {candidate.merchant ?? "Payment"}
                    {candidate.likelyTravel && <span className="badge badge-ac">Travel</span>}
                  </span>
                  <span className="group-cand-sub">
                    {formatDayLabel(istDayOf(candidate.occurredAt))}
                    {candidate.accountLabel ? ` · ${candidate.accountLabel}` : ""}
                    {candidate.categoryName ? ` · ${candidate.categoryName}` : ""}
                  </span>
                </span>
                <span className="num">{formatMoney(candidate.amountMinor)}</span>
              </label>
            ))
          )}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <span className="t-caption">
            {picked.length > 0 ? `${plural(picked.length, "payment")} · ${formatMoney(pickedTotal)}` : "None picked"}
          </span>
          <span className="modal-actions-spacer" />
          <button className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={add} disabled={saving || picked.length === 0}>
            {saving ? "Adding…" : "Add to group"}
          </button>
        </div>
      </div>
    </div>
  );
}
