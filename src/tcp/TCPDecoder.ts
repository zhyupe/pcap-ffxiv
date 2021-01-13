import { TCP_HEADER_SIZE } from "../constants";
import { TcpFrame } from "./tcp-frame";
import { EventEmitter } from "events";
import { decoders } from "cap";
import { roundToNextPowerOf2 } from "../memory";

/**
 * Big props to ravahn for his help,
 * this is based on Machina's TCPDecoder implementation:
 * https://github.com/ravahn/machina/blob/master/Machina/TCPDecoder.cs
 */
const SYN_FLAG = 2;
const PSH_FLAG = 8;

export class TCPDecoder extends EventEmitter {

	constructor() {
		super();
	}

	private queue: TcpFrame[] = [];

	private lastPacketTimestamp = 0;

	private nextSequence = 0;

	public filterAndStoreData(data: Buffer): void {
		if (data.length < TCP_HEADER_SIZE) {
			console.error(`TCP data is smaller than header size, shouldn't happen.`);
			return;
		}

		const frame: TcpFrame = this.parseFrame(data);

		// TODO filter based on source and destination port?
		if (data.length === frame.dataOffset && (frame.flags & SYN_FLAG) === 0) {
			// It's probably just an ACK packet, ignore it.
			return;
		}

		this.queue.push(frame);
		this.processData();
	}

	private parseFrame(data: Buffer): TcpFrame {
		const tcp = decoders.TCP(data);
		return {
			source: tcp.info.srcport,
			destination: tcp.info.dstport,
			sequence: tcp.info.seqno,
			acknowledgment: tcp.info.ackno,
			dataOffset: tcp.offset,
			flags: tcp.info.flags,
			window: tcp.info.window,
			checksum: tcp.info.checksum,
			urgentPointer: tcp.info.urgentptr,
			options: tcp.info.options,
			data: data.slice(tcp.offset),
			raw: data.slice(),
		};
	}

	private processData(): void {

		let buffer: Buffer = Buffer.alloc(0);

		let frames: TcpFrame[];
		if (this.queue.length === 0) {
			frames = this.queue;
		} else {
			frames = this.queue.sort((a, b) => a.sequence - b.sequence);
		}

		for (const frame of frames) {
			if (this.nextSequence === 0) {
				this.nextSequence = frame.sequence;
			}

			if (frame.sequence <= this.nextSequence) {
				this.lastPacketTimestamp = Date.now();

				if ((frame.flags & SYN_FLAG) > 0) {
					if (this.nextSequence === 0 || this.nextSequence === frame.sequence) {
						this.nextSequence = frame.sequence + 1;
					} else if (Math.abs(this.nextSequence - frame.sequence) > 100000) {
						console.log(`Updating sequence number from SYN packet. Current Sequence: ${this.nextSequence}, sent sequence: ${frame.sequence}.`);
						this.nextSequence = frame.sequence + 1;
					} else {
						console.log(`Ignoring SYN packet new sequence number. Current Sequence: ${this.nextSequence}, sent sequence: ${frame.sequence}.`);
					}
					continue;
				}

				let frameOffset = 0;
				if (frame.sequence < this.nextSequence) {
					frameOffset = this.nextSequence - frame.sequence;
				}

				if (frameOffset >= frame.raw.length - frame.dataOffset) {
					console.log(`Packet data already processed, expected sequence ${this.nextSequence}, received ${frame.sequence}, size ${frame.raw.length - frame.dataOffset}.`);
					continue;
				}

				if (buffer.length === 0) {
					buffer = Buffer.alloc(roundToNextPowerOf2(frame.raw.length - frame.dataOffset - frameOffset));
					frame.raw.copy(buffer, 0, frame.dataOffset + frameOffset, frame.raw.length - frame.dataOffset - frameOffset);
				} else {
					let oldSize = buffer.length;
					const newBuffer = Buffer.alloc(roundToNextPowerOf2(buffer.length + (frame.raw.length - frame.dataOffset - frameOffset)));
					buffer.copy(newBuffer);
					frame.raw.copy(newBuffer, oldSize, frame.dataOffset + frameOffset, frame.raw.length - frame.dataOffset - frameOffset);
				}

				this.nextSequence = frame.sequence + frame.raw.length - frame.dataOffset;

				// If PUSH flag, return data now.
				if ((frame.flags & PSH_FLAG) > 0) {
					break;
				}
			} else if (frame.sequence > this.nextSequence) {
				break;
			}
		}

		this.queue = this.queue.filter(frame => {
			return frame.sequence >= this.nextSequence;
		});

		if (this.queue.length > 0) {
			if ((this.lastPacketTimestamp + 2000) < Date.now()) {
				console.log(">2 sec since last processed packet, resetting stream.");
				this.queue = this.queue.filter(frame => {
					console.log(`Missing Sequence #${this.nextSequence}, Dropping packet with sequence #${frame.sequence}`);
				});
			}
		}

		if (buffer.length > 0) {
			this.emit("frame", this.parseFrame(buffer));
		}
	}
}
