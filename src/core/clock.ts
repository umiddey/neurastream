// Wall clock. Tests pin NEURASTREAM_NOW (unix seconds) so output matches a frozen original.

export function nowSec(): number {
	const raw = process.env.NEURASTREAM_NOW;
	if (raw !== undefined && raw !== "") {
		const n = Number(raw);
		if (Number.isFinite(n)) return n;
	}
	return Date.now() / 1000;
}

export function strftime(epoch: number, fmt: string): string {
	const d = new Date(epoch * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	const tokens: Record<string, string> = {
		"%Y": String(d.getFullYear()),
		"%m": p(d.getMonth() + 1),
		"%d": p(d.getDate()),
		"%H": p(d.getHours()),
		"%M": p(d.getMinutes()),
	};
	return fmt.replace(/%[YmdHM]/g, tok => tokens[tok] ?? tok);
}
