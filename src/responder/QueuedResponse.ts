/**
 * Represents a delay response packet which is going to be sent over multicast.
 */
import { DNSPacket } from "../coder/DNSPacket";
import { InterfaceName } from "../NetworkManager";
import Timeout = NodeJS.Timeout;

export class QueuedResponse {

  private static readonly MAX_DELAY = 500; // 500 ms

  private readonly packet: DNSPacket;
  private readonly interfaceName: InterfaceName;

  private timeOfCreation = new Date().getTime(); // epoch time millis
  estimatedTimeToBeSent = 0; // epoch time millis
  private delay = -1;
  private timer?: Timeout;

  delayed?: boolean; // indicates that this object is invalid, got delayed (combined with another object)

  constructor(packet: DNSPacket, interfaceName: InterfaceName) {
    this.packet = packet;
    this.interfaceName = interfaceName;
  }

  public getPacket(): DNSPacket {
    return this.packet;
  }

  /**
   * This method returns the total delay of the represented dns response packet.
   * If this QueuedResponse consists of already combined packets
   * (meaning other packets already got delayed in order to be sent out with this packet),
   * the totalDelay will represent the maximum delay of any contained packet.
   *
   * @returns The total delay.
   */
  public getTotalDelay(): number {
    return new Date().getTime() - this.timeOfCreation;
  }

  public calculateRandomDelay(): void {
    this.delay = Math.random() * 100 + 20; // delay of 20ms - 120ms
    this.estimatedTimeToBeSent = new Date().getTime() + this.delay;
  }

  public scheduleResponse(callback: () => void): void {
    this.timer = setTimeout(callback, this.delay);
    this.timer.unref(); // timer doesn't prevent termination
  }

  public delayWouldBeInTimelyManner(next: QueuedResponse): boolean {
    const delay = next.estimatedTimeToBeSent - this.timeOfCreation;
    return delay <= QueuedResponse.MAX_DELAY;
  }

  /**
   * Combines this queue response packet with the {@code next} queued response packet if those can be combined.
   * Packets can be combined if the {@code udpPayloadSize} allows for it AND if the current packet
   * won't be delayed more than 500 ms from it's time of creation.
   *
   * @param next - A queued response which is schedule AFTER the current queued response.
   * @param udpPayloadSize - The desired maximum udp payload size. If not specified the MTU will be used to calculate it.
   * @returns {@code true} will be returned if the queued response was combined with the specified {@code next} response.
   */
  public combineWithNextPacketIfPossible(next: QueuedResponse, udpPayloadSize?: number): boolean {
    // below check, which is commented out would be necessary, current implementation will check that
    // with function above, thus there is no need to check again.
    /*
    if (!this.delayWouldBeInTimelyManner(next)) {
      return false;
    }
    */
    if (this.interfaceName !== next.interfaceName) {
      // can't combine packets which get sent via different interfaces
      return false;
    }
    if (!next.packet.canBeCombinedWith(this.packet, udpPayloadSize)) {
      console.log("Packets could not be combined because of size!");
      // packets can't be combined
      return false;
    }

    next.packet.combineWith(this.packet);
    next.timeOfCreation = Math.min(this.timeOfCreation, next.timeOfCreation);

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.delayed = true;

    return true;
  }

}
