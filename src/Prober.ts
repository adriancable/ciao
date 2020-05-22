import dnsPacket, { DecodedAnswerRecord, DecodedDnsPacket, Type } from "@homebridge/dns-packet";
import assert from "assert";
import createDebug from "debug";
import { CiaoService } from "./CiaoService";
import { EndpointInfo, MDNSServer } from "./MDNSServer";
import dnsEqual from "./util/dns-equal";
import * as tiebreaking from "./util/tiebreaking";
import { rrComparator, TiebreakingResult } from "./util/tiebreaking";
import Timeout = NodeJS.Timeout;

const PROBE_INTERVAL = 250; // 250ms as defined in RFC 6762 8.1.
const debug = createDebug("ciao:Prober");

/**
 * This class is used to execute the probing process for a given service as defined
 * in RFC 6762 8.1.
 * This ensure that the we advertise the service under a unique name.
 * It also provides a conflict resolution algorithm if multiple clients probing
 * for the same name are detected.
 */
export class Prober {

  private readonly server: MDNSServer;
  private readonly service: CiaoService;

  private records: DecodedAnswerRecord[] = [];

  private startTime?: number;

  private timer?: Timeout;
  private promiseResolve?: (value?: void | PromiseLike<void>) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private promiseReject?: (reason?: any) => void;

  private sentFirstProbeQuery = false; // we MUST ignore responses received BEFORE the first probe is sent
  private sentQueries = 0;

  constructor(server: MDNSServer, service: CiaoService) {
    assert(server, "server must be defined");
    assert(service, "service must be defined");
    this.server = server;
    this.service = service;
  }

  /**
   * This method is called to start the actual probing process.
   * Once the service is considered unique on the network and can be announced the promise returns.
   * While probing multiple name changes can happen
   *
   * @returns a promise which returns when the service is considered unique on the network
   */
  public async probe(): Promise<void> {
    /*
     * Probing is basically the following process: We send three "probe" queries to check
     * if the desired service name is already on the network.
     * The request are sent with a delay of 250ms between them and the first
     * request starting with a random delay.
     * If we don't receive any response to our requests we consider the probing to be successful
     * and continue with announcing our service.
     */

    debug("Starting to probe for '%s'...", this.service.getFQDN());

    this.startTime = new Date().getTime(); // save the time we started at. After a minute without success we must give up.

    return new Promise((resolve, reject) => {
      this.promiseResolve = resolve;
      this.promiseReject = reject;

      this.timer = setTimeout(this.sendProbeRequest.bind(this), Math.random() * PROBE_INTERVAL);
      this.timer.unref();
    });
  }

  /**
   * End the current ongoing probing requests. If
   * @param success
   */
  private endProbing(success: boolean): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    // reset all values to default (so the Prober can be reused if it wasn't successful)
    this.sentFirstProbeQuery = false;
    this.sentQueries = 0;

