import { EventPlay4 } from "../definitions";
import { eventPlayN } from "./eventPlayN";

export function eventPlay4(buf: Buffer): EventPlay4 {
	return {
		...eventPlayN(buf),
		params: Array.from(new Uint32Array(buf.slice(0x24, 0x24 + 4 * 4))),
	};
}
