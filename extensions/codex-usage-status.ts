import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type UsageWindow = {
	used_percent?: number | null;
};

type RateLimitBucket = {
	allowed?: boolean;
	limit_reached?: boolean;
	primary_window?: UsageWindow | null;
};

type CodexUsageResponse = {
	rate_limit?: RateLimitBucket | null;
	additional_rate_limits?: Record<string, unknown> | unknown[] | null;
};

type UsageSnapshot = {
	fiveHourLeftPercent: number | null;
};

const EXTENSION_ID = "codex-usage";

const agentDirFromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
const AGENT_DIR = agentDirFromEnv ? agentDirFromEnv : path.join(os.homedir(), ".pi", "agent");
const AUTH_FILE = path.join(AGENT_DIR, "auth.json");

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_INTERVAL_MS = 60_000;

const CODEX_LABEL = "codex";
const CODEX_SPARK_LABEL = "codex spark";
const SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const SPARK_LIMIT_NAME = "GPT-5.3-Codex-Spark";
const MISSING_AUTH_ERROR_PREFIX = "Missing openai-codex OAuth access/accountId";

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function usedToLeftPercent(value: number | null | undefined): number | null {
	if (typeof value !== "number" || Number.isNaN(value)) return null;
	return clampPercent(100 - value);
}

function formatLeftPercent(valueLeft: number | null): string {
	if (typeof valueLeft !== "number" || Number.isNaN(valueLeft)) {
		return "-- left";
	}

	return `${Math.round(clampPercent(valueLeft))}% left`;
}

function isSparkModel(modelId: string | undefined): boolean {
	return modelId === SPARK_MODEL_ID;
}

function getStatusLabel(modelId: string | undefined): string {
	return isSparkModel(modelId) ? CODEX_SPARK_LABEL : CODEX_LABEL;
}

function formatStatus(ctx: ExtensionContext, usage: UsageSnapshot, modelId: string | undefined): string {
	const text = `${getStatusLabel(modelId)} ${formatLeftPercent(usage.fiveHourLeftPercent)}`;
	return ctx.ui.theme.fg("dim", text);
}

async function loadAuthCredentials(): Promise<{ accessToken: string; accountId: string }> {
	const authRaw = await fs.readFile(AUTH_FILE, "utf8");
	const auth = JSON.parse(authRaw) as Record<
		string,
		| {
				type?: string;
				access?: string | null;
				accountId?: string | null;
				account_id?: string | null;
		  }
		| undefined
	>;

	const codexEntry = auth["openai-codex"];
	const authEntry = codexEntry?.type === "oauth" ? codexEntry : undefined;

	const accessToken = authEntry?.access?.trim();
	const accountId = (authEntry?.accountId ?? authEntry?.account_id)?.trim();

	if (!accessToken || !accountId) {
		throw new Error(`${MISSING_AUTH_ERROR_PREFIX} in ${AUTH_FILE}`);
	}

	return { accessToken, accountId };
}

async function requestUsageJson(): Promise<CodexUsageResponse> {
	const credentials = await loadAuthCredentials();
	const response = await fetch(USAGE_URL, {
		headers: {
			accept: "*/*",
			authorization: `Bearer ${credentials.accessToken}`,
			"chatgpt-account-id": credentials.accountId,
		},
	});

	if (!response.ok) throw new Error(`Codex usage request failed (${response.status}) for ${USAGE_URL}`);
	return (await response.json()) as CodexUsageResponse;
}

function asObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function normalizeRateLimitBucket(value: unknown): RateLimitBucket | null {
	const record = asObject(value);
	if (!record) return null;
	if (!("primary_window" in record || "limit_reached" in record || "allowed" in record)) {
		return null;
	}
	return record as RateLimitBucket;
}

function extractSparkRateLimitFromEntry(value: unknown): RateLimitBucket | null {
	const record = asObject(value);
	if (!record) return null;
	if (typeof record.limit_name !== "string" || record.limit_name.trim() !== SPARK_LIMIT_NAME) return null;
	return normalizeRateLimitBucket(record.rate_limit);
}

