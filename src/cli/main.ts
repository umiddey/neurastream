#!/usr/bin/env bun
import { basename } from "node:path";
import { run } from "./dispatch.ts";

const invoked = basename(process.argv[1] ?? "neurastream");
const asSelf = invoked === "main.ts" || invoked === "neurastream";
const cmd = asSelf ? (process.argv[2] ?? "help") : invoked;
const args = asSelf ? process.argv.slice(3) : process.argv.slice(2);
process.exit(await run(cmd, args));
