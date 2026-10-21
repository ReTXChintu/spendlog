import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { StateBlock } from "../components/States";
import { api } from "../lib/api";
import { formatDayLabel, formatMoneyShort, istDayOf } from "../lib/format";
import { Trip, TripMember, TripSettlement, TripSummary } from "../types";

/** The trip detail, where members are resolved to people. */
type TripDetail = Trip & { members: TripMember[] };

/** Two initials, for a monogram or avatar. */
function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** "9 Oct – 12 Oct" or "9 Oct – now". */
function tripDates(trip: Trip): string {
  return `${formatDayLabel(istDayOf(trip.startedAt))}${
    trip.endedAt ? ` – ${formatDayLabel(istDayOf(trip.endedAt))}` : " – now"
  }`;
}

/**
 * Where a trip planned in Trippin says so: a chip back to it while
 * linked, and a note of where it came from once tracking was switched off
 * there.
 */
function TripSourceRow({ trip }: { trip: Trip }) {
  const source = trip.source;
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
          ? "Its name, dates and people follow Trippin. You can still change them here, but Trippin's next change overwrites yours."
          : "Tracking was switched off in Trippin. Everything on it stayed, and it's an ordinary trip now."}
      </span>
    </div>
  );
}

/**
 * Trips: a holiday totalled on its own.
 *
 * Turning trip mode on files everything spent from that moment under the
 * trip, so the question "what did Goa cost" has an answer without anyone
 * tagging payments one at a time.
 */
