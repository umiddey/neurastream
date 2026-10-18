function roundDigits(intDigits: string, fracDigits: string, prec: number): string {
	const need = prec;
	const keep = fracDigits.slice(0, need);
	const rest = fracDigits.slice(need);
	const intArr = intDigits.split("").map(Number);
	const fracArr = (keep + "0".repeat(need)).slice(0, need).split("").map(Number);
	const first = rest[0] ? Number(rest[0]) : 0;
	const more = rest.slice(1).split("").some(c => c !== "0");
	let roundUp = false;
	if (first > 5 || (first === 5 && more)) roundUp = true;
	else if (first === 5 && !more) {
		const last = need > 0 ? fracArr[need - 1]! : intArr[intArr.length - 1]!;
		roundUp = last % 2 === 1;
	}
	if (roundUp) {
		let carry = 1;
		for (let i = need - 1; i >= 0 && carry; i--) {
			const s = fracArr[i]! + carry;
			fracArr[i] = s % 10;
			carry = s >= 10 ? 1 : 0;
		}
		for (let i = intArr.length - 1; i >= 0 && carry; i--) {
			const s = intArr[i]! + carry;
			intArr[i] = s % 10;
			carry = s >= 10 ? 1 : 0;
		}
		if (carry) intArr.unshift(1);
	}
	const intStr = intArr.join("").replace(/^0+(?=\d)/, "") || "0";
	return need === 0 ? intStr : `${intStr}.${fracArr.join("")}`;
}

/** Python format(n, f".{prec}f") without width. */
export function pyFixed(n: number, prec: number): string {
	if (!Number.isFinite(n)) return "nan";
	const neg = n < 0;
	const abs = Math.abs(n);
	if (abs === 0) {
		const z = prec === 0 ? "0" : `0.${"0".repeat(prec)}`;
		return neg ? `-${z}` : z;
	}
	const exp = abs.toExponential(20);
	const [mant, eStr] = exp.split("e");
	const expn = Number(eStr);
	const digs = (mant ?? "").replace(".", "");
	let intDigits: string;
	let fracDigits: string;
	if (expn >= 0) {
		const all = digs.padEnd(expn + 1, "0");
		intDigits = all.slice(0, expn + 1);
		fracDigits = all.slice(expn + 1);
	} else {
		intDigits = "0";
		fracDigits = "0".repeat(-expn - 1) + digs;
	}
	const body = roundDigits(intDigits, fracDigits, prec);
	return neg ? `-${body}` : body;
}

export function pyFixedWidth(n: number, prec: number, width: number): string {
	return pyFixed(n, prec).padStart(width, " ");
}

/** Python format(n, ".0%") */
export function pyPercent0(v: number): string {
	return `${pyFixed(v * 100, 0)}%`;
}

/** Python format(n, "g") for the magnitudes these commands print. */
export function formatG(n: number): string {
	if (!Number.isFinite(n)) return "nan";
	if (n === 0) return "0";
	const abs = Math.abs(n);
	const [mant, eStr] = abs.toExponential(16).split("e");
	const expn = Number(eStr);
	const digs = (mant ?? "").replace(".", "");
	const sig = 6;
	const first = digs.slice(0, sig);
	const rest = digs.slice(sig);
	const next = rest[0] ? Number(rest[0]) : 0;
	const more = rest.slice(1).split("").some(c => c !== "0");
	const arr = first.split("").map(Number);
	let roundUp = false;
	if (next > 5 || (next === 5 && more)) roundUp = true;
	else if (next === 5 && !more) roundUp = (arr[arr.length - 1] ?? 0) % 2 === 1;
	if (roundUp) {
		let carry = 1;
		for (let i = arr.length - 1; i >= 0 && carry; i--) {
			const s = arr[i]! + carry;
			arr[i] = s % 10;
			carry = s >= 10 ? 1 : 0;
		}
		if (carry) arr.unshift(1);
	}
	let expUse = expn;
	let digits = arr.join("");
	if (digits.length > sig) {
		digits = digits.slice(0, sig);
		expUse += 1;
	}
	digits = digits.replace(/0+$/, "") || "0";
	const neg = n < 0 ? "-" : "";
	if (expUse >= -4 && expUse < 6) {
		if (expUse >= 0) {
			const intPart = digits.slice(0, expUse + 1).padEnd(expUse + 1, "0");
			const frac = digits.slice(expUse + 1);
			return neg + (frac ? `${intPart}.${frac}` : intPart);
		}
		return `${neg}0.${"0".repeat(-expUse - 1)}${digits}`;
	}
	const m = digits[0] + (digits.length > 1 ? `.${digits.slice(1)}` : "");
	const e = expUse >= 0 ? `+${String(expUse).padStart(2, "0")}` : `-${String(-expUse).padStart(2, "0")}`;
	return `${neg}${m}e${e}`;
}

/** str(float(n)) as Python prints it inside an f-string. */
export function pyFloatStr(n: number): string {
	if (Number.isInteger(n)) return `${n}.0`;
	return String(n);
}