    if (success) {
      debug("Probing for '%s' finished successfully", this.service.getFQDN());
      this.promiseResolve!();
      // TODO do we maybe also reject the promise if the socket encounters an error?
    }
  }

  private sendProbeRequest(): void {
    if (this.sentQueries === 0) { // this is the first query sent, init some stuff
      // we encode and decode the records so we get the rawData representation of our records which we need for the tiebreaking algorithm
      this.records = dnsPacket.decode(dnsPacket.encode({
        answers: [
          this.service.srvRecord(), this.service.txtRecord(),
          this.service.ptrRecord(), ...this.service.subtypePtrRecords(),
          ...this.service.allAddressRecords(),
        ],
      })).answers.sort(rrComparator); // we sort them fir the tiebreaking algorithm
    }

    if (this.sentQueries >= 3) {
      // we sent three requests and it seems like we weren't canceled, so we have a success right here
      this.endProbing(true);
      return;
    }

    const timeSinceProbingStart = new Date().getTime() - this.startTime!;
    if (timeSinceProbingStart > 60000) { // max probing time is 1 minute
      debug("Probing for '%s' took longer than 1 minute. Giving up...", this.service.getFQDN());
      this.endProbing(false);
      this.promiseReject!("timeout");
      return;
    }

    debug("Sending prober query number %d for '%s'...", this.sentQueries + 1, this.service.getFQDN());

    // TODO evaluate that if the user decides to cancel advertising probing is properly cancelled

    assert(this.records.length > 0, "Tried sending probing request for zero record length!");

    this.server.sendQuery({
      questions: [
        {
          name: this.service.getFQDN(),
          type: Type.ANY,
          flag_qu: true, // probes SHOULD be send with unicast response flag as of the RFC
        },
        {
          name: this.service.getHostname(),
          type: Type.ANY,
          flag_qu: true, // probes SHOULD be send with unicast response flag as of the RFC
        },
      ],
      authorities: this.records, // include records we want to announce in authorities to support Simultaneous Probe Tiebreaking (RFC 6762 8.2.)
    }, () => {
      this.sentFirstProbeQuery = true;
      this.sentQueries++;

      this.timer = setTimeout(this.sendProbeRequest.bind(this), PROBE_INTERVAL);
      this.timer.unref();
    });
  }

  handleResponse(packet: DecodedDnsPacket): void {
    if (!this.sentFirstProbeQuery) {
      return;
    }

    let containsAnswer = false;
    // search answers and additionals for answers to our probe queries
    packet.answers.forEach(record => {
      if (dnsEqual(record.name, this.service.getFQDN()) || dnsEqual(record.name, this.service.getHostname())) {
        containsAnswer = true;
      }
    });
    packet.additionals.forEach(record => {
      if (dnsEqual(record.name, this.service.getFQDN()) || dnsEqual(record.name, this.service.getHostname())) {
        containsAnswer = true;
      }
    });

    if (containsAnswer) { // abort and cancel probes
      debug("Probing for '%s' failed. Doing a name change", this.service.getFQDN());

      this.endProbing(false); // reset the prober

      this.service.incrementName(); // TODO inform user of name/hostname change when probing finish. The name MUST be persisted!
      this.sendProbeRequest(); // start probing again with the new name
    }
  }

  handleQuery(packet: DecodedDnsPacket): void {
    if (!this.sentFirstProbeQuery) { // ignore queries if we are not sending
      return;
    }

    // if we are currently probing and receiving a query which is also a probing query
    // which matches the desired name we run the tiebreaking algorithm to decide on the winner
    let needsTiebreaking = false;
    packet.questions.forEach(question => {
      if (dnsEqual(question.name, this.service.getFQDN()) || dnsEqual(question.name, this.service.getHostname())) {
        needsTiebreaking = true;
      }
    });


    if (needsTiebreaking) {
      this.doTiebreaking(packet);
    }
  }

  private doTiebreaking(packet: DecodedDnsPacket): void {
    if (!this.sentFirstProbeQuery) { // ignore queries if we are not sending
      return;
    }

    // first of all check if the contents of authorities answers our query
    let conflict = packet.authorities.length === 0;
    packet.authorities.forEach(record => {
      if (dnsEqual(record.name, this.service.getFQDN()) || dnsEqual(record.name, this.service.getHostname())) {
        conflict = true;
      }
    });
    if (!conflict) {
      return;
    }
    // now run the actual tiebreaking algorithm to decide the winner

    // tiebreaking is actually run pretty often, as we always receive our own packets

    // first of all build our own records
    const answers = this.records; // already sorted
    const opponent = packet.authorities.sort(tiebreaking.rrComparator);

    const result = tiebreaking.runTiebreaking(answers, opponent);

    if (result === TiebreakingResult.HOST) {
      debug("'%s' won the tiebreak. We gonna ignore the other probing request!", this.service.getFQDN());
    } else if (result === TiebreakingResult.OPPONENT) {
      debug("'%s' lost the tiebreak. We are waiting a second and try to probe again...", this.service.getFQDN());

      this.endProbing(false); // cancel the current probing

      // wait 1 second and probe again (this is to guard against stale probe packets)
      // If it wasn't a stale probe packet, the other host will correctly respond to our probe queries by then
      this.timer = setTimeout(this.sendProbeRequest.bind(this), 1000); // TODO check if prober was not shut down
      this.timer.unref();
    } else {
      //debug("Tiebreaking for '%s' detected exact same records on the network. There is actually no conflict!", this.service.getFQDN());
    }
  }

}
