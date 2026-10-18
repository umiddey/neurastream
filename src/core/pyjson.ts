export class PyFloat {
	constructor(public value: number) {}
}

function pyString(s: string): string {
	let out = '"';
	for (const ch of s) {
		const c = ch.codePointAt(0)!;
		if (ch === '"') out += '\\"';
		else if (ch === "\\") out += "\\\\";
		else if (ch === "\b") out += "\\b";
		else if (ch === "\f") out += "\\f";
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\t") out += "\\t";
		else if (c < 0x20 || c > 0x7e) {
			if (c > 0xffff) {
				const u = c - 0x10000;
				const hi = 0xd800 + (u >> 10);
				const lo = 0xdc00 + (u & 0x3ff);
				out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
			} else {
				out += `\\u${c.toString(16).padStart(4, "0")}`;
			}
		} else out += ch;
	}
	return `${out}"`;
}

function pyNumber(n: number, asFloat: boolean): string {
	if (!Number.isFinite(n)) return "NaN";
	if (Object.is(n, -0)) return asFloat ? "-0.0" : "0";
	if (Number.isInteger(n) && Math.abs(n) < 1e15) return asFloat ? `${n}.0` : String(n);
	let s = JSON.stringify(n);
	s = s.replace(/e([+-]?)(\d+)$/, (_m, sign: string, d: string) => {
		const sg = sign === "-" ? "-" : "+";
		return `e${sg}${d.padStart(2, "0")}`;
	});
	if (asFloat && !s.includes(".") && !s.includes("e")) s += ".0";
	return s;
}

export function pyDumps(v: unknown): string {
	if (v === null || v === undefined) return "null";
	if (typeof v === "boolean") return v ? "true" : "false";
	if (typeof v === "number") return pyNumber(v, false);
	if (v instanceof PyFloat) return pyNumber(v.value, true);
	if (typeof v === "string") return pyString(v);
	if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
	if (typeof v === "object") {
		const parts = Object.keys(v as object).map(k => `${pyString(k)}: ${pyDumps((v as Record<string, unknown>)[k])}`);
		return `{${parts.join(", ")}}`;
	}
	return "null";
}

/** Python dict repr for a string->int map (agent-ledger provider counts). */
export function pyDictInt(obj: Record<string, number>): string {
	const parts = Object.entries(obj).map(([k, n]) => `'${k}': ${n}`);
	return `{${parts.join(", ")}}`;
}
