import { expect, test } from "bun:test";
import { terminalLine } from "../src/core/main-start.ts";

test("terminalLine names the terminal from TERM_PROGRAM, version and session type", () => {
	expect(terminalLine({ TERM: "dumb", TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.4.0", XDG_SESSION_TYPE: "wayland" })).toBe("terminal: ghostty 1.4.0, wayland");
});

test("terminalLine falls back to terminal-specific variables, then to unknown", () => {
	expect(terminalLine({ WT_SESSION: "abc" })).toBe("terminal: windows-terminal");
	expect(terminalLine({ ALACRITTY_SOCKET: "/run/x" })).toBe("terminal: alacritty");
	expect(terminalLine({ KITTY_WINDOW_ID: "1" })).toBe("terminal: kitty");
	expect(terminalLine({ TERM: "dumb" })).toBe("terminal: unknown");
});
