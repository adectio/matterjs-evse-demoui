/**
 * Time Synchronization server acting as a trusted time source
 *
 * Serves the host clock (NTP-synced) as UTCTime so nodes with the TimeSyncClient feature can be pointed at this
 * endpoint via SetTrustedTimeSource.
 */

import { Seconds, Time, Timer } from "@matter/main";
import { TimeSynchronizationServer } from "@matter/node/behaviors";
import { TimeSynchronization } from "@matter/main/clusters";
import { Status, StatusResponseError } from "@matter/main/types";

/** Current time in Unix-epoch microseconds; matter.js converts to the Matter epoch on the wire */
function nowUs() {
  return BigInt(Time.nowMs) * 1000n;
}

export class TimeSourceServer extends TimeSynchronizationServer {
  declare internal: TimeSourceServer.Internal;

  override initialize() {
    this.state.utcTime = nowUs();
    this.state.granularity = TimeSynchronization.Granularity.MillisecondsGranularity;
    this.state.timeSource = TimeSynchronization.TimeSource.NonMatterSntp;

    // UTCTime has the C (changes omitted) quality, so ticking it does not push reports to subscribers
    this.internal.tickTimer = Time.getPeriodicTimer(
      "Time source UTCTime update",
      Seconds.one,
      this.callback(this.#tick, { lock: true }),
    ).start();
  }

  override async [Symbol.asyncDispose]() {
    this.internal.tickTimer?.stop();
    await super[Symbol.asyncDispose]?.();
  }

  /** The host clock is NTP-synced and authoritative, so admin-supplied time is declined */
  override setUtcTime() {
    throw new StatusResponseError(
      "Time is sourced from the host's NTP-synced clock",
      Status.Failure,
      TimeSynchronization.StatusCode.TimeNotAccepted,
    );
  }

  #tick() {
    this.state.utcTime = nowUs();
  }
}

export namespace TimeSourceServer {
  export class Internal {
    tickTimer?: Timer;
  }
}