function findSparkRateLimitBucket(data: CodexUsageResponse): RateLimitBucket | null {
	const additional = data.additional_rate_limits;
	if (Array.isArray(additional)) {
		for (const entry of additional) {
			const bucket = extractSparkRateLimitFromEntry(entry);
			if (bucket) return bucket;
		}
	} else {
		const additionalMap = asObject(additional);
		if (additionalMap) {
			for (const value of Object.values(additionalMap)) {
				const bucket = extractSparkRateLimitFromEntry(value);
				if (bucket) return bucket;
			}
		}
	}

	return null;
}

function selectRateLimitBucket(data: CodexUsageResponse, modelId: string | undefined): RateLimitBucket | null {
	if (isSparkModel(modelId)) {
		return findSparkRateLimitBucket(data);
	}
	return normalizeRateLimitBucket(data.rate_limit);
}

function parseUsageSnapshot(data: CodexUsageResponse, modelId: string | undefined): UsageSnapshot {
	const selectedBucket = selectRateLimitBucket(data, modelId);
	const fiveHourWindow = selectedBucket?.primary_window;
	const fiveHourValue = fiveHourWindow?.used_percent;

	return {
		fiveHourLeftPercent: usedToLeftPercent(fiveHourValue),
	};
}

function isMissingCodexAuthError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error.message.includes(MISSING_AUTH_ERROR_PREFIX)) return true;

	const errorWithCode = error as Error & { code?: string };
	return errorWithCode.code === "ENOENT" && error.message.includes(AUTH_FILE);
}

function createStatusRefresher() {
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let activeContext: ExtensionContext | undefined;
	let isRefreshInFlight = false;
	let queuedRefresh: { ctx: ExtensionContext; modelId: string | undefined } | null = null;

	async function updateFooterStatus(ctx: ExtensionContext, modelId = ctx.model?.id): Promise<void> {
		if (!ctx.hasUI) return;
		if (isRefreshInFlight) {
			queuedRefresh = { ctx, modelId };
			return;
		}
		isRefreshInFlight = true;
		try {
			const usage = parseUsageSnapshot(await requestUsageJson(), modelId);
			ctx.ui.setStatus(EXTENSION_ID, formatStatus(ctx, usage, modelId));
		} catch (error) {
			if (isMissingCodexAuthError(error)) {
				ctx.ui.setStatus(EXTENSION_ID, undefined);
				return;
			}

			const theme = ctx.ui.theme;
			const unavailableStatus = `${getStatusLabel(modelId)} unavailable`;
			ctx.ui.setStatus(EXTENSION_ID, theme.fg("warning", unavailableStatus));
		} finally {
			isRefreshInFlight = false;
			if (queuedRefresh) {
				const nextRefresh = queuedRefresh;
				queuedRefresh = null;
				void updateFooterStatus(nextRefresh.ctx, nextRefresh.modelId);
			}
		}
	}

	function refreshFor(ctx: ExtensionContext, modelId = ctx.model?.id): Promise<void> {
		activeContext = ctx;
		return updateFooterStatus(ctx, modelId);
	}

	function startAutoRefresh(): void {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			if (!activeContext) return;
			void updateFooterStatus(activeContext);
		}, REFRESH_INTERVAL_MS);
		refreshTimer.unref?.();
	}

	function stopAutoRefresh(ctx?: ExtensionContext): void {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
		ctx?.ui.setStatus(EXTENSION_ID, undefined);
	}

	async function setLoadingStatus(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;

		try {
			await loadAuthCredentials();
		} catch (error) {
			if (isMissingCodexAuthError(error)) {
				ctx.ui.setStatus(EXTENSION_ID, undefined);
				return;
			}
		}

		const loadingStatus = `${getStatusLabel(ctx.model?.id)} loading...`;
		ctx.ui.setStatus(EXTENSION_ID, ctx.ui.theme.fg("dim", loadingStatus));
	}

	return {
		refreshFor,
		startAutoRefresh,
		stopAutoRefresh,
		setLoadingStatus,
	};
}

export default function (pi: ExtensionAPI) {
	const refresher = createStatusRefresher();

	pi.on("session_start", (_event, ctx) => {
		refresher.startAutoRefresh();
		void (async () => {
			await refresher.setLoadingStatus(ctx);
			await refresher.refreshFor(ctx);
		})();
	});

	pi.on("turn_end", (_event, ctx) => {
		void refresher.refreshFor(ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		void refresher.refreshFor(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		void refresher.refreshFor(ctx, event.model.id);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		refresher.stopAutoRefresh(ctx);
	});
}
