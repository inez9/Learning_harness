"use client";
import { useEffect, useState } from "react";
import { notifySettingsSaved } from "@/components/settings-signal";
import { ConnectionRow } from "./connection-controls";

/** Claude Code row (claude-code provider): read-only — the `claude` CLI
 *  already holds the claude.ai sign-in, so there is nothing to connect
 *  here. Detection is server-side (`claude auth status`, surfaced as the
 *  provider's keyPresent in GET /api/models). */
export function ClaudeCodeConnection() {
	const [state, setState] = useState<"checking" | "ready" | "missing">("checking");
	async function check(recheck = false) {
		const was = state;
		setState("checking");
		try {
			const body = await (await fetch("/api/models")).json() as { providers?: { id: string; keyPresent: boolean }[] };
			const ready = body.providers?.some((p) => p.id === "claude-code" && p.keyPresent) === true;
			setState(ready ? "ready" : "missing");
			// a manual recheck that newly finds it refreshes the model pickers
			if (recheck && ready && was !== "ready") notifySettingsSaved("keys");
		} catch { setState("missing"); }
	}
	useEffect(() => { void check(); }, []);
	return <div data-testid="claude-code-connection">
		<ConnectionRow label="Claude Code" action="Recheck" disabled={state === "checking"} onAction={() => void check(true)} testid="claude-code-row">
			<span className="font-ui text-[11px] text-muted-foreground">
				{state === "checking" ? "Checking…" : state === "ready" ? "Signed in · uses your Claude subscription" : "Not found — install Claude Code, run `claude`, then /login"}
			</span>
		</ConnectionRow>
	</div>;
}
