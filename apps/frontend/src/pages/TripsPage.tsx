import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { StateBlock } from "../components/States";
import { api } from "../lib/api";
import { formatDayLabel, formatMoney, formatMoneyShort } from "../lib/format";
import { Trip, TripMember, TripSettlement, TripSummary } from "../types";

/** The trip detail, where members are resolved to people. */
type TripDetail = Trip & { members: TripMember[] };

/**
 * Trips: a holiday totalled on its own.
 *
 * Turning trip mode on files everything spent from that moment under the
 * trip, so the question "what did Goa cost" has an answer without anyone
 * tagging payments one at a time.
 */
export function TripsPage() {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
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

  return (
    <section className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Trips</h1>
      </div>

      <div className="trip-start">
        {active ? (
          <>
            <div className="trip-start-main">
              <div className="trip-start-label">Trip mode is on</div>
              <div className="trip-start-name">{active.name}</div>
              <div className="trip-start-sub">
                Since {formatDayLabel(active.startedAt.slice(0, 10))} ·{" "}
                {formatMoney(active.totalMinor)} so far
              </div>
            </div>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                run(() => api.patch(`/trips/${active.id}`, { endedAt: new Date().toISOString() }))
              }
            >
              End trip
            </button>
          </>
        ) : (
          <>
            <div className="trip-start-main">
              <div className="trip-start-label">Trip mode is off</div>
              <div className="trip-start-sub">
                Start one and everything spent from now on goes onto it, until you end it.
              </div>
            </div>
            <input
              className="filter-input"
              placeholder="Goa, Dec"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && start()}
            />
            <button className="btn btn-primary" disabled={busy} onClick={start}>
              Start trip
            </button>
          </>
        )}
      </div>

      <div className="trip-join-row">
        <span className="field-hint">Someone shared a code with you?</span>
        <input
          className="filter-input"
          placeholder="Join code"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && joinTrip()}
        />
        <button className="btn btn-sm" disabled={busy || !joinCode.trim()} onClick={joinTrip}>
          Join
        </button>
      </div>

      {error && <div className="merge-error">{error}</div>}
      {notice && <p className="field-hint">{notice}</p>}

      {trips === null ? null : trips.length === 0 ? (
        <StateBlock
          icon="ic-calendar"
          title="No trips yet"
          body="Start one when you set off. Everything spent until you end it gets totalled together, so you can see what the whole thing cost rather than picking it out of a month."
        />
      ) : (
        <div className="trip-list">
          {trips.map((trip) => (
            <div key={trip.id} className={`trip-card${trip.isActive ? " is-active" : ""}`}>
              <button
                className="trip-card-head"
                onClick={() => setOpenId(openId === trip.id ? null : trip.id)}
              >
                <span className="trip-card-main">
                  <span className="trip-card-name">
                    {trip.name}
                    {trip.isActive && <span className="trip-live">Running</span>}
                  </span>
                  <span className="trip-card-sub">
                    {formatDayLabel(trip.startedAt.slice(0, 10))}
                    {trip.endedAt ? ` – ${formatDayLabel(trip.endedAt.slice(0, 10))}` : " – now"} ·{" "}
                    {trip.transactionCount} {trip.transactionCount === 1 ? "payment" : "payments"}
                  </span>
                </span>
                <span className="trip-card-total num">{formatMoney(trip.totalMinor)}</span>
                <Icon name={openId === trip.id ? "ic-chevron-down" : "ic-chevron-right"} />
              </button>

              {openId === trip.id && summary && (
                <div className="trip-detail">
                  <div className="emi-preview">
                    <div>
                      <span className="emi-preview-label">Total</span>
                      <span className="emi-preview-value num">{formatMoney(summary.totalMinor)}</span>
                    </div>
                    <div>
                      <span className="emi-preview-label">Days with spending</span>
                      <span className="emi-preview-value num">{summary.dayCount}</span>
                    </div>
                    <div>
                      <span className="emi-preview-label">Per day</span>
                      <span className="emi-preview-value num">{formatMoney(summary.perDayMinor)}</span>
                    </div>
                  </div>

                  {summary.byMember.length > 1 && (
                    <div className="trip-people">
                      {summary.byMember.map((entry) => (
                        <div className="trip-person" key={entry.userId}>
                          <span>{entry.name ?? "Someone"} paid</span>
                          <span className="num">{formatMoney(entry.spentMinor)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {summary.byCategory.length > 0 && (
                    <div className="trip-breakdown">
                      {summary.byCategory.map((entry) => (
                        <div className="trip-breakdown-row" key={entry.categoryId ?? "none"}>
                          <span>{entry.name}</span>
                          <span className="num">{formatMoneyShort(entry.amountMinor)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {settlement && settlement.balances.length > 1 && (
                    <div className="trip-settle">
                      <div className="trip-settle-title">Settling up</div>
                      {settlement.transfers.length === 0 ? (
                        <div className="trip-square">
                          Everyone is square — nobody owes anybody anything.
                        </div>
                      ) : (
                        settlement.transfers.map((transfer) => (
                          <div
                            className="trip-transfer"
                            key={`${transfer.fromUserId}-${transfer.toUserId}`}
                          >
                            <span>{transfer.fromName}</span>
                            <Icon name="ic-arrow-right" />
                            <span>{transfer.toName}</span>
                            <span className="trip-transfer-amount">
                              {formatMoney(transfer.amountMinor)}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  {detail && detail.id === trip.id && (
                    <>
                      <div className="trip-code-box">
                        <span className="trip-code">{detail.joinCode}</span>
                        <span className="trip-code-note">
                          Read this out, or show the QR from the phone app, to add someone. They see
                          what was spent on this trip and nothing else of yours.
                        </span>
                        <button
                          className="btn btn-sm btn-ghost"
                          disabled={busy}
                          onClick={() =>
                            run(
                              () => api.post<{ joinCode: string }>(`/trips/${trip.id}/rotate-code`),
                              () => {
                                setDetail(null);
                                setNotice("New code. The old one no longer works.");
                              }
                            )
                          }
                        >
                          New code
                        </button>
                      </div>

                      <div className="trip-people">
                        {detail.members.map((member) => (
                          <div className="trip-person" key={member.userId}>
                            <span>{member.name ?? "Someone"}</span>
                            {member.isOwner ? (
                              <span className="field-hint">Started it</span>
                            ) : (
                              <button
                                className="btn btn-sm btn-ghost btn-danger-text"
                                disabled={busy}
                                onClick={() =>
                                  run(
                                    () => api.delete(`/trips/${trip.id}/members/${member.userId}`),
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
                    </>
                  )}

                  <div className="trip-actions">
                    <button
                      className="btn btn-sm btn-ghost"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => api.post<{ claimedCount: number }>(`/trips/${trip.id}/rescan`),
                          (result) =>
                            setNotice(
                              result.claimedCount === 0
                                ? "Nothing else from those dates to add."
                                : `Added ${result.claimedCount} more.`
                            )
                        )
                      }
                    >
                      <Icon name="ic-sync" /> Re-scan those dates
                    </button>
                    <span className="modal-actions-spacer" />
                    <button
                      className="btn btn-sm btn-ghost btn-danger-text"
                      disabled={busy}
                      onClick={() => run(() => api.delete(`/trips/${trip.id}`))}
                    >
                      Delete trip
                    </button>
                  </div>
                  <p className="field-hint">
                    Deleting a trip keeps every payment — only the label goes.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