export function TripsPage() {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  // Trippin links straight to a trip here, as /trips?trip=<id>.
  const [searchParams] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(() => searchParams.get("trip"));
  const [summary, setSummary] = useState<TripSummary | null>(null);
  const [detail, setDetail] = useState<TripDetail | null>(null);
  const [settlement, setSettlement] = useState<TripSettlement | null>(null);
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<Trip[]>("/trips")
      .then(setTrips)
      .catch(() => setTrips([]));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (!openId) {
      setSummary(null);
      setDetail(null);
      setSettlement(null);
      return;
    }
    api
      .get<TripSummary>(`/trips/${openId}/summary`)
      .then(setSummary)
      .catch(() => setSummary(null));
    api
      .get<TripDetail>(`/trips/${openId}`)
      .then(setDetail)
      .catch(() => setDetail(null));
    api
      .get<TripSettlement>(`/trips/${openId}/settlement`)
      .then(setSettlement)
      .catch(() => setSettlement(null));
  }, [openId, trips]);

  const active = trips?.find((trip) => trip.isActive) ?? null;
  const openTrip = trips?.find((trip) => trip.id === openId) ?? null;
  const past = trips?.filter((trip) => !trip.isActive) ?? [];

  async function run<T>(action: () => Promise<T>, after?: (result: T) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      load();
      after?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  function joinTrip() {
    run(
      () => api.post<Trip>("/trips/join", { code: joinCode.trim() }),
      (trip) => {
        setJoinCode("");
        setNotice(
          `Joined "${trip.name}". It shares from now on — anything you spent before stays yours ` +
            "until you add it with Re-scan."
        );
      }
    );
  }

  function start() {
    if (!name.trim()) {
      setError("Give the trip a name first.");
      return;
    }
    run(
      () => api.post<Trip & { claimedCount: number }>("/trips", { name: name.trim() }),
      (trip) => {
        setName("");
        if (trip.claimedCount > 0) {
          setNotice(
            `Trip started. ${trip.claimedCount} ${
              trip.claimedCount === 1 ? "payment" : "payments"
            } already made today went onto it.`
          );
        }
      }
    );
  }

  function tripCard(trip: Trip) {
    const selected = openId === trip.id;
    return (
      <div key={trip.id} className={`trip-card${selected ? " is-selected" : ""}${trip.isActive ? " is-active" : ""}`}>
        <button
          className="trip-card-head"
          aria-pressed={selected}
          onClick={() => setOpenId(openId === trip.id ? null : trip.id)}
        >
          <span className={`monogram trip-mono${selected ? " is-on" : ""}`}>{initialsOf(trip.name)}</span>
          <span className="trip-card-main">
            <span className="trip-card-name">{trip.name}</span>
            <span className="trip-card-sub num">
              {tripDates(trip)} · {trip.transactionCount} {trip.transactionCount === 1 ? "payment" : "payments"}
              {trip.members.length > 1 && ` · ${trip.members.length} members`}
            </span>
            {trip.isActive && <span className="badge badge-ac trip-live">Running</span>}
          </span>
          <span className="trip-card-total num">{formatMoneyShort(trip.totalMinor)}</span>
        </button>
        <TripSourceRow trip={trip} />
      </div>
    );
  }

  return (
    <section className="screen trips-screen">
      <div className="screen-header">
        <h1 className="screen-title">Trips</h1>
        {active && (
          <span className="status-pill status-on">
            <span className="dot dot-good" /> Trip mode on · {active.name}
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
            <h2 className="t-title-section">Your trips</h2>
            <div className="trip-join-row">
              <input
                className="filter-input mono"
                placeholder="Join code"
                aria-label="Join code"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && joinTrip()}
              />
              <button className="btn" disabled={busy || !joinCode.trim()} onClick={joinTrip}>
                Join with a code
              </button>
            </div>
          </div>

          <div className="trip-group-label">{active ? "Running now" : "Start one"}</div>
          <div className="card trip-start">
            {active ? (
              <>
                <div className="trip-start-top">
                  <span className="icon-tile">
                    <Icon name="ic-briefcase" />
                  </span>
                  <div className="trip-start-main">
                    <div className="trip-start-name">{active.name}</div>
                    <div className="trip-start-sub num">
                      Since {formatDayLabel(istDayOf(active.startedAt))} · {formatMoneyShort(active.totalMinor)} so far
                    </div>
                  </div>
                  <span className="badge badge-good">Trip mode on</span>
                </div>
                {active.source?.linked && (
                  <p className="trip-start-note">
                    Planned in Trippin, so it runs on Trippin's dates. Ending it here works, but Trippin's next
                    change to the trip puts its dates back.
                  </p>
                )}
                <button
                  className="btn btn-primary btn-lg btn-block"
                  disabled={busy}
                  onClick={() => run(() => api.patch(`/trips/${active.id}`, { endedAt: new Date().toISOString() }))}
                >
                  End trip
                </button>
              </>
            ) : (
              <>
                <div className="trip-start-top">
                  <span className="icon-tile">
                    <Icon name="ic-briefcase" />
                  </span>
                  <div className="trip-start-main">
                    <div className="trip-start-name">Trip mode is off</div>
                    <div className="trip-start-sub">
                      Start one and everything spent from now on goes onto it, until you end it.
                    </div>
                  </div>
                </div>
                <label className="field">
                  <span>Trip name</span>
                  <input
                    className="filter-input"
                    placeholder="Goa, Dec"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && start()}
                  />
                </label>
                <button className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={start}>
                  Start trip
                </button>
                <p className="trip-start-note">
                  While it’s on, new payments join the trip, so the whole thing is totalled for you.
                </p>
              </>
            )}
          </div>

          {trips === null ? null : trips.length === 0 ? (
            <StateBlock
              icon="ic-briefcase"
              title="No trips yet"
              body="Start one when you set off. Everything spent until you end it gets totalled together, so you can see what the whole thing cost rather than picking it out of a month."
            />
          ) : (
            <>
              {active && <div className="trip-list">{tripCard(active)}</div>}
              {past.length > 0 && (
                <>
                  <div className="trip-group-label">Past trips</div>
                  <div className="trip-list">{past.map(tripCard)}</div>
                </>
              )}
            </>
          )}
        </div>

        <div className="trips-right stack">
          {openTrip && summary ? (
            <>
              <div className="trip-head">
                <div className="trip-head-main">
                  <div className="t-label num">
                    {openTrip.isActive ? "Running" : "Ended"} · {tripDates(openTrip)}
                    {detail && detail.id === openTrip.id && (
                      <>
                        {" "}
                        · code <span className="mono">{detail.joinCode}</span>
                      </>
                    )}
                  </div>
                  <h2 className="t-title-page">{openTrip.name}</h2>
                </div>
                {detail && detail.id === openTrip.id && detail.members.length > 0 && (
                  <div className="avatar-stack" aria-label={`${detail.members.length} members`}>
                    {detail.members.slice(0, 5).map((member) => (
                      <span className="avatar" key={member.userId} title={member.name ?? "Someone"}>
                        {initialsOf(member.name)}
                      </span>
                    ))}
                  </div>
                )}
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => api.post<{ claimedCount: number }>(`/trips/${openTrip.id}/rescan`),
                      (result) =>
                        setNotice(
                          result.claimedCount === 0
                            ? "Nothing else from those dates to add."
                            : `Added ${result.claimedCount} more.`
                        )
                    )
                  }
                >
                  <Icon name="ic-refresh" /> Re-scan trip
                </button>
              </div>

              <TripSourceRow trip={openTrip} />

              <div className="stat-tiles">
                <div className="stat-tile">
                  <div className="label">Trip total</div>
                  <div className="value num">{formatMoneyShort(summary.totalMinor)}</div>
                  <div className="foot">
                    {summary.transactionCount} {summary.transactionCount === 1 ? "payment" : "payments"}
                    {summary.byMember.length > 1 && ` by ${summary.byMember.length} people`}
                  </div>
                </div>
                <div className="stat-tile">
                  <div className="label">Length</div>
                  <div className="value num">
                    {summary.dayCount} {summary.dayCount === 1 ? "day" : "days"}
                  </div>
                  <div className="foot">with spending</div>
                </div>
                <div className="stat-tile">
                  <div className="label">Per day</div>
                  <div className="value num">{formatMoneyShort(summary.perDayMinor)}</div>
                  <div className="foot">for the whole group</div>
                </div>
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
                                <span className="avatar">{initialsOf(entry.name)}</span>
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

              {settlement && settlement.balances.length > 1 && (
                <div className="card trip-settle">
                  <div className="card-head">
                    <h2>Settle up</h2>
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
                </div>
              )}

              {detail && detail.id === openTrip.id && (
                <div className="card trip-members">
                  <div className="card-head">
                    <h2>Members</h2>
                  </div>
                  <div className="trip-code-box">
                    <div>
                      <div className="t-label">Join code</div>
                      <span className="trip-code mono">{detail.joinCode}</span>
                    </div>
                    <span className="trip-code-note">
                      Read this out, or show the QR from the phone app, to add someone. They see what was spent on
                      this trip and nothing else of yours.
                    </span>
                    <button
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => api.post<{ joinCode: string }>(`/trips/${openTrip.id}/rotate-code`),
                          () => {
                            setDetail(null);
                            setNotice("New code. The old one no longer works.");
                          }
                        )
                      }
                    >
                      <Icon name="ic-refresh" /> New code
                    </button>
                  </div>

                  <div className="trip-people">
                    {detail.members.map((member) => (
                      <div className="trip-person" key={member.userId}>
                        <span className="trip-who">
                          <span className="avatar">{initialsOf(member.name)}</span>
                          {member.name ?? "Someone"}
                        </span>
                        {member.isOwner ? (
                          <span className="badge badge-neutral">Started it</span>
                        ) : (
                          <button
                            className="btn btn-sm btn-danger-text"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => api.delete(`/trips/${openTrip.id}/members/${member.userId}`),
                                () => {
                                  setDetail(null);
                                  setNotice("Removed. What they spent stays on the trip.");
                                }
                              )
                            }
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="trip-actions">
                <p className="t-caption">Deleting a trip keeps every payment — only the label goes.</p>
                <button
                  className="btn btn-danger-text"
                  disabled={busy}
                  onClick={() => run(() => api.delete(`/trips/${openTrip.id}`))}
                >
                  <Icon name="ic-trash" /> Delete trip
                </button>
              </div>
            </>
          ) : (
            trips &&
            trips.length > 0 && (
              <div className="empty-inline trips-pick">
                <span className="icon-tile tile-neutral">
                  <Icon name="ic-briefcase" />
                </span>
                Pick a trip to see what it cost, who paid and who owes whom.
              </div>
            )
          )}
        </div>
      </div>
    </section>
  );
}
